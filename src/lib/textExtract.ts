import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist';
import type { TextItem } from 'pdfjs-dist/types/src/display/api';

export interface FormatOptions {
  /** Re-join words that were hyphenated across a line break ("exam-\nple"). */
  dehyphenate: boolean;
  /** Insert blank lines between paragraphs based on vertical spacing. */
  paragraphDetection: boolean;
}

export const DEFAULT_FORMAT_OPTIONS: FormatOptions = {
  dehyphenate: true,
  paragraphDetection: true,
};

/** One reconstructed line of text with its vertical position on the page. */
export interface PageLine {
  /** PDF y-coordinate of the baseline (larger = higher up the page). */
  y: number;
  height: number;
  text: string;
}

/** A paragraph: consecutive lines not separated by a large vertical gap. */
export interface Paragraph {
  /** y of the paragraph's top line — used to order it against images. */
  topY: number;
  lines: string[];
}

function isTextItem(item: unknown): item is TextItem {
  return !!item && typeof (item as TextItem).str === 'string';
}

/**
 * Reconstruct a page's lines from raw glyph runs.
 *
 * PDF positions glyph runs at (x, y) coordinates with no notion of lines. We
 * group runs that share a baseline, order them, and insert spaces where there's
 * a horizontal gap.
 */
export async function getPageLines(page: PDFPageProxy): Promise<PageLine[]> {
  const content = await page.getTextContent();

  interface Piece {
    x: number;
    endX: number;
    str: string;
  }
  interface WorkingLine {
    y: number;
    height: number;
    pieces: Piece[];
  }

  const lines: WorkingLine[] = [];

  for (const item of content.items) {
    if (!isTextItem(item)) continue;
    if (item.str === '') continue;
    const tr = item.transform as number[]; // [a, b, c, d, e, f]
    const x = tr[4];
    const y = tr[5];
    const height = item.height || Math.hypot(tr[1], tr[3]) || 10;
    const width = item.width || 0;

    let line: WorkingLine | undefined;
    const tol = Math.max(height, 4) * 0.5;
    for (let k = lines.length - 1; k >= 0 && k >= lines.length - 6; k--) {
      if (Math.abs(lines[k].y - y) <= tol) {
        line = lines[k];
        break;
      }
    }
    if (!line) {
      line = { y, height, pieces: [] };
      lines.push(line);
    } else {
      line.height = Math.max(line.height, height);
    }
    line.pieces.push({ x, endX: x + width, str: item.str });
  }

  lines.sort((a, b) => b.y - a.y); // top to bottom

  const result: PageLine[] = [];
  for (const line of lines) {
    line.pieces.sort((a, b) => a.x - b.x);
    const spaceW = Math.max(line.height * 0.25, 1);
    let s = '';
    let prevEnd: number | null = null;
    for (const piece of line.pieces) {
      if (prevEnd !== null) {
        const gap = piece.x - prevEnd;
        if (gap > spaceW && !s.endsWith(' ') && !piece.str.startsWith(' ')) {
          s += gap > spaceW * 6 ? '    ' : ' ';
        }
      }
      s += piece.str;
      prevEnd = piece.endX;
    }
    const text = s.replace(/[ \t]+$/g, '');
    if (text.trim() !== '') {
      result.push({ y: line.y, height: line.height, text });
    }
  }
  return result;
}

/** Group ordered lines into paragraphs using vertical spacing. */
export function groupParagraphs(
  lines: PageLine[],
  paragraphDetection: boolean,
): Paragraph[] {
  const paras: Paragraph[] = [];
  let prevY: number | null = null;
  let prevH = 0;
  for (const line of lines) {
    const startNew =
      prevY === null ||
      (paragraphDetection && prevY - line.y > prevH * 1.7);
    if (startNew) {
      paras.push({ topY: line.y, lines: [line.text] });
    } else {
      paras[paras.length - 1].lines.push(line.text);
    }
    prevY = line.y;
    prevH = line.height;
  }
  return paras;
}

/** "exam-\nple" -> "example" (only when the next line starts lowercase). */
export function dehyphenateText(text: string): string {
  return text.replace(/([\p{L}])-\n(\p{Ll})/gu, '$1$2');
}

/** Collapse a paragraph's wrapped lines into a single reflowed string. */
export function reflowParagraph(para: Paragraph, dehyphenate: boolean): string {
  let t = para.lines.join('\n');
  if (dehyphenate) t = dehyphenateText(t);
  return t.replace(/\n/g, ' ').replace(/\s{2,}/g, ' ').trim();
}

/** Extract a page's text as a single formatted string (txt/md path). */
export async function extractPageText(
  page: PDFPageProxy,
  opts: FormatOptions,
): Promise<string> {
  const lines = await getPageLines(page);
  const paras = groupParagraphs(lines, opts.paragraphDetection);
  let out = paras.map((p) => p.lines.join('\n')).join('\n\n');
  if (opts.dehyphenate) out = dehyphenateText(out);
  return out.trim();
}

export interface ExtractProgress {
  page: number;
  total: number;
}

/** Extract every page, reporting progress and yielding to the UI between pages. */
export async function extractAllPages(
  doc: PDFDocumentProxy,
  opts: FormatOptions,
  onProgress: (p: ExtractProgress) => void,
  signal?: AbortSignal,
): Promise<string[]> {
  const total = doc.numPages;
  const pages: string[] = [];
  for (let p = 1; p <= total; p++) {
    if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
    const page = await doc.getPage(p);
    try {
      pages.push(await extractPageText(page, opts));
    } finally {
      page.cleanup();
    }
    onProgress({ page: p, total });
  }
  return pages;
}
