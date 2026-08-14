import { build } from "esbuild";
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * Inlines the ebook reader into one self-contained HTML string, mirroring
 * apps/mobile/scripts/build-reader.mjs. The reader page itself is shared with
 * mobile: same foliate-js engine, same message protocol, so the desktop app
 * inherits pagination, themes, the TOC and search rather than reimplementing
 * them.
 *
 * The page runs in an iframe here rather than a react-native-webview; the host
 * bridge is shimmed in index.html.
 */
const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const result = await build({
  entryPoints: [join(root, "src/renderer/lib/reader/reader-page/main.js")],
  bundle: true,
  format: "iife",
  target: "es2020",
  minify: true,
  write: false,
  // vendor/foliate-js/pdf.js imports ./vendor/pdfjs/pdf.mjs, which is not
  // vendored: it needs ~13MB of fonts and cmaps and a Worker loaded from a real
  // URL, none of which survives being inlined into one string. view.js only
  // reaches it for PDFs, and this app renders those natively in its own viewer.
  external: ["./pdf.js"],
});

const js = result.outputFiles[0]?.text ?? "";
if (!js || js.trim().length === 0) {
  console.error("build-reader: esbuild produced an empty bundle - refusing to write a stub READER_HTML.");
  process.exit(1);
}

const TEMPLATE = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no">
<style>
  html, body { margin: 0; padding: 0; height: 100%; overflow: hidden; }
  foliate-view { display: block; height: 100%; }
  /* The gutter between the two pages of a spread. Drawn over the paginator
     because its layout lives in a closed shadow root we cannot style into.
     currentColor at low alpha so it reads on any reading theme without being
     told which one is active. */
  #dosya-gutter {
    position: fixed;
    top: 6%;
    bottom: 6%;
    left: 50%;
    width: 1px;
    background: currentColor;
    opacity: 0.14;
    pointer-events: none;
    display: none;
  }
</style>
</head>
<body>
<script src="./reader.js"></script>
</body>
</html>
`;

const outDir = join(root, "src/renderer/public/reader");
mkdirSync(outDir, { recursive: true });

// TWO FILES, NOT ONE INLINED STRING.
//
// The reader runs in an iframe, and an iframe inherits the EMBEDDING page's
// Content-Security-Policy - a srcdoc document does not get to relax it with its
// own meta tag. This app's policy is `script-src 'self'`, so an inline <script>
// in the reader page is blocked outright and the reader silently never boots.
// Shipping the bundle as a real same-origin asset satisfies 'self' with no
// policy change and no per-build hash to maintain, and it keeps the reader out
// of the app's own JS bundle.
//
// apps/mobile still inlines its copy: a react-native-webview has no origin to
// serve an asset from, and no parent document whose CSP it inherits.
const SHIM = `// Host bridge shim, PREPENDED into the bundle rather than written as an inline
// <script> in the page. The embedding app's CSP is \`script-src 'self'\` and an
// iframe inherits it, so any inline script here is blocked - which is exactly
// how this shipped broken twice. Being first in the bundle, it still runs
// before main.js touches it.
//
// The page is shared with apps/mobile, where the host is react-native-webview;
// here the host is the parent window. Same message shapes either way, so
// main.js needs no branching.
window.ReactNativeWebView = { postMessage: function (m) { parent.postMessage(m, "*"); } };
`;
writeFileSync(join(outDir, "reader.js"), SHIM + js);
// GUARD: an inline <script> here is silently fatal under `script-src 'self'`
// - the reader loads, executes nothing, and the viewer falls back to a Download
// button that looks like the feature was never built. Fail the build instead.
if (/<script(?![^>]*\ssrc=)/i.test(TEMPLATE)) {
  console.error("build-reader: the reader page contains an inline <script>, which the embedding CSP blocks. Move it into the bundle.");
  process.exit(1);
}
writeFileSync(join(outDir, "index.html"), TEMPLATE);
console.log(`desktop reader assets written (src/renderer/public/reader, ${(js.length / 1024).toFixed(0)} KB)`);
