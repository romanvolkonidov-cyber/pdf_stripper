# PDF Stripper

Extract clean, **well-formatted text** (and embedded **images**) from any PDF —
**right in your browser**. No uploads, no size limits, no waiting on a server.

Built for the case where your PDF is *huge* (hundreds of MB). Because everything
runs locally, a 800 MB file is handled the same way a 2 MB one is: the browser
reads it straight off your disk in small chunks and processes it page by page.

> Your PDF never leaves your device. The only network requests the app makes are
> for generic PDF.js font/character-map resources — never your document.

---

## Why client-side (and not a server)?

A "just upload it and we'll process it" design falls apart at 800 MB:

| Approach | 800 MB reality |
| --- | --- |
| Upload to a serverless function (Vercel / Firebase) | Request bodies are capped at a few MB and functions time out in seconds. ❌ |
| Upload to blob storage + background worker | Slow upload, storage cost, complex, and still memory-heavy. 😕 |
| **Read & parse in the browser (this app)** | No upload, no limit, private, free to host as a static site. ✅ |

Since your PDFs already have a real (selectable) text layer, no OCR is needed —
we read the actual text and rebuild the layout (lines, paragraphs, spacing).

### How the large-file handling works

- The file is opened via an **object URL**, which browsers serve with HTTP
  **range** support. PDF.js streams the document in ~1 MB chunks instead of
  loading all 800 MB into memory at once (`disableAutoFetch`).
- Pages are processed **one at a time** and released (`page.cleanup()`), so
  memory stays roughly flat no matter how many pages there are.

---

## Features

- 📄 **Great text output** — layout-aware reconstruction: paragraphs, line
  breaks, and word spacing are preserved.
- 🔧 **Formatting toggles** — paragraph detection and de-hyphenation
  (re-joining words split across a line break, e.g. `exam-` + `ple` → `example`).
- 🧾 **Plain text or Markdown**, with optional per-page markers.
- 🖼️ **Image extraction** — pull embedded pictures out as PNGs (choose a page
  range) and download them as a `.zip`.
- 📊 Live progress with page count, elapsed time, and ETA — and a Cancel button.
- 🔒 **100% private** — nothing is uploaded.

---

## Run locally

```bash
npm install
npm run dev
```

Then open the printed URL (usually http://localhost:5173).

Other scripts:

```bash
npm run build       # type-check + production build into dist/
npm run preview     # serve the production build locally
npm run typecheck   # type-check only
```

---

## Deploy to Vercel (recommended)

This is a static Vite site, so Vercel needs almost no configuration.

**Option A — dashboard**
1. Push this repo to GitHub.
2. In Vercel, **Add New → Project**, import the repo.
3. Framework preset is auto-detected as **Vite**. Output dir: `dist`.
4. Deploy. Done.

**Option B — CLI**
```bash
npm i -g vercel
vercel          # preview deploy
vercel --prod   # production deploy
```

`vercel.json` is already included (build command + SPA rewrite), so it works
out of the box.

---

## Deploy to Firebase Hosting (alternative)

```bash
npm i -g firebase-tools
firebase login

# point the included config at your project:
#   edit .firebaserc -> replace YOUR_FIREBASE_PROJECT_ID
# (or run: firebase use --add)

npm run build
firebase deploy --only hosting
```

`firebase.json` is preconfigured to serve `dist/` with SPA rewrites and cached
assets.

---

## Tips for very large PDFs (like your 800 MB one)

- Use a **desktop** browser (Chrome or Firefox) with plenty of free RAM. Phones
  and tablets will struggle with files this size.
- Text extraction is light on memory. **Image** extraction can be heavy, so do
  it in **page ranges** rather than the whole document at once.
- The first run downloads the PDF.js worker (~1 MB) and, for some PDFs, font /
  character-map data; after that it's cached.

---

## Limitations

- **Scanned PDFs** (pages that are just images of text) have no text layer, so
  there's nothing to extract without OCR — which this tool intentionally does
  not do. It'll tell you when it finds no selectable text. You can still extract
  the page images.
- Text reconstruction is heuristic. Complex multi-column layouts, tables, and
  unusual typesetting may not come out perfectly — though paragraphs and reading
  order are handled well for typical documents.
- Image extraction is best-effort across PDF color spaces; the common cases
  (JPEG/RGB/RGBA/grayscale) are covered.

---

## Tech

- [React 19](https://react.dev/) + [Vite](https://vite.dev/)
- [PDF.js](https://mozilla.github.io/pdf.js/) for parsing and rendering
- [fflate](https://github.com/101arrowz/fflate) for zipping extracted images
- TypeScript throughout

## License

MIT
