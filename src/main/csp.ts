/**
 * The renderer's Content Security Policy, as a pure function so it can be
 * tested. session.ts attaches the result to every renderer document.
 *
 * Two allowances exist for the Vault (E2EE Spaces):
 * - `'wasm-unsafe-eval'` in script-src: libsodium instantiates WebAssembly
 *   from bytes inside the vendored e2ee bundle. Chromium refuses that under a
 *   bare 'self'. This permits WebAssembly compilation only, not JS eval.
 * - the R2 S3 endpoints in connect-src: encrypted chunks move renderer <-> R2
 *   directly over presigned URLs, never through the API. The two hostnames are
 *   the same ones apps/web/public/_headers names (main account + EU jurisdiction).
 */
export const E2EE_CHUNK_ORIGINS: readonly string[] = [
  "https://0b25394b353c95a526538e19706809e8.r2.cloudflarestorage.com",
  "https://0b25394b353c95a526538e19706809e8.eu.r2.cloudflarestorage.com",
];

/**
 * Chunk origins for the policy: E2EE_CHUNK_ORIGINS unless `override` (the
 * E2EE_CHUNK_ORIGINS env var) names a comma- or whitespace-separated list -
 * a bucket move must not need a desktop release to be testable.
 */
export function chunkOrigins(override: string | undefined): string[] {
  const list = (override ?? "").split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);
  return list.length > 0 ? list : [...E2EE_CHUNK_ORIGINS];
}

export type CspInputs = {
  apiBase: string;
  docsBase: string;
  chunkOrigins: readonly string[];
};

/** Strict policy for packaged builds served from app://bundle. */
export function packagedCsp({ apiBase, docsBase, chunkOrigins }: CspInputs): string {
  return [
    "default-src 'self'",
    `script-src 'self' 'wasm-unsafe-eval' ${docsBase}`,
    // MapLibre builds its render worker from a blob: URL. worker-src has no
    // policy of its own here, so it falls back to script-src, which does not
    // allow blob: - the worker was refused, MapLibre threw inside a React
    // effect, and the whole renderer unmounted to a white window. Kept
    // separate from script-src on purpose: this permits a worker built from
    // a blob, not inline script anywhere.
    "worker-src 'self' blob:",
    // blob: throughout for the ebook reader: foliate-js renders the book
    // inside a blob iframe and hands it the book's OWN stylesheets, fonts and
    // media as blob/data URLs. Without these the reader loads and then
    // quietly drops the book's typography and images.
    "style-src 'self' 'unsafe-inline' blob:",
    `img-src 'self' data: blob: ${apiBase} ${docsBase}`,
    // sentry-ipc: is the crash reporter's renderer-to-main fallback (a fetch
    // to a privileged in-process scheme, never the network) used only if the
    // preload's IPC bridge is unavailable.
    `connect-src 'self' sentry-ipc: ${apiBase} ${docsBase} ${chunkOrigins.join(" ")}`,
    // In-app file viewer: <video>/<audio> stream from the API, and the PDF
    // preview loads /raw in an <iframe>. Without these, media falls back to
    // default-src 'self' and gets blocked.
    `media-src 'self' blob: data: ${apiBase}`,
    `frame-src 'self' blob: ${apiBase} ${docsBase}`,
    "font-src 'self' data: blob:",
    "object-src 'none'",
    "base-uri 'self'",
  ].join("; ");
}

/** Looser policy for `electron-vite dev` on localhost: inline/eval + ws for HMR. */
export function devCsp({ apiBase, docsBase, chunkOrigins }: CspInputs): string {
  return [
    "default-src 'self' http://localhost:* ws://localhost:*",
    `script-src 'self' 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval' ${docsBase}`,
    // Same as the packaged policy: the map's worker comes from a blob.
    "worker-src 'self' blob: http://localhost:*",
    "style-src 'self' 'unsafe-inline' blob:",
    `img-src 'self' data: blob: http://localhost:* ${apiBase} ${docsBase}`,
    `connect-src 'self' sentry-ipc: http://localhost:* ws://localhost:* ${apiBase} ${docsBase} ${chunkOrigins.join(" ")}`,
    `media-src 'self' blob: data: http://localhost:* ${apiBase}`,
    `frame-src 'self' blob: http://localhost:* ${apiBase} ${docsBase}`,
    "font-src 'self' data: blob:",
    "object-src 'none'",
    "base-uri 'self'",
  ].join("; ");
}
