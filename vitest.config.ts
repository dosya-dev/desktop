import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import path from "node:path";

/**
 * Component-level renderer tests only. The main-process suite (src/main/**)
 * runs on Node's own test runner (`npm run test:unit`) and stays there - see
 * the comment on tsconfig.node.json's exclude for why. This config exists
 * because a component test needs a DOM and a JSX transform, which the
 * node:test path cannot give it.
 */
export default defineConfig({
  plugins: [react()],
  resolve: {
    // Mirrors tsconfig.web.json's "@/*" -> "./src/renderer/*" - a component
    // test's import graph reaches modules that use the alias (e.g.
    // session-reset.ts -> heic-cache.ts -> "@/lib/file-url") even when the
    // test file itself only uses relative imports.
    alias: {
      "@": path.resolve(__dirname, "./src/renderer"),
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
      "src/main/sync/remote-client.path-safety.test.ts",
    ],
  },
});
