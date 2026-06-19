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
