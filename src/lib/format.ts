export type OutputFormat = 'txt' | 'md';

export interface AssembleOptions {
  /** Insert a marker between pages so you can see where each page begins. */
  pageMarkers: boolean;
}

/**
 * Join per-page text into a single document in the requested format.
 * Kept separate from extraction so switching txt/md or toggling page markers
 * is instant and doesn't re-parse the PDF.
 */
export function assemble(
  pages: string[],
  format: OutputFormat,
  opts: AssembleOptions,
): string {
  const blocks = pages.map((text, i) => {
    const n = i + 1;
    if (!opts.pageMarkers) return text;
    return format === 'md'
      ? `## Page ${n}\n\n${text}`
      : `──────── Page ${n} ────────\n\n${text}`;
  });

  const sep = format === 'md' && opts.pageMarkers ? '\n\n---\n\n' : '\n\n';
  return blocks
    .join(sep)
    .replace(/\n{4,}/g, '\n\n\n')
    .trim();
}

export interface DocStats {
  characters: number;
  words: number;
  pagesWithText: number;
}

export function computeStats(pages: string[]): DocStats {
  let characters = 0;
  let words = 0;
  let pagesWithText = 0;
  for (const p of pages) {
    characters += p.length;
    const trimmed = p.trim();
    if (trimmed) {
      pagesWithText++;
      words += trimmed.split(/\s+/).length;
    }
  }
  return { characters, words, pagesWithText };
}
