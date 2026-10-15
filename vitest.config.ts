import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import path from "node:path";
import { acknowledgementsPlugin } from "./scripts/acknowledgements-plugin";

/**
 * Component-level renderer tests only. The main-process suite (src/main/**)
 * runs on Node's own test runner (`npm run test:unit`) and stays there - see
 * the comment on tsconfig.node.json's exclude for why. This config exists
 * because a component test needs a DOM and a JSX transform, which the
 * node:test path cannot give it.
 */
export default defineConfig({
  // The same virtual module the renderer build gets (AboutPage imports it).
  plugins: [react(), acknowledgementsPlugin(__dirname)],
  resolve: {
    // Mirrors tsconfig.web.json's "@/*" -> "./src/renderer/*" - a component
    // test's import graph reaches modules that use the alias (e.g.
    // session-reset.ts -> heic-cache.ts -> "@/lib/file-url") even when the
    // test file itself only uses relative imports.
    alias: {
      "@": path.resolve(__dirname, "./src/renderer"),
      "@dosya-dev/e2ee-core": path.resolve(__dirname, "./vendor/e2ee-core/index.js"),
      "@dosya-dev/e2ee-client": path.resolve(__dirname, "./vendor/e2ee-client/index.js"),
    },
  },
  test: {
    environment: "jsdom",
    globals: false,
    include: [
      "src/renderer/**/*.test.tsx",
      // lan-peer.ts imports lan-protocol.ts with a bundler-style specifier,
      // which node:test cannot resolve, so its suite runs here instead (the
      // same reason as the sync files below).
      "src/renderer/lib/lan-peer.test.ts",
      // lan-transport.ts imports "@/lib/api-client" (a bundler-style path
      // alias) which node:test cannot resolve either - same reason as
      // lan-peer.ts above, so this suite runs here too.
      "src/renderer/lib/lan-transport.test.ts",
      // Pure-function tests ported straight from the web copy (see the file's
      // own header) - vitest's own `describe`/`it` don't run under node:test,
      // so this needs the same explicit carve-out as lan-peer.test.ts above.
      "src/renderer/lib/live-photos.test.ts",
      // Same story as live-photos: vitest's describe/it, which node:test cannot
      // run. It was swept into the node:test glob and had been red there since
      // it was added.
      "src/renderer/lib/auth-direction.test.ts",
      // The Vault store and its seams use "@/..." and the vendored e2ee alias,
      // which node:test cannot resolve - same reason as lan-peer above.
      "src/renderer/lib/vault/*.test.ts",
      // remote-client.ts and index.ts (SyncEngine) both use TS parameter
      // properties and extensionless relative imports (bundler-style
      // resolution) - Node's own test runner cannot load either (see the
      // comment in upload-doors.test.ts, and each file's own header
      // comment), so these two run on vitest instead of the node:test
      // convention every other src/main/**/*.test.ts file uses.
      "src/main/sync/remote-client.maintenance.test.ts",
      "src/main/sync/sync-engine-maintenance.test.ts",
      "src/main/sync/sync-engine-session-expired.test.ts",
      "src/main/sync/filesystem-safety.test.ts",
      "src/main/sync/sync-engine-path-safety.test.ts",
      "src/main/sync/sync-engine-keep-both-loop.test.ts",
      "src/main/sync/remote-client.path-safety.test.ts",
      "src/main/sync/remote-client.refusals.test.ts",
      "src/main/sync/sync-engine-refusals.test.ts",
      "src/main/sync/sync-engine-bookmarks.test.ts",
      // LocalWatcher uses a TS parameter property too
      // (`private localPath: string`), so Node's type-stripping runner
      // refuses it with ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX - same reason as
      // the sync files above.
      "src/main/sync/local-watcher.test.ts",
      "src/main/sync/reconciler-index.test.ts",
      // lan-receive.ts imports longPath from ./sync/paths with an
      // extensionless relative specifier (same bundler-style resolution as
      // the sync files above) - node:test cannot resolve it, so this one
      // runs here instead of the node:test convention every other
      // src/main/*.test.ts file uses.
      "src/main/lan-receive.test.ts",
      // ipc-sender.ts imports originAllowed from ./trusted-origins with the
      // same extensionless relative specifier, so its suite runs here for the
      // same reason as lan-receive above. Its sibling
      // src/main/ipc-gate-coverage.test.ts reads source files as plain text
      // and has no import graph, so that one stays on node:test.
      "src/main/ipc-sender.test.ts",
      // vault-save.ts grew an incremental sink that imports longPath from
      // ./sync/paths with the same extensionless relative specifier, so its
      // suite moved here from node:test for the same reason as lan-receive.
      "src/main/vault-save.test.ts",
    ],
  },
});
