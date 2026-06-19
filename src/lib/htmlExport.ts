import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist';
import { pdfjsLib } from './pdf';
import {
  getPageLines,
  groupParagraphs,
  reflowParagraph,
  type FormatOptions,
} from './textExtract';
import { getPageImage, imageToCanvas, type PdfImage } from './imageExtract';

export interface HtmlExportOptions {
  format: FormatOptions;
  includeImages: boolean;
  /** Longest image side in px; larger images are downscaled to keep size sane. */
  maxImageDim: number;
  /** JPEG quality for embedded images (0–1). */
  imageQuality: number;
  title: string;
}

export const DEFAULT_HTML_OPTIONS: Omit<HtmlExportOptions, 'title'> = {
  format: { dehyphenate: true, paragraphDetection: true },
  includeImages: true,
  maxImageDim: 2000,
  imageQuality: 0.82,
};

export interface HtmlProgress {
  page: number;
  total: number;
}

// --- 2D affine matrix tracking (to locate where each image sits) ---------

type Matrix = [number, number, number, number, number, number];
const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

/** Compose two PDF transform matrices (matches PDF.js's Util.transform). */
function compose(m: Matrix, t: Matrix): Matrix {
  return [
    m[0] * t[0] + m[2] * t[1],
    m[1] * t[0] + m[3] * t[1],
    m[0] * t[2] + m[2] * t[3],
    m[1] * t[2] + m[3] * t[3],
    m[0] * t[4] + m[2] * t[5] + m[4],
    m[1] * t[4] + m[3] * t[5] + m[5],
  ];
}

/** Top edge (max y) of the unit square painted under matrix m — for ordering. */
function imageTopY(m: Matrix): number {
  return Math.max(m[5], m[1] + m[5], m[3] + m[5], m[1] + m[3] + m[5]);
}

// --- Page blocks (text + images) in reading order ------------------------

interface TextBlock {
  type: 'text';
  topY: number;
  text: string;
}
interface ImageBlock {
  type: 'image';
  topY: number;
  dataUrl: string;
  width: number;
  height: number;
}
type Block = TextBlock | ImageBlock;

interface Placement {
  name?: string;
  inline?: PdfImage;
  topY: number;
}

function renderImageToDataUrl(
  img: PdfImage,
  maxDim: number,
  quality: number,
): { url: string; width: number; height: number } | null {
  const native = imageToCanvas(img);
  if (!native) return null;
  const w0 = native.width;
  const h0 = native.height;
  if (w0 < 8 || h0 < 8) return null; // skip spacer/hairline images

  const scale = Math.min(1, maxDim / Math.max(w0, h0));
  const w = Math.max(1, Math.round(w0 * scale));
  const h = Math.max(1, Math.round(h0 * scale));

  // Flatten onto white (JPEG has no alpha) and downscale if needed.
  const out = document.createElement('canvas');
  out.width = w;
  out.height = h;
  const ctx = out.getContext('2d');
  if (!ctx) return null;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(native, 0, 0, w, h);

  return { url: out.toDataURL('image/jpeg', quality), width: w, height: h };
}

