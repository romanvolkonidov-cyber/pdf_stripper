import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { Dropzone } from './components/Dropzone';
import { loadPdf } from './lib/pdf';
import {
  extractAllPages,
  DEFAULT_FORMAT_OPTIONS,
  type FormatOptions,
} from './lib/textExtract';
import { extractImages, type ExtractedImage } from './lib/imageExtract';
import { assemble, computeStats, type OutputFormat } from './lib/format';
import {
  baseName,
  downloadImagesZip,
  downloadText,
} from './lib/download';
import { formatBytes, formatDuration, formatNumber } from './lib/util';

type Phase = 'idle' | 'opening' | 'ready' | 'extracting' | 'done' | 'error';

const PREVIEW_LIMIT = 20000;

interface DocMeta {
  name: string;
  size: number;
  numPages: number;
}

export default function App() {
  const docRef = useRef<PDFDocumentProxy | null>(null);
  const urlRef = useRef<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const startRef = useRef<number>(0);

  const [phase, setPhase] = useState<Phase>('idle');
  const [meta, setMeta] = useState<DocMeta | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [formatOpts, setFormatOpts] = useState<FormatOptions>(
    DEFAULT_FORMAT_OPTIONS,
  );
  const [outputFormat, setOutputFormat] = useState<OutputFormat>('txt');
  const [pageMarkers, setPageMarkers] = useState(true);

  const [pages, setPages] = useState<string[] | null>(null);
  const [progress, setProgress] = useState({ page: 0, total: 0 });
  const [elapsed, setElapsed] = useState(0);

  // Image extraction state
  const [imgRange, setImgRange] = useState({ start: 1, end: 1 });
  const [imgBusy, setImgBusy] = useState(false);
  const [imgProgress, setImgProgress] = useState({ page: 0, total: 0, found: 0 });
  const [images, setImages] = useState<ExtractedImage[] | null>(null);
  const imgAbortRef = useRef<AbortController | null>(null);

  const cleanupDoc = useCallback(() => {
    abortRef.current?.abort();
    imgAbortRef.current?.abort();
    // Aborts network requests and tears down the worker.
    docRef.current?.loadingTask.destroy().catch(() => {});
    docRef.current = null;
    if (urlRef.current) {
      URL.revokeObjectURL(urlRef.current);
      urlRef.current = null;
    }
  }, []);

  // Revoke object URL / tear down the worker when the page unloads.
  useEffect(() => cleanupDoc, [cleanupDoc]);

  const reset = useCallback(() => {
    cleanupDoc();
    setPhase('idle');
    setMeta(null);
    setError(null);
    setPages(null);
    setImages(null);
    setProgress({ page: 0, total: 0 });
    setImgProgress({ page: 0, total: 0, found: 0 });
  }, [cleanupDoc]);

  const handleFile = useCallback(
    async (file: File) => {
      cleanupDoc();
      setPages(null);
      setImages(null);
      setError(null);
      setPhase('opening');
      try {
        const { doc, objectUrl } = await loadPdf(file);
        docRef.current = doc;
        urlRef.current = objectUrl;
        setMeta({ name: file.name, size: file.size, numPages: doc.numPages });
        setImgRange({ start: 1, end: Math.min(doc.numPages, 20) });
        setPhase('ready');
      } catch (err) {
        console.error(err);
        setError(
          'Could not open this PDF. It may be corrupted, password-protected, or not a real PDF.',
        );
        setPhase('error');
      }
    },
    [cleanupDoc],
  );

  const runExtraction = useCallback(async () => {
    const doc = docRef.current;
    if (!doc) return;
    const controller = new AbortController();
    abortRef.current = controller;
    startRef.current = performance.now();
    setElapsed(0);
    setPages(null);
    setProgress({ page: 0, total: doc.numPages });
    setPhase('extracting');
    try {
      const result = await extractAllPages(
        doc,
        formatOpts,
        (p) => {
          setProgress(p);
          setElapsed(performance.now() - startRef.current);
        },
        controller.signal,
      );
      setPages(result);
      setElapsed(performance.now() - startRef.current);
      setPhase('done');
    } catch (err) {
      if ((err as DOMException)?.name === 'AbortError') {
        setPhase('ready');
      } else {
        console.error(err);
        setError('Something went wrong while extracting text from this PDF.');
        setPhase('error');
      }
    } finally {
      abortRef.current = null;
    }
  }, [formatOpts]);

  const cancel = useCallback(() => abortRef.current?.abort(), []);

  const assembled = useMemo(() => {
    if (!pages) return '';
    return assemble(pages, outputFormat, { pageMarkers });
  }, [pages, outputFormat, pageMarkers]);

  const stats = useMemo(() => (pages ? computeStats(pages) : null), [pages]);

  const downloadResult = useCallback(() => {
    if (!assembled || !meta) return;
    downloadText(assembled, `${baseName(meta.name)}.${outputFormat}`);
  }, [assembled, meta, outputFormat]);

  const copyResult = useCallback(async () => {
    if (!assembled) return;
    try {
      await navigator.clipboard.writeText(assembled);
    } catch {
      /* clipboard may be blocked; download is always available */
    }
  }, [assembled]);

  const runImageExtraction = useCallback(async () => {
    const doc = docRef.current;
    if (!doc) return;
    const start = Math.max(1, Math.min(imgRange.start, doc.numPages));
    const end = Math.max(start, Math.min(imgRange.end, doc.numPages));
    const controller = new AbortController();
    imgAbortRef.current = controller;
    setImages(null);
    setImgBusy(true);
    setImgProgress({ page: start, total: end, found: 0 });
    try {
      const found = await extractImages(
        doc,
        start,
        end,
        setImgProgress,
        controller.signal,
      );
      setImages(found);
    } catch (err) {
      if ((err as DOMException)?.name !== 'AbortError') console.error(err);
    } finally {
      setImgBusy(false);
      imgAbortRef.current = null;
    }
  }, [imgRange]);

  const downloadImages = useCallback(() => {
    if (!images?.length || !meta) return;
    downloadImagesZip(images, `${baseName(meta.name)}-images.zip`).catch(
      (e) => console.error(e),
    );
  }, [images, meta]);

  const pct =
    progress.total > 0 ? Math.round((progress.page / progress.total) * 100) : 0;
  const eta =
    progress.page > 0 && elapsed > 0
      ? (elapsed / progress.page) * (progress.total - progress.page)
      : 0;

  return (
    <div className="app">
      <header className="hero">
        <h1>
          PDF <span className="hero__accent">Stripper</span>
        </h1>
        <p className="hero__tagline">
          Pull clean, well-formatted text (and images) out of any PDF — even
          huge ones — without uploading a thing.
        </p>
      </header>

      <main className="card">
        {phase === 'idle' && (
          <Dropzone onFile={handleFile} disabled={false} />
        )}

        {phase === 'opening' && (
          <div className="status">
            <div className="spinner" />
            <p>Opening PDF…</p>
          </div>
        )}

        {phase === 'error' && (
          <div className="status">
            <p className="error-text">{error}</p>
            <button className="btn" onClick={reset}>
              Try another PDF
            </button>
          </div>
        )}

        {meta && phase !== 'opening' && phase !== 'idle' && (
          <div className="filebar">
            <div className="filebar__info">
              <span className="filebar__name" title={meta.name}>
                {meta.name}
              </span>
              <span className="filebar__meta">
                {formatBytes(meta.size)} · {formatNumber(meta.numPages)} pages
              </span>
            </div>
            <button className="btn btn--ghost" onClick={reset}>
              Start over
            </button>
          </div>
        )}

        {(phase === 'ready' || phase === 'done' || phase === 'extracting') &&
          meta && (
            <section className="options">
              <h2 className="section-title">Text options</h2>
              <label className="check">
                <input
                  type="checkbox"
                  checked={formatOpts.paragraphDetection}
                  disabled={phase === 'extracting'}
                  onChange={(e) =>
                    setFormatOpts((o) => ({
                      ...o,
                      paragraphDetection: e.target.checked,
                    }))
                  }
                />
                Detect paragraphs (blank line between blocks)
              </label>
              <label className="check">
                <input
                  type="checkbox"
                  checked={formatOpts.dehyphenate}
                  disabled={phase === 'extracting'}
                  onChange={(e) =>
                    setFormatOpts((o) => ({
                      ...o,
                      dehyphenate: e.target.checked,
                    }))
                  }
                />
                Re-join words split across lines (de-hyphenate)
              </label>

              {phase !== 'extracting' && (
                <button className="btn btn--primary" onClick={runExtraction}>
                  {pages ? 'Re-extract text' : 'Extract text'}
                </button>
              )}
            </section>
          )}

        {phase === 'extracting' && (
          <section className="progress">
            <div className="progress__bar">
              <div className="progress__fill" style={{ width: `${pct}%` }} />
            </div>
            <div className="progress__row">
              <span>
                Page {formatNumber(progress.page)} of{' '}
                {formatNumber(progress.total)} · {pct}%
              </span>
              <span>
                {formatDuration(elapsed)} elapsed
                {eta > 0 ? ` · ~${formatDuration(eta)} left` : ''}
              </span>
            </div>
            <button className="btn btn--ghost" onClick={cancel}>
              Cancel
            </button>
          </section>
        )}

        {phase === 'done' && pages && stats && (
          <section className="results">
            <div className="stats">
              <Stat label="Pages with text" value={formatNumber(stats.pagesWithText)} />
              <Stat label="Words" value={formatNumber(stats.words)} />
              <Stat label="Characters" value={formatNumber(stats.characters)} />
              <Stat label="Time" value={formatDuration(elapsed)} />
            </div>

            {stats.characters === 0 && (
              <p className="warn-text">
                No selectable text was found. This PDF is likely scanned images
                — extracting text would need OCR, which this tool doesn’t do.
                You can still try extracting the images below.
              </p>
            )}

            <div className="toolbar">
              <div className="segmented">
                <button
                  className={outputFormat === 'txt' ? 'active' : ''}
                  onClick={() => setOutputFormat('txt')}
                >
                  Plain text
                </button>
                <button
                  className={outputFormat === 'md' ? 'active' : ''}
                  onClick={() => setOutputFormat('md')}
                >
                  Markdown
                </button>
              </div>
              <label className="check check--inline">
                <input
                  type="checkbox"
                  checked={pageMarkers}
                  onChange={(e) => setPageMarkers(e.target.checked)}
                />
                Page markers
              </label>
              <div className="toolbar__spacer" />
              <button className="btn btn--ghost" onClick={copyResult}>
                Copy
              </button>
              <button className="btn btn--primary" onClick={downloadResult}>
                Download .{outputFormat}
              </button>
            </div>

            <pre className="preview">
              {assembled.slice(0, PREVIEW_LIMIT)}
              {assembled.length > PREVIEW_LIMIT
                ? '\n\n… preview truncated — download to get the full text.'
                : ''}
            </pre>

            <ImageSection
              numPages={meta!.numPages}
              range={imgRange}
              setRange={setImgRange}
              busy={imgBusy}
              progress={imgProgress}
              images={images}
              onExtract={runImageExtraction}
              onDownload={downloadImages}
              onCancel={() => imgAbortRef.current?.abort()}
            />
          </section>
        )}
      </main>

      <footer className="footer">
        <p>
          100% client-side · your PDF never leaves your device · built with
          PDF.js
        </p>
      </footer>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="stat">
      <div className="stat__value">{value}</div>
      <div className="stat__label">{label}</div>
    </div>
  );
}

