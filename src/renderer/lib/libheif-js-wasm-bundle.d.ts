// Ported from apps/web/src/lib/libheif-js-wasm-bundle.d.ts - keep in sync with the web copy.
// `libheif-js` ships no types for its `wasm-bundle` subpath entry point.
// `heic-decode.ts` types the resolved module shape itself; this just quiets
// TS7016 ("could not find a declaration file") for the bare import.
declare module 'libheif-js/wasm-bundle';
