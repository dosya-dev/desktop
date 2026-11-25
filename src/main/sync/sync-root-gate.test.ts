import { test } from "node:test";
import assert from "node:assert/strict";
import { PickedFolders } from "./picked-folders.ts";
import { NOT_PICKED_MESSAGE, pickRendererConfig, syncRootRefusal } from "./sync-root-gate.ts";

/**
 * Bounty (desktop 3.1.10): a script in the renderer (the remote ONLYOFFICE
 * api.js) called sync:add-pair on ~/.ssh (push: keys uploaded) and ~/.config
 * (pull: ~/.config/autostart/*.desktop written, code execution). The only
 * check was "absolute path". Now a sync root must have been picked by the
 * user in the native picker this session AND must not be a home, system or
 * credential folder.
 */

const HOME = "/home/firat";

function deps(picked: PickedFolders, realpath: (p: string) => string | null = (p) => p) {
  return { picked, platform: "linux" as const, home: HOME, tmpDir: "/tmp", realpath };
}

test("a folder the user picked is accepted", () => {
  const picked = new PickedFolders("linux");
  picked.remember(`${HOME}/Documents/work`);
  assert.equal(syncRootRefusal(`${HOME}/Documents/work`, deps(picked)), null);
  // Trailing slash and redundant segments name the same folder.
  assert.equal(syncRootRefusal(`${HOME}/Documents/./work/`, deps(picked)), null);
});

test("a folder the renderer names without the picker is refused", () => {
  const picked = new PickedFolders("linux");
  assert.equal(syncRootRefusal(`${HOME}/Documents/work`, deps(picked)), NOT_PICKED_MESSAGE);
  picked.remember(`${HOME}/Documents`);
  // Picking a parent does not bless its children, nor the other way round.
  assert.equal(syncRootRefusal(`${HOME}/Documents/work`, deps(picked)), NOT_PICKED_MESSAGE);
  assert.equal(syncRootRefusal(`${HOME}/Doc`, deps(picked)), NOT_PICKED_MESSAGE);
});

test("credential, autostart, home and root folders are refused even when picked", () => {
  const picked = new PickedFolders("linux");
  for (const p of [
    `${HOME}/.ssh`, `${HOME}/.ssh/keys`, `${HOME}/.gnupg`, `${HOME}/.aws`, `${HOME}/.config`,
    `${HOME}/.config/autostart`, `${HOME}/.kube`, `${HOME}/.docker`, HOME, "/home", "/",
  ]) {
    picked.remember(p);
    const refusal = syncRootRefusal(p, deps(picked));
    assert.ok(refusal && refusal !== NOT_PICKED_MESSAGE, p);
  }
});

test("a symlink to a credential folder is refused by its real path", () => {
  const picked = new PickedFolders("linux");
  picked.remember(`${HOME}/innocent`);
  const realpath = (p: string) => (p === `${HOME}/innocent` ? `${HOME}/.ssh` : p);
  const refusal = syncRootRefusal(`${HOME}/innocent`, deps(picked, realpath));
  assert.ok(refusal && refusal !== NOT_PICKED_MESSAGE);
});

test("macOS temp folders survive the real-path check (/var -> /private/var)", () => {
  const picked = new PickedFolders("darwin");
  const p = "/var/folders/3b/x/T/dosya-e2e/photos";
  picked.remember(p);
  const realpath = (q: string) => (q.startsWith("/var/") ? `/private${q}` : q);
  const refusal = syncRootRefusal(p, { picked, platform: "darwin", home: "/Users/firat", tmpDir: "/var/folders/3b/x/T", realpath });
  assert.equal(refusal, null);
});

test("shape checks still hold: non-strings and relative paths", () => {
  const picked = new PickedFolders("linux");
  assert.match(syncRootRefusal(undefined, deps(picked))!, /non-empty string/);
  assert.match(syncRootRefusal("relative/path", deps(picked))!, /absolute/);
});

test("macOS and Windows compare picked paths case-insensitively; Linux does not", () => {
  const mac = new PickedFolders("darwin");
  mac.remember("/Users/Firat/Projects");
  assert.equal(mac.has("/users/firat/projects"), true);
  const linux = new PickedFolders("linux");
  linux.remember("/home/firat/Projects");
  assert.equal(linux.has("/home/firat/projects"), false);
  assert.equal(linux.has(42), false);
});

test("sync:save-config keeps global settings only - never pairs or userId", () => {
  const out = pickRendererConfig({
    globalPollIntervalMs: 30000,
    maxConcurrentTransfers: 3,
    maxUploadBytesPerSec: 0,
    maxDownloadBytesPerSec: 0,
    pauseOnBattery: true,
    pairs: [{ localPath: `${HOME}/.ssh` }],
    userId: "u_evil",
    pausedGlobally: true,
  });
  assert.deepEqual(out, {
    globalPollIntervalMs: 30000,
    maxConcurrentTransfers: 3,
    maxUploadBytesPerSec: 0,
    maxDownloadBytesPerSec: 0,
    pauseOnBattery: true,
  });
});