async function extractPageBlocks(
  page: PDFPageProxy,
  opts: HtmlExportOptions,
): Promise<Block[]> {
  const blocks: Block[] = [];

  // Text paragraphs.
  const lines = await getPageLines(page);
  for (const para of groupParagraphs(lines, opts.format.paragraphDetection)) {
    const text = reflowParagraph(para, opts.format.dehyphenate);
    if (text) blocks.push({ type: 'text', topY: para.topY, text });
  }

  // Images, located by walking the operator list and tracking the matrix.
  if (opts.includeImages) {
    const { OPS } = pdfjsLib;
    const ops = await page.getOperatorList();
    let ctm: Matrix = IDENTITY;
    const stack: Matrix[] = [];
    const placements: Placement[] = [];

    for (let i = 0; i < ops.fnArray.length; i++) {
      const fn = ops.fnArray[i];
      const args = ops.argsArray[i];
      switch (fn) {
        case OPS.save:
          stack.push(ctm);
          break;
        case OPS.restore:
          ctm = stack.pop() ?? IDENTITY;
          break;
        case OPS.transform:
          ctm = compose(ctm, args as Matrix);
          break;
        case OPS.paintFormXObjectBegin:
          stack.push(ctm);
          if (Array.isArray(args[0])) ctm = compose(ctm, args[0] as Matrix);
          break;
        case OPS.paintFormXObjectEnd:
          ctm = stack.pop() ?? IDENTITY;
          break;
        case OPS.paintImageXObject:
        case OPS.paintImageXObjectRepeat:
          if (typeof args[0] === 'string') {
            placements.push({ name: args[0], topY: imageTopY(ctm) });
          }
          break;
        case OPS.paintInlineImageXObject:
          if (args[0]) {
            placements.push({ inline: args[0] as PdfImage, topY: imageTopY(ctm) });
          }
          break;
        default:
          break;
      }
    }

    for (const pl of placements) {
      const img = pl.inline ?? (await getPageImage(page, pl.name!));
      if (!img) continue;
      const rendered = renderImageToDataUrl(
        img,
        opts.maxImageDim,
        opts.imageQuality,
      );
      if (!rendered) continue;
      blocks.push({
        type: 'image',
        topY: pl.topY,
        dataUrl: rendered.url,
        width: rendered.width,
        height: rendered.height,
      });
    }
  }

  // Reading order: top of the page first.
  blocks.sort((a, b) => b.topY - a.topY);
  return blocks;
}

// --- HTML assembly -------------------------------------------------------

function esc(s: string): string {
  return s.replace(
    /[&<>"]/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!,
  );
}

function htmlHeader(title: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>
  :root { color-scheme: light; }
  body { max-width: 820px; margin: 0 auto; padding: 32px 20px 80px;
    font-family: Georgia, 'Times New Roman', serif; font-size: 18px;
    line-height: 1.6; color: #1a1a1a; }
  h1 { font-family: system-ui, sans-serif; font-size: 1.5rem; }
  p { margin: 0 0 1em; }
  figure { margin: 1.2em 0; text-align: center; }
  img { max-width: 100%; height: auto; }
  .page-sep { font-family: system-ui, sans-serif; font-size: 0.8rem;
    color: #999; text-align: center; text-transform: uppercase;
    letter-spacing: 0.08em; margin: 2.5em 0 1.5em; border-top: 1px solid #e2e2e2;
    padding-top: 0.8em; }
</style>
</head>
<body>
<h1>${esc(title)}</h1>
`;
}

function htmlFooter(): string {
  return '\n</body>\n</html>\n';
}

function pageHtml(pageNum: number, blocks: Block[]): string {
  let s = `<div class="page-sep">Page ${pageNum}</div>\n`;
  for (const block of blocks) {
    if (block.type === 'text') {
      s += `<p>${esc(block.text)}</p>\n`;
    } else {
      s +=
        `<figure><img loading="lazy" width="${block.width}" height="${block.height}" ` +
        `src="${block.dataUrl}" alt="Image on page ${pageNum}"></figure>\n`;
    }
  }
  return s;
}

/** Sink that receives HTML in chunks (a file stream or an in-memory buffer). */
export type ChunkWriter = (chunk: string) => Promise<void> | void;

/**
 * Build a single self-contained HTML document with every page's text and
 * images interleaved in reading order. Chunks are handed to `write` as each
 * page completes, so the whole document never has to live in memory at once.
 */
export async function exportToHtml(
  doc: PDFDocumentProxy,
  options: HtmlExportOptions,
  write: ChunkWriter,
  onProgress: (p: HtmlProgress) => void,
  signal?: AbortSignal,
): Promise<void> {
  await write(htmlHeader(options.title));
  const total = doc.numPages;
  for (let p = 1; p <= total; p++) {
    if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
    const page = await doc.getPage(p);
    try {
      const blocks = await extractPageBlocks(page, options);
      await write(pageHtml(p, blocks));
    } finally {
      page.cleanup();
    }
    onProgress({ page: p, total });
  }
  await write(htmlFooter());
}
