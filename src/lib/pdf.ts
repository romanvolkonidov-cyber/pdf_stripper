import * as pdfjsLib from 'pdfjs-dist';
import type { PDFDocumentProxy } from 'pdfjs-dist';
// `?url` makes Vite emit the already-bundled worker as a static asset and hand
// us its final URL — this works in `vite dev` and in the production build.
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;

// Character maps (for CJK / exotic encodings) and the standard PDF fonts are
// loaded on demand from a CDN, pinned to the exact version we ship. Note: only
// these generic resources are fetched — the user's PDF is read locally and is
// never uploaded anywhere.
const CDN_BASE = `https://cdn.jsdelivr.net/npm/pdfjs-dist@${pdfjsLib.version}`;
const CMAP_URL = `${CDN_BASE}/cmaps/`;
const STANDARD_FONTS_URL = `${CDN_BASE}/standard_fonts/`;

export interface LoadedPdf {
  doc: PDFDocumentProxy;
  /** Object URL backing the document — revoke it when you're done. */
  objectUrl: string;
}

/**
 * Open a local File as a PDF document.
 *
 * We hand PDF.js an object-URL rather than the raw bytes. Browsers serve object
 * URLs with HTTP range support, so PDF.js streams the file in ~1 MB chunks
 * instead of pulling the whole thing into memory at once. Combined with
 * `disableAutoFetch`, this is what lets us open multi-hundred-MB PDFs.
 */
export async function loadPdf(file: File): Promise<LoadedPdf> {
  const objectUrl = URL.createObjectURL(file);
  try {
    const task = pdfjsLib.getDocument({
      url: objectUrl,
      // Stream on demand instead of downloading the entire file up front.
      disableAutoFetch: true,
      disableStream: false,
      rangeChunkSize: 1 << 20, // 1 MB
      cMapUrl: CMAP_URL,
      cMapPacked: true,
      standardFontDataUrl: STANDARD_FONTS_URL,
    });
    const doc = await task.promise;
    return { doc, objectUrl };
  } catch (err) {
    URL.revokeObjectURL(objectUrl);
    throw err;
  }
}

export { pdfjsLib };
