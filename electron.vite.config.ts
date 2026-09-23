import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { sentryVitePlugin } from "@sentry/vite-plugin";
import { readFileSync } from "fs";
import { resolve } from "path";
import { releaseName } from "./src/main/telemetry-config";

// Source maps go to Sentry only when the release workflow supplies a token
// (never from a developer's ~/.sentryclirc by accident). Then, and only then,
// each build emits hidden maps, uploads them keyed by debug id, and deletes
// them again so nothing but the debug-id comment ships in the package. The
// release name matches what src/main/telemetry.ts reports at runtime: the
// workflow runs `npm version <input>` before building, so package.json is
// exactly the version the app will announce.
const SENTRY_UPLOAD = Boolean(process.env.SENTRY_AUTH_TOKEN);
const { version: PKG_VERSION } = JSON.parse(readFileSync(resolve(__dirname, "package.json"), "utf8")) as { version: string };
const sentryUpload = () =>
  SENTRY_UPLOAD
    ? [
        sentryVitePlugin({
          org: "dosya-pty-ltd",
          project: "dosya-desktop",
          url: "https://de.sentry.io/",
          authToken: process.env.SENTRY_AUTH_TOKEN,
          telemetry: false,
          // A Sentry outage or a stale token must not block a release (the
          // build is still correct, only symbolication is lost), but it must
          // not pass silently either: the ::warning:: shows up as an
          // annotation on the workflow run.
          errorHandler: (err) => console.warn(`::warning::Sentry source-map upload failed: ${err.message}`),
          release: { name: releaseName(PKG_VERSION) },
          sourcemaps: { filesToDeleteAfterUpload: [resolve(__dirname, "out/**/*.map")] },
        }),
      ]
    : [];
const sourcemap = SENTRY_UPLOAD ? ("hidden" as const) : false;

export default defineConfig({
  main: {
    // @sentry/electron is in the exclude list (= bundled, not externalized)
    // because the package ships no node_modules (electron-builder.yml `files`).
    plugins: [
      externalizeDepsPlugin({ exclude: ["chokidar", "graceful-fs", "electron-updater", "qrcode", "http-proxy-agent", "https-proxy-agent", "@sentry/electron"] }),
      ...sentryUpload(),
    ],
    build: {
      outDir: "out/main",
      sourcemap,
      rollupOptions: {
        // Two entries: the main process, and the sync engine that main forks
        // into a utilityProcess. They share the main build because they share
        // a runtime (Electron's Node) and most of the sync sources; only the
        // entry differs. `engine.js` must exist next to `index.js` - main
        // resolves it with join(__dirname, "engine.js").
        input: {
          index: resolve(__dirname, "src/main/index.ts"),
          engine: resolve(__dirname, "src/engine/main.ts"),
        },
      },
    },
  },
  preload: {
    // Same reason as main: the Sentry IPC bridge has to be inside the bundle.
    plugins: [externalizeDepsPlugin({ exclude: ["@sentry/electron"] })],
    build: {
      outDir: "out/preload",
      rollupOptions: {
        input: { index: resolve(__dirname, "src/preload/index.ts") },
      },
    },
  },
  renderer: {
    plugins: [react(), tailwindcss(), ...sentryUpload()],
    root: resolve(__dirname, "src/renderer"),
    // The HEIC decode worker (lib/heic.worker.ts) is loaded via
    // `new Worker(new URL(...), { type: "module" })`. The renderer build uses
    // manualChunks (code-splitting), and the default "iife" worker format can't
    // code-split - force ES module workers.
    worker: { format: "es" },
    // Pin the dev port so the renderer's dev origin is stable and matches the
    // API's CORS allowlist (http://localhost:5174) now that webSecurity is on.
    server: { port: 5174, strictPort: true },
    build: {
      outDir: "out/renderer",
      sourcemap,
      rollupOptions: {
        input: resolve(__dirname, "src/renderer/index.html"),
        output: {
          // Split heavy vendors into their own long-cached chunks so a page
          // change doesn't re-download React/Query/icons, and the initial
          // parse cost is spread across smaller files.
          manualChunks(id: string) {
            if (!id.includes("node_modules")) return;
            if (id.includes("react-dom") || id.includes("/react/") || id.includes("scheduler")) return "vendor-react";
            if (id.includes("react-router") || id.includes("@remix-run")) return "vendor-router";
            if (id.includes("@tanstack")) return "vendor-query";
            if (id.includes("lucide-react")) return "vendor-icons";
            // Lazy-only heavyweights get their own chunks so the entry does
            // not depend on them: maplibre (Map page) and shiki (code viewer)
            // together were ~4.2 MB of the old catch-all vendor chunk, fetched
            // and parsed on EVERY window start for pages most sessions never
            // visit.
            if (id.includes("maplibre") || id.includes("pmtiles") || id.includes("supercluster")) return "vendor-map";
            if (id.includes("shiki") || id.includes("oniguruma")) return "vendor-shiki";
            if (id.includes("@sentry")) return "vendor-sentry";
            return "vendor";
          },
        },
      },
    },
    resolve: {
      alias: {
        "@": resolve(__dirname, "src/renderer"),
        // Vendored into apps/desktop (scripts/vendor-audio-player.mjs) rather
        // than aliased at ../../packages: CI syncs only apps/desktop/ to the
        // public repo, where that sibling does not exist.
        "@dosya-dev/audio-player": resolve(__dirname, "vendor/audio-player/index.ts"),
      },
    },
  },
});
