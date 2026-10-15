import { test } from "node:test";
import assert from "node:assert/strict";
import { acquireFolderAccess, type AppSeam } from "./bookmarks.ts";

/**
 * Under the App Sandbox a saved absolute path is inert after a relaunch; only
 * the security-scoped bookmark captured when the user picked the folder
 * reopens that grant. Outside the Mac App Store build the app has plain
 * filesystem access and the whole module is a no-op.
 */

function appThat(impl: (bookmark: string) => () => void): AppSeam {
  return { startAccessingSecurityScopedResource: impl };
}

const PATH = "/Users/x/Documents/dosya";
const reachable = () => true;

test("outside the store build it always succeeds with a no-op release", () => {
  const h = acquireFolderAccess(undefined, { distribution: "direct", app: null, path: PATH });
  assert.equal(h.ok, true);
  if (h.ok) assert.doesNotThrow(() => h.release());
  const h2 = acquireFolderAccess("anything", { distribution: "snap", app: null, path: PATH });
  assert.equal(h2.ok, true);
});

test("a pair saved without a bookmark is reported, not failed silently", () => {
  const h = acquireFolderAccess(undefined, {
    distribution: "mas",
    app: appThat(() => () => {}),
    path: PATH,
    probe: reachable,
  });
  assert.deepEqual(h, { ok: false, reason: "no-bookmark" });
});

test("a bookmark macOS will not resolve is stale", () => {
  const h = acquireFolderAccess("stale-token", {
    distribution: "mas",
    app: appThat(() => {
      throw new Error("bookmark data is corrupt");
    }),
    path: PATH,
    probe: reachable,
  });
  assert.deepEqual(h, { ok: false, reason: "stale" });
});

test("no app seam at all is stale rather than a crash", () => {
  assert.deepEqual(acquireFolderAccess("token", { distribution: "mas", app: null, path: PATH }), {
    ok: false,
    reason: "stale",
  });
});

test("a grant that resolved but does not reach the folder is stale, and is handed back", () => {
  // startAccessingSecurityScopedResource does not promise to throw for a
  // bookmark that no longer resolves. Reported as ok, the pair would fail the
  // engine's own access() a moment later and read as "Sync folder not found" -
  // an error with nothing to click instead of a reselect.
  let stops = 0;
  const probed: string[] = [];
  const h = acquireFolderAccess("token", {
    distribution: "mas",
    app: appThat(() => () => {
      stops++;
    }),
    path: PATH,
    probe: (p) => {
      probed.push(p);
      return false;
    },
  });
  assert.deepEqual(h, { ok: false, reason: "stale" });
  assert.deepEqual(probed, [PATH], "the probe looks at the pair's own folder");
  assert.equal(stops, 1, "a grant that is not being kept must be given back exactly once");
});

test("a stop function that throws while handing back an unreachable grant is swallowed", () => {
  const h = acquireFolderAccess("token", {
    distribution: "mas",
    app: appThat(() => () => {
      throw new Error("already stopped");
    }),
    path: PATH,
    probe: () => false,
  });
  assert.deepEqual(h, { ok: false, reason: "stale" });
});

test("a resolved bookmark holds the grant until released, and release is idempotent", () => {
  let stops = 0;
  const h = acquireFolderAccess("token", {
    distribution: "mas",
    app: appThat(() => () => {
      stops++;
    }),
    path: PATH,
    probe: reachable,
  });
  assert.equal(h.ok, true);
  if (!h.ok) return;
  h.release();
  h.release();
  assert.equal(stops, 1);
});

test("the folder is never probed outside the store build", () => {
  // Nothing was taken there, so there is nothing to verify - and a probe would
  // turn an unmounted drive on a Developer ID build into a permissions story.
  let probes = 0;
  const probe = () => {
    probes++;
    return true;
  };
  acquireFolderAccess("token", { distribution: "direct", app: appThat(() => () => {}), path: PATH, probe });
  acquireFolderAccess(undefined, { distribution: "ms-store", app: null, path: PATH, probe });
  assert.equal(probes, 0);
});

test("a stop function that throws (grant already reclaimed) is swallowed", () => {
  const h = acquireFolderAccess("token", {
    distribution: "mas",
    app: appThat(() => () => {
      throw new Error("already stopped");
    }),
    path: PATH,
    probe: reachable,
  });
  assert.equal(h.ok, true);
  if (h.ok) assert.doesNotThrow(() => h.release());
});
