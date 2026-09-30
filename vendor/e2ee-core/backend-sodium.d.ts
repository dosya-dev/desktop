import type { CryptoBackend } from "./backend.js";
/**
 * The default backend: libsodium-wrappers-sumo (WASM, pinned 0.7.15 - 0.7.16
 * ships broken ESM). Loaded lazily by `getCryptoBackend` so a runtime that
 * installs its own backend never evaluates the WASM.
 */
export declare function loadSodiumBackend(): Promise<CryptoBackend>;
