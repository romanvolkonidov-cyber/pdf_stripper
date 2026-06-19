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

interface Piece {
  x: number;
  endX: number;
  str: string;
}

interface Line {
  y: number;
  height: number;
  pieces: Piece[];
  text: string;
}

function isTextItem(item: unknown): item is TextItem {
  return !!item && typeof (item as TextItem).str === 'string';
}

/**
 * Turn one page's raw text items into readable, layout-aware text.
 *
 * PDF has no concept of "lines" or "paragraphs" — it only positions glyph runs
 * at (x, y) coordinates. We reconstruct structure from those positions:
 *   1. group runs that share a baseline into lines,
 *   2. order lines top-to-bottom and runs left-to-right,
 *   3. insert spaces where there's a horizontal gap,
 *   4. insert blank lines where there's a vertical gap (paragraph breaks).
 */
export async function extractPageText(
  page: PDFPageProxy,
  opts: FormatOptions,
): Promise<string> {
  const content = await page.getTextContent();
  const lines: Line[] = [];

  for (const item of content.items) {
    if (!isTextItem(item)) continue; // skip marked-content markers
    const tr = item.transform as number[]; // [a, b, c, d, e, f]
    const x = tr[4];
    const y = tr[5];
    const height = item.height || Math.hypot(tr[1], tr[3]) || 10;
    const width = item.width || 0;

    if (item.str === '') {
      // An empty item with hasEOL still tells us a line ended.
      continue;
    }

    // Find a recent line sharing roughly the same baseline. Searching only the
    // last few lines keeps this near-linear even on dense pages.
    let line: Line | undefined;
    const tol = Math.max(height, 4) * 0.5;
    for (let k = lines.length - 1; k >= 0 && k >= lines.length - 6; k--) {
      if (Math.abs(lines[k].y - y) <= tol) {
        line = lines[k];
        break;
      }
    }
    if (!line) {
      line = { y, height, pieces: [], text: '' };
      lines.push(line);
    } else {
      line.height = Math.max(line.height, height);
    }
    line.pieces.push({ x, endX: x + width, str: item.str });
  }

  // PDF y-axis points up, so larger y means higher on the page.
  lines.sort((a, b) => b.y - a.y);

  for (const line of lines) {
    line.pieces.sort((a, b) => a.x - b.x);
    const spaceW = Math.max(line.height * 0.25, 1);
    let s = '';
    let prevEnd: number | null = null;
    for (const piece of line.pieces) {
      if (prevEnd !== null) {
        const gap = piece.x - prevEnd;
        const needsSpace =
          gap > spaceW && !s.endsWith(' ') && !piece.str.startsWith(' ');
        if (needsSpace) {
          // A very wide gap (think table columns) gets a few spaces so the
          // visual separation survives; ordinary word gaps get one.
          s += gap > spaceW * 6 ? '    ' : ' ';
        }
      }
      s += piece.str;
      prevEnd = piece.endX;
    }
    line.text = s.replace(/[ \t]+$/g, '');
  }

  let out = '';
  let prevY: number | null = null;
  let prevH = 0;
  for (const line of lines) {
    if (line.text.trim() === '') continue;
    if (prevY !== null) {
      const gap = prevY - line.y;
      if (opts.paragraphDetection && gap > prevH * 1.7) {
        out += '\n\n';
      } else {
        out += '\n';
      }
    }
    out += line.text;
    prevY = line.y;
    prevH = line.height;
  }

  if (opts.dehyphenate) {
    // "exam-\nple" -> "example" (only when the next line starts lowercase, to
    // avoid eating real hyphens like "well-\nKnown" proper nouns).
    out = out.replace(/([\p{L}])-\n(\p{Ll})/gu, '$1$2');
  }

  return out.trim();
}

export interface ExtractProgress {
  page: number;
  total: number;
}

/**
 * Extract every page, reporting progress and yielding to the UI between pages.
 * Returns one string per page so the caller can format (txt / md, page markers)
 * without re-parsing.
 */
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
      // Free the page's parsed content so memory stays flat across a big doc.
      page.cleanup();
    }
    onProgress({ page: p, total });
  }
  return pages;
}
