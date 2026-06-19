import { useCallback, useRef, useState } from 'react';

interface DropzoneProps {
  onFile: (file: File) => void;
  disabled?: boolean;
}

function isPdf(file: File): boolean {
  return (
    file.type === 'application/pdf' || /\.pdf$/i.test(file.name)
  );
}

export function Dropzone({ onFile, disabled }: DropzoneProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleFiles = useCallback(
    (files: FileList | null) => {
      const file = files?.[0];
      if (!file) return;
      if (!isPdf(file)) {
        setError('That doesn’t look like a PDF. Please choose a .pdf file.');
        return;
      }
      setError(null);
      onFile(file);
    },
    [onFile],
  );

  return (
    <div>
      <div
        className={`dropzone${dragging ? ' dropzone--active' : ''}${
          disabled ? ' dropzone--disabled' : ''
        }`}
        onClick={() => !disabled && inputRef.current?.click()}
        onDragOver={(e) => {
          e.preventDefault();
          if (!disabled) setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          if (!disabled) handleFiles(e.dataTransfer.files);
        }}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if ((e.key === 'Enter' || e.key === ' ') && !disabled) {
            inputRef.current?.click();
          }
        }}
      >
        <input
          ref={inputRef}
          type="file"
          accept="application/pdf,.pdf"
          hidden
          onChange={(e) => handleFiles(e.target.files)}
        />
        <div className="dropzone__icon" aria-hidden>
          {'↑'}
        </div>
        <p className="dropzone__title">Drop a PDF here, or click to choose</p>
        <p className="dropzone__hint">
          Works with large files. Nothing is uploaded — your PDF is read right
          here in your browser.
        </p>
      </div>
      {error && <p className="error-text">{error}</p>}
    </div>
  );
}
