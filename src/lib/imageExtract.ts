import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist';
import { pdfjsLib } from './pdf';

/** A decoded image as PDF.js hands it to us. Shape varies by source. */
export interface PdfImage {
  width: number;
  height: number;
  kind?: number;
  data?: Uint8Array | Uint8ClampedArray;
  bitmap?: ImageBitmap;
}

export interface ExtractedImage {
  name: string;
  blob: Blob;
  width: number;
  height: number;
}

export interface ImageProgress {
  page: number;
  total: number;
  found: number;
}

const { OPS, ImageKind } = pdfjsLib;

/** Resolve an image object from the page, with a timeout so we never hang. */
export function getPageImage(
  page: PDFPageProxy,
  name: string,
): Promise<PdfImage | null> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v: PdfImage | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(v);
    };
    const timer = setTimeout(() => done(null), 20000);
    try {
      // The callback form waits until the worker has finished decoding.
      page.objs.get(name, (img: PdfImage) => done(img ?? null));
    } catch {
      done(null);
    }
  });
}

/** Paint a decoded image onto a canvas and return it, or null if unsupported. */
export function imageToCanvas(img: PdfImage): HTMLCanvasElement | null {
  const { width: w, height: h } = img;
  if (!w || !h) return null;

  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;

  if (img.bitmap) {
    ctx.drawImage(img.bitmap, 0, 0);
    return canvas;
  }

  const src = img.data;
  if (!src) return null;

  const imageData = ctx.createImageData(w, h);
  const dst = imageData.data;

  if (img.kind === ImageKind.RGBA_32BPP) {
    dst.set(src.subarray(0, dst.length));
  } else if (img.kind === ImageKind.RGB_24BPP) {
    for (let i = 0, j = 0; j < dst.length; i += 3, j += 4) {
      dst[j] = src[i];
      dst[j + 1] = src[i + 1];
      dst[j + 2] = src[i + 2];
      dst[j + 3] = 255;
    }
  } else if (img.kind === ImageKind.GRAYSCALE_1BPP) {
    // 1 bit per pixel, MSB first, each row padded to a byte boundary.
    const rowBytes = (w + 7) >> 3;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const bit = (src[y * rowBytes + (x >> 3)] >> (7 - (x & 7))) & 1;
        const v = bit ? 255 : 0;
        const j = (y * w + x) * 4;
        dst[j] = dst[j + 1] = dst[j + 2] = v;
        dst[j + 3] = 255;
      }
    }
  } else if (src.length >= w * h) {
    // Fallback: treat as 8-bit grayscale.
    for (let i = 0, j = 0; j < dst.length; i++, j += 4) {
      dst[j] = dst[j + 1] = dst[j + 2] = src[i];
      dst[j + 3] = 255;
    }
  } else {
    return null;
  }

  ctx.putImageData(imageData, 0, 0);
  return canvas;
}

function canvasToBlob(canvas: HTMLCanvasElement): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob((b) => resolve(b), 'image/png'));
}

/** Op codes that reference a named image XObject in args[0]. */
const NAMED_IMAGE_OPS = new Set<number>([
  OPS.paintImageXObject,
  OPS.paintImageXObjectRepeat,
]);

/**
 * Pull embedded raster images out of a page range and return them as PNG blobs.
 *
 * Repeated images (e.g. a logo on every page) are de-duplicated by a cheap
 * signature so an 800-page document doesn't yield 800 identical logos.
 */
export async function extractImages(
  doc: PDFDocumentProxy,
  pageStart: number,
  pageEnd: number,
  onProgress: (p: ImageProgress) => void,
  signal?: AbortSignal,
): Promise<ExtractedImage[]> {
  const results: ExtractedImage[] = [];
  const seen = new Set<string>();

  for (let p = pageStart; p <= pageEnd; p++) {
    if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');

    const page = await doc.getPage(p);
    try {
      const ops = await page.getOperatorList();
      const candidates: PdfImage[] = [];
      const names = new Set<string>();

      for (let i = 0; i < ops.fnArray.length; i++) {
        const fn = ops.fnArray[i];
        const args = ops.argsArray[i];
        if (NAMED_IMAGE_OPS.has(fn) && typeof args[0] === 'string') {
          names.add(args[0]);
        } else if (fn === OPS.paintInlineImageXObject && args[0]) {
          candidates.push(args[0] as PdfImage);
        }
      }

      for (const name of names) {
        const img = await getPageImage(page, name);
        if (img) candidates.push(img);
      }

      let idxOnPage = 0;
      for (const img of candidates) {
        idxOnPage++;
        const sig = `${img.width}x${img.height}:${img.data?.length ?? 'b'}`;
        if (seen.has(sig)) continue;
        seen.add(sig);

        const canvas = imageToCanvas(img);
        if (!canvas) continue;
        const blob = await canvasToBlob(canvas);
        if (!blob) continue;

        results.push({
          name: `page-${String(p).padStart(4, '0')}_img-${idxOnPage}.png`,
          blob,
          width: img.width,
          height: img.height,
        });
      }
    } catch {
      // Skip pages whose operator list can't be parsed.
    } finally {
      page.cleanup();
    }

    onProgress({ page: p, total: pageEnd, found: results.length });
  }

  return results;
}