interface ImageSectionProps {
  numPages: number;
  range: { start: number; end: number };
  setRange: (r: { start: number; end: number }) => void;
  busy: boolean;
  progress: { page: number; total: number; found: number };
  images: ExtractedImage[] | null;
  onExtract: () => void;
  onDownload: () => void;
  onCancel: () => void;
}

function ImageSection({
  numPages,
  range,
  setRange,
  busy,
  progress,
  images,
  onExtract,
  onDownload,
  onCancel,
}: ImageSectionProps) {
  return (
    <section className="images">
      <h2 className="section-title">Images (optional)</h2>
      <p className="muted">
        Extract embedded pictures as PNG files, exactly as stored in the PDF.
        Choose a page range — large ranges can use a lot of memory.
      </p>
      <div className="range">
        <label>
          From page
          <input
            type="number"
            min={1}
            max={numPages}
            value={range.start}
            disabled={busy}
            onChange={(e) =>
              setRange({ ...range, start: Number(e.target.value) || 1 })
            }
          />
        </label>
        <label>
          to
          <input
            type="number"
            min={1}
            max={numPages}
            value={range.end}
            disabled={busy}
            onChange={(e) =>
              setRange({ ...range, end: Number(e.target.value) || 1 })
            }
          />
        </label>
        <span className="muted">of {formatNumber(numPages)}</span>
        {!busy && (
          <button className="btn" onClick={onExtract}>
            Find images
          </button>
        )}
        {busy && (
          <button className="btn btn--ghost" onClick={onCancel}>
            Cancel
          </button>
        )}
      </div>

      {busy && (
        <p className="muted">
          Scanning page {formatNumber(progress.page)} of{' '}
          {formatNumber(progress.total)} · {progress.found} found…
        </p>
      )}

      {!busy && images && (
        <div className="images__result">
          {images.length === 0 ? (
            <p className="muted">No embedded images found in that page range.</p>
          ) : (
            <>
              <p>
                Found <strong>{images.length}</strong> image
                {images.length === 1 ? '' : 's'}.
              </p>
              <button className="btn btn--primary" onClick={onDownload}>
                Download images (.zip)
              </button>
            </>
          )}
        </div>
      )}
    </section>
  );
}
