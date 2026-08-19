import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { discardStaleShipItState, SHIPIT_JOB_LABEL } from "./shipit-cleanup.ts";

/**
 * Run with `npm run test:unit` - Node's own test runner, no Electron. Side
 * effects are injected (caches dir, bootout command) so the 2026-08-19
 * incident chain is reproducible here: a stale launchd ShipIt job survives
 * every cache deletion and Gatekeeper-kills the next install.
 */

const tempCaches = () => mkdtemp(join(tmpdir(), "dosya-shipit-"));

async function seedShipItDir(cachesDir: string) {
  const dir = join(cachesDir, SHIPIT_JOB_LABEL);
  await mkdir(join(dir, "update.DoR2iKp"), { recursive: true });
  await writeFile(join(dir, "update.DoR2iKp", "stale-bundle"), "x");
  await writeFile(join(dir, "ShipItState.plist"), "{}");
  await writeFile(join(dir, "ShipIt_stderr.log"), "log");
  return dir;
}

function recordingDeps(cachesDir: string, overrides: Partial<Parameters<typeof discardStaleShipItState>[0]> = {}) {
  const bootouts: string[] = [];
  return {
    bootouts,
    deps: {
      platform: "darwin" as NodeJS.Platform,
      isPackaged: true,
      cachesDir,
      uid: 501,
      bootoutJob: (target: string) => void bootouts.push(target),
      ...overrides,
    },
  };
}

test("removes ShipItState.plist and update.* staging dirs but leaves the logs", async () => {
  const caches = await tempCaches();
  const dir = await seedShipItDir(caches);
  const { deps } = recordingDeps(caches);

  discardStaleShipItState(deps);

  assert.equal(existsSync(join(dir, "ShipItState.plist")), false);
  assert.equal(existsSync(join(dir, "update.DoR2iKp")), false);
  assert.equal(existsSync(join(dir, "ShipIt_stderr.log")), true);
});

test("boots the ShipIt launchd job out of the calling user's gui domain", async () => {
  const caches = await tempCaches();
  await seedShipItDir(caches);
  const { deps, bootouts } = recordingDeps(caches);

  discardStaleShipItState(deps);

  assert.deepEqual(bootouts, [`gui/501/${SHIPIT_JOB_LABEL}`]);
});

test("boots out the job even when the ShipIt cache directory is missing", async () => {
  // The 2026-08-19 trap: caches wiped by hand, launchd job still loaded.
  const caches = await tempCaches();
  const { deps, bootouts } = recordingDeps(caches);

  discardStaleShipItState(deps);

  assert.deepEqual(bootouts, [`gui/501/${SHIPIT_JOB_LABEL}`]);
});

test("a throwing bootout neither propagates nor aborts the file cleanup", async () => {
  const caches = await tempCaches();
  const dir = await seedShipItDir(caches);
  const { deps } = recordingDeps(caches, {
    bootoutJob: () => { throw new Error("Bad request."); },
  });

  discardStaleShipItState(deps);

  assert.equal(existsSync(join(dir, "ShipItState.plist")), false);
});

test("skips bootout when no uid is available, still cleans files", async () => {
  const caches = await tempCaches();
  const dir = await seedShipItDir(caches);
  const { deps, bootouts } = recordingDeps(caches, { uid: null });

  discardStaleShipItState(deps);

  assert.deepEqual(bootouts, []);
  assert.equal(existsSync(join(dir, "ShipItState.plist")), false);
});

test("does nothing off macOS", async () => {
  const caches = await tempCaches();
  const dir = await seedShipItDir(caches);
  const { deps, bootouts } = recordingDeps(caches, { platform: "win32" as NodeJS.Platform });

  discardStaleShipItState(deps);

  assert.deepEqual(bootouts, []);
  assert.equal(existsSync(join(dir, "ShipItState.plist")), true);
});

test("does nothing in an unpackaged (dev) build", async () => {
  const caches = await tempCaches();
  const dir = await seedShipItDir(caches);
  const { deps, bootouts } = recordingDeps(caches, { isPackaged: false });

  discardStaleShipItState(deps);

  assert.deepEqual(bootouts, []);
  assert.equal(existsSync(join(dir, "ShipItState.plist")), true);
});
