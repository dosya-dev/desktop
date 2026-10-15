// @vitest-environment node
//
// lan-receive.ts imports longPath from ./sync/paths with an extensionless
// relative specifier (the "moduleResolution": "bundler" style electron-vite
// bundles it with) - Node's own strip-only type stripping cannot resolve
// that (see the same limitation documented in remote-client.maintenance.
// test.ts). Vitest's esbuild transform handles it, so this one file runs
// there instead of the node:test convention every other src/main/*.test.ts
// file uses - see vitest.config.ts's include list and package.json's
// test:unit glob exclusion.
import { describe, expect, it } from "vitest";
import { mkdtempSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openSink, writeSink, closeSink, abortAllSinks, openSinkCount } from "./lan-receive";

const scratch = () => mkdtempSync(join(tmpdir(), "lan-sink-test-"));

describe("lan-receive sink cleanup", () => {
  it("abortAllSinks closes every sink and removes its partial file", async () => {
    const dir = scratch();
    try {
      const deps = {
        showSaveDialog: async () => ({ canceled: false, filePath: join(dir, "partial.bin") }),
        downloadsDir: () => dir,
      };
      const opened = await openSink("partial.bin", 1024, deps);
      expect(opened.ok && opened.id).toBeTruthy();
      await writeSink(opened.id!, new Uint8Array(16));
      expect(openSinkCount()).toBe(1);
      expect(existsSync(join(dir, "partial.bin"))).toBe(true);

      await abortAllSinks();

      expect(openSinkCount()).toBe(0); // no sink may survive abortAllSinks
      expect(existsSync(join(dir, "partial.bin"))).toBe(false); // the partial file must be removed
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a sink id that no longer exists is rejected, not an unhandled throw", async () => {
    // Review Focus #1: after a renderer death cleaned up, the old id must error cleanly.
    await expect(writeSink("nope", new Uint8Array(1))).rejects.toThrow(/No such transfer/);
    await expect(closeSink("nope")).rejects.toThrow(/No such transfer/);
  });
});
