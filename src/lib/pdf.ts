import * as pdfjsLib from 'pdfjs-dist';
import type { PDFDocumentProxy, PDFDocumentLoadingTask } from 'pdfjs-dist';
// `?url` makes Vite emit the already-bundled worker as a static asset and hand
// us its final URL — this works in `vite dev` and in the production build.
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;

// Character maps (for CJK / exotic encodings) and the standard PDF fonts are
// loaded on demand from a CDN, pinned to the exact version we ship. Note: only
// these generic resources are fetched — the user's PDF is read locally and is
// never uploaded anywhere.
const CDN_BASE = `https://cdn.jsdelivr.net/npm/pdfjs-dist@${pdfjsLib.version}`;
const COMMON_PARAMS = {
  cMapUrl: `${CDN_BASE}/cmaps/`,
  cMapPacked: true,
  standardFontDataUrl: `${CDN_BASE}/standard_fonts/`,
} as const;

export interface LoadedPdf {
  doc: PDFDocumentProxy;
  /** Object URL backing the document (revoke when done), or null if loaded from memory. */
  objectUrl: string | null;
}

export function isPasswordError(err: unknown): boolean {
  return (err as { name?: string })?.name === 'PasswordException';
}

/** Wire up an interactive password prompt for encrypted PDFs. */
function withPasswordPrompt(task: PDFDocumentLoadingTask): void {
  task.onPassword = (updatePassword: (pw: string) => void, reason: number) => {
    const wrong = reason === pdfjsLib.PasswordResponses.INCORRECT_PASSWORD;
    const pw = window.prompt(
      wrong
        ? 'That password was incorrect. Please try again:'
        : 'This PDF is password-protected. Enter its password:',
    );
    if (pw === null) {
      task.destroy(); // user cancelled -> the load promise rejects
      return;
    }
    updatePassword(pw);
  };
}

/**
 * Open a local File as a PDF document.
 *
 * Strategy 1 (memory-light): hand PDF.js an object URL. Browsers serve object
 * URLs with HTTP range support, so PDF.js streams the file in ~1 MB chunks
 * rather than loading the whole thing — this is what makes 800 MB PDFs viable.
 *
 * Strategy 2 (fallback, most compatible): if streaming fails for any reason
 * (some browsers/proxies don't honor ranges on blob URLs), read the file fully
 * into memory and parse that. Slower/heavier, but it just works.
 */
export async function loadPdf(file: File): Promise<LoadedPdf> {
  // --- Strategy 1: stream from an object URL ---
  const objectUrl = URL.createObjectURL(file);
  try {
    const task = pdfjsLib.getDocument({
      url: objectUrl,
      disableAutoFetch: true,
      rangeChunkSize: 1 << 20, // 1 MB
      ...COMMON_PARAMS,
    });
    withPasswordPrompt(task);
    const doc = await task.promise;
    return { doc, objectUrl };
  } catch (streamErr) {
    URL.revokeObjectURL(objectUrl);
    // A password the user actively cancelled shouldn't trigger a retry.
    if (isPasswordError(streamErr)) throw streamErr;
    console.warn('[pdf] streaming load failed, retrying in memory:', streamErr);
  }

  // --- Strategy 2: load the entire file into memory ---
  const data = new Uint8Array(await file.arrayBuffer());
  const task = pdfjsLib.getDocument({ data, ...COMMON_PARAMS });
  withPasswordPrompt(task);
  const doc = await task.promise;
  return { doc, objectUrl: null };
}

export { pdfjsLib };
