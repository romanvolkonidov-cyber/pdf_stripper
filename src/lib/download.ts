import { zip } from 'fflate';
import type { ExtractedImage } from './imageExtract';

/** Trigger a browser download for an in-memory blob/string. */
export function downloadBlob(data: BlobPart, filename: string, type: string): void {
  const blob = data instanceof Blob ? data : new Blob([data], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export function downloadText(text: string, filename: string): void {
  downloadBlob(text, filename, 'text/plain;charset=utf-8');
}

/** Bundle extracted images into a .zip and download it. */
export async function downloadImagesZip(
  images: ExtractedImage[],
  filename: string,
): Promise<void> {
  const entries: Record<string, Uint8Array> = {};
  for (const img of images) {
    entries[img.name] = new Uint8Array(await img.blob.arrayBuffer());
  }
  const data = await new Promise<Uint8Array>((resolve, reject) => {
    // level: 0 — PNGs are already compressed, so just store them (fast).
    zip(entries, { level: 0 }, (err, out) => (err ? reject(err) : resolve(out)));
  });
  downloadBlob(data as BlobPart, filename, 'application/zip');
}

/** Strip the extension from a filename, e.g. "report.pdf" -> "report". */
export function baseName(filename: string): string {
  return filename.replace(/\.[^./\\]+$/, '') || filename;
}

/** A streaming destination for text chunks. */
export interface FileSink {
  write: (chunk: string) => Promise<void>;
  close: () => Promise<void>;
  abort: () => Promise<void>;
}

interface WritableLike {
  write: (data: string) => Promise<void>;
  close: () => Promise<void>;
  abort?: () => Promise<void>;
}
interface SaveFilePickerWindow {
  showSaveFilePicker?: (opts: {
    suggestedName?: string;
    types?: { description?: string; accept: Record<string, string[]> }[];
  }) => Promise<{ createWritable: () => Promise<WritableLike> }>;
}

/** True when the browser can stream a download straight to disk. */
export function canStreamToDisk(): boolean {
  return typeof (window as SaveFilePickerWindow).showSaveFilePicker === 'function';
}

/**
 * Open a destination for a (potentially huge) HTML file.
 *
 * Prefers the File System Access API so the document streams to disk and never
 * has to fit in memory — essential for hundreds of image-heavy pages. Returns
 * `null` if the user cancels the save dialog. Falls back to buffering + a
 * regular download when the API isn't available.
 */
export async function openHtmlFileSink(
  suggestedName: string,
): Promise<FileSink | null> {
  const picker = (window as SaveFilePickerWindow).showSaveFilePicker;
  if (picker) {
    let handle;
    try {
      handle = await picker({
        suggestedName,
        types: [
          { description: 'Web page', accept: { 'text/html': ['.html'] } },
        ],
      });
    } catch (err) {
      if ((err as DOMException)?.name === 'AbortError') return null; // cancelled
      throw err;
    }
    const writable = await handle.createWritable();
    return {
      write: (c) => writable.write(c),
      close: () => writable.close(),
      abort: async () => {
        try {
          await writable.abort?.();
        } catch {
          /* ignore */
        }
      },
    };
  }

  // Fallback: accumulate, then download in one go.
  const parts: string[] = [];
  return {
    write: async (c) => {
      parts.push(c);
    },
    close: async () => {
      downloadBlob(parts.join(''), suggestedName, 'text/html;charset=utf-8');
    },
    abort: async () => {
      parts.length = 0;
    },
  };
}
