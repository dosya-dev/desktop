import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { armQuitWatchdog, installDownloadedUpdate } from "./update-install.ts";

/**
 * "Restart and install" on macOS did nothing visible: Electron's
 * quitAndInstall() closes every window BEFORE emitting before-quit, and the
 * main window's close handler - seeing no quit in progress - hid it to the
 * tray instead. No window ever closed, so the app never quit and the update
 * never installed. Marking the quit first is what lets the windows close.
 */

function recorder() {
  const calls: string[] = [];
  return {
    calls,
    deps: {
      announceInstalling: () => calls.push("announceInstalling"),
      markQuitting: () => calls.push("markQuitting"),
      quitAndInstall: () => calls.push("quitAndInstall"),
      showDownloadedFile: () => calls.push("showDownloadedFile"),
    },
  };
}

for (const platform of ["darwin", "win32"] as const) {
  test(`on ${platform} the quit is marked before quitAndInstall closes the windows`, () => {
    const { calls, deps } = recorder();
    installDownloadedUpdate(platform, deps);
    assert.equal(calls.indexOf("markQuitting") < calls.indexOf("quitAndInstall"), true);
    assert.equal(calls.at(-1), "quitAndInstall");
  });
}

test("on Linux the downloaded AppImage is shown and the app keeps running", () => {
  const { calls, deps } = recorder();
  installDownloadedUpdate("linux", deps);
  assert.deepEqual(calls, ["showDownloadedFile"]);
});

// The other doors into quitAndInstall (electron-updater calls the native one
// itself) bypass installDownloadedUpdate, so the native event must mark the
// quit too.
test("the updater marks the quit on Electron's before-quit-for-update", () => {
  const src = readFileSync(new URL("./updater.ts", import.meta.url), "utf8");
  assert.match(src, /\.on\(\s*"before-quit-for-update"\s*,\s*markQuitting\s*\)/);
  assert.match(src, /installDownloadedUpdate\(/);
});

// ── "Installing…" state ─────────────────────────────────────────────
// Between the click and the relaunch the app is silent for 10-15 s even when
// everything works. The renderer must be told the install has begun BEFORE
// the windows start closing, so it can show a "reopening in a moment" line
// instead of a button that looks ignored.

for (const platform of ["darwin", "win32"] as const) {
  test(`on ${platform} the install is announced before the quit begins`, () => {
    const { calls, deps } = recorder();
    installDownloadedUpdate(platform, deps);
    assert.deepEqual(calls, ["announceInstalling", "markQuitting", "quitAndInstall"]);
  });
}

test("on Linux nothing is announced - the app keeps running", () => {
  const { calls, deps } = recorder();
  installDownloadedUpdate("linux", deps);
  assert.deepEqual(calls, ["showDownloadedFile"]);
});

// ── Quit watchdog ───────────────────────────────────────────────────
// Electron's quitAndInstall() waits until every window has closed. On 3.1.2
// the close handler hid the window instead, and the only thing that ever
// closed it was the memory reclaimer, five minutes later - the "Restart and
// install takes 10 minutes" report. The fix marks the quit first; this is the
// backstop for any future regression of that kind: a window that is still
// open a while after the quit began gets destroyed so the install proceeds.

function fakeClock() {
  const timers: { fn: () => void; ms: number; cancelled: boolean }[] = [];
  return {
    timers,
    schedule: (fn: () => void, ms: number) => {
      const t = { fn, ms, cancelled: false };
      timers.push(t);
      return t;
    },
    cancel: (handle: unknown) => { (handle as { cancelled: boolean }).cancelled = true; },
    fire: () => { for (const t of timers) if (!t.cancelled) t.fn(); },
  };
}

test("the watchdog destroys windows that are still open when it fires", () => {
  const clock = fakeClock();
  let destroyed = 0;
  armQuitWatchdog({
    timeoutMs: 15_000,
    hasWindows: () => true,
    destroyWindows: () => { destroyed += 1; },
    schedule: clock.schedule,
    cancel: clock.cancel,
  });
  assert.equal(clock.timers.length, 1);
  assert.equal(clock.timers[0].ms, 15_000);
  assert.equal(destroyed, 0, "nothing happens before the timeout");
  clock.fire();
  assert.equal(destroyed, 1);
});

test("the watchdog leaves a quit that already closed its windows alone", () => {
  const clock = fakeClock();
  let destroyed = 0;
  armQuitWatchdog({
    timeoutMs: 15_000,
    hasWindows: () => false,
    destroyWindows: () => { destroyed += 1; },
    schedule: clock.schedule,
    cancel: clock.cancel,
  });
  clock.fire();
  assert.equal(destroyed, 0);
});

test("arming the watchdog twice keeps one timer", () => {
  const clock = fakeClock();
  const opts = {
    timeoutMs: 15_000,
    hasWindows: () => true,
    destroyWindows: () => {},
    schedule: clock.schedule,
    cancel: clock.cancel,
  };
  const first = armQuitWatchdog(opts);
  first.rearm();
  assert.equal(clock.timers.filter((t) => !t.cancelled).length, 1);
});

test("the updater arms the watchdog and announces the install on before-quit-for-update", () => {
  const src = readFileSync(new URL("./updater.ts", import.meta.url), "utf8");
  assert.match(src, /armQuitWatchdog\(/);
  assert.match(src, /state:\s*"installing"/);
});
