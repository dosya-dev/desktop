// Plain-text book support for the reader page.
//
// Bundled by esbuild into the WebView page (see scripts/build-reader.mjs);
// also imported directly by txt.test.ts under jest for the pure string
// helpers. makeTxtBook uses Blob/URL.createObjectURL, which jsdom/jest don't
// provide meaningfully, so it is exercised only inside the WebView (build +
// device testing), not under jest.

export function escapeHtml(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function txtToHtml(text) {
  const paras = text.split(/\r?\n\s*\r?\n/).map(
    (p) => `<p>${escapeHtml(p).replace(/\r?\n/g, "<br>")}</p>`,
  );
  return `<!doctype html><html><head><meta charset="utf-8"></head><body>${paras.join("")}</body></html>`;
}

/**
 * Minimal foliate-js book object wrapping one HTML section, shaped to match
 * what vendor/foliate-js/view.js's View.open() and progress.js's
 * TOCProgress/SectionProgress expect (see vendor/foliate-js/fb2.js for the
 * reference shape this was checked against: sections need
 * {id, linear, size, load, unload}; the book needs
 * {metadata, toc, sections, resolveHref, splitTOCHref, getTOCFragment}).
 */
export function makeTxtBook(text, title) {
  const html = txtToHtml(text);
  const blob = new Blob([html], { type: "text/html" });
  const url = URL.createObjectURL(blob);
  return {
    metadata: { title },
    toc: [{ label: title, href: "s0" }],
    sections: [{ id: "s0", linear: "yes", size: blob.size, load: () => url, unload: () => {} }],
    resolveHref: () => ({ index: 0, anchor: () => 0 }),
    splitTOCHref: (href) => [href, null],
    getTOCFragment: (doc) => doc.documentElement,
  };
}
