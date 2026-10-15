// @vitest-environment node
//
// Runs on vitest, not Node's own test runner: LocalWatcher's constructor uses
// TS parameter properties (`private localPath: string`), which type-stripping
// mode refuses with ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX. Same reason and same
// precedent as remote-client.maintenance.test.ts and
// sync-engine-maintenance.test.ts - see vitest.config.ts's include list.
import { describe, expect, test } from "vitest";
import type { FSWatcher } from "chokidar";
import { LocalWatcher } from "./local-watcher";

/**
 * `stop()`'s contract: it never rejects, and it resets the watcher's state
 * whatever `close()` does.
 *
 * This is not a style preference. `stop()` became async so the engine could
 * await the fd release before re-arming (OBS-2), and chokidar's `close()` can
 * reject - the EMFILE path is exactly where another fs call is most likely to
 * hit a resource limit too. While the rejection propagated, it took out four
 * separate things, each worse than the failed close it was reporting:
 *
 *  - `this.watcher` stayed set, so `start()` early-returned for the rest of
 *    the session and live watching for that pair was silently off;
 *  - `pauseForRateLimit` never armed its resume timer, so the folder never
 *    synced again;
 *  - `stopPair` skipped `releaseFolderAccess()` and left the runtime alive;
 *  - `runInitialScan` fell THROUGH its own catch (which handles only
 *    SESSION_EXPIRED and rate limits) into `rt.syncing = true`, running a
 *    full scan-and-upload against a folder the server had just said was no
 *    longer synced.
 *
 * So these assertions stand in for all four, which is why they are worth
 * their own file and their own seam.
 */

/** A watcher whose close() does what the test needs. The real FSWatcher has a
 *  large surface and these two members are all `startWatcher`/`stop` touch, so
 *  the fake implements those and is cast once, here, rather than in the class. */
function fakeWatcher(close: () => Promise<void>): FSWatcher {
  return {
    on() {
      return this;
    },
    close,
  } as unknown as FSWatcher;
}

class TestWatcher extends LocalWatcher {
  closeCalls = 0;
  constructor(private readonly close: () => Promise<void>) {
    super("/tmp/does-not-need-to-exist");
  }
  protected override openWatcher(): FSWatcher {
    return fakeWatcher(() => {
      this.closeCalls++;
      return this.close();
    });
  }
}

describe("LocalWatcher.stop()", () => {
  test("resolves and resets even when close() rejects", async () => {
    const w = new TestWatcher(() => Promise.reject(new Error("EMFILE: too many open files")));
    w.start();
    expect(w.isWatching()).toBe(true);

    // Must not reject. Resolving without closing would pass for the wrong
    // reason, so the close count is checked too.
    await expect(w.stop()).resolves.toBeUndefined();
    expect(w.closeCalls).toBe(1);

    // The state reset is the half that kept the pair wedged: start() refuses
    // to re-arm while `watcher` is set.
    expect(w.isWatching()).toBe(false);
    w.start();
    expect(w.isWatching()).toBe(true);
  });

  test("resolves and resets on a normal close", async () => {
    const w = new TestWatcher(() => Promise.resolve());
    w.start();
    await w.stop();
    expect(w.closeCalls).toBe(1);
    expect(w.isWatching()).toBe(false);
  });

  test("is safe to call when nothing was ever started", async () => {
    const w = new TestWatcher(() => Promise.resolve());
    await expect(w.stop()).resolves.toBeUndefined();
    expect(w.closeCalls).toBe(0);
    expect(w.isWatching()).toBe(false);
  });

  test("a close() that throws synchronously is caught too", async () => {
    // `await` on a thrown-not-rejected call lands in the same catch, but only
    // because the call is inside the try - a `const p = close(); await p`
    // shape would escape it.
    const w = new TestWatcher(() => {
      throw new Error("sync throw");
    });
    w.start();
    await expect(w.stop()).resolves.toBeUndefined();
    expect(w.isWatching()).toBe(false);
  });
});
