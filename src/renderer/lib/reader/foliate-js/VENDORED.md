# Vendored: foliate-js

- Source repo: https://github.com/johnfactotum/foliate-js
- Commit: `78914aef4466eb960965702401634c2cb348e9b1`
- Vendored on: 2026-08-06
- License: MIT (see `LICENSE` in this directory; copyright John Factotum)

**Do not edit these files in place.** To pick up upstream changes, re-clone
the repo at the commit you want, diff against this directory, and re-copy -
don't hand-patch the vendored sources.

## What was copied

All top-level `*.js` library source files (EPUB/MOBI/AZW3/FB2/CBZ parsing,
the `<foliate-view>` custom element, pagination, CFI, TOC/search/TTS
helpers), plus `LICENSE`, plus the two `vendor/` sub-dependencies that the
copied files actually import: `vendor/zip.js` (ZIP reading, used by
`epub.js`/`comic-book.js`/`fb2.js` for `.fb2.zip`) and `vendor/fflate.js`
(inflate, used by `mobi.js` for PalmDOC/HUFF-CDIC decompression).

## What was intentionally left out

- `reader.js`, `reader.html`, `ui/menu.js`, `ui/tree.js` - foliate-js's own
  demo reader web app. Not a library dependency (`view.js` never imports
  these); our own `src/reader/reader-page/main.js` + `index.html` replace it.
- `eslint.config.js`, `rollup.config.js`, `rollup/`, `package.json`,
  `package-lock.json` - the upstream repo's own dev tooling/build pipeline.
  We bundle with esbuild (see `apps/mobile/scripts/build-reader.mjs`), not
  their rollup config.
- `tests/`, `.github/`, `.gitignore`, `.gitattributes`, `README.md` - repo
  meta/tests, not runtime library code.
- **`vendor/pdfjs/`** (~13MB: `pdf.mjs`, a ~2MB `pdf.worker.mjs`, cmaps,
  standard fonts) - deliberately NOT vendored. `pdf.js` (the small top-level
  loader, kept above) statically imports `./vendor/pdfjs/pdf.mjs`, and at
  runtime that module does a top-level `fetch()` for its CSS and expects a
  real page URL to resolve a separate Worker script from. That's
  incompatible with this project's reader page, which is a single
  self-contained inlined-HTML string with no network access and no
  real origin. PDF is also outside this feature's target formats
  (EPUB/MOBI/AZW3, plus whatever else `view.js` can already open: FB2, CBZ).
  `scripts/build-reader.mjs` marks `pdf.js` as `external` to esbuild so the
  bundler never tries to resolve `./vendor/pdfjs/pdf.mjs` (which would
  otherwise be a build error since we didn't vendor it). If a PDF ever
  somehow reaches `__dosyaOpen`, `view.open()`'s dynamic `import('./pdf.js')`
  fails (nothing there to resolve at runtime either), which surfaces as a
  caught error and a `{type:"error"}` postMessage - it does not hang, and it
  does not attempt to fetch real network content.
- `dict.js`, `footnotes.js`, `opds.js`, `quote-image.js`,
  `uri-template.js` are vendored (they're real top-level library sources,
  small, and harmless to keep for fidelity) but are not imported by
  `view.js` or our `main.js`, so esbuild never pulls them into the built
  bundle.
