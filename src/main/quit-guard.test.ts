import { test } from "node:test";
import assert from "node:assert/strict";
import { createQuitGuard, quitDecision, type QuitGuardDeps } from "./quit-guard.ts";

/**
 * Run with `npm run test:unit`. The text editor keeps unsaved edits in the
 * renderer; closing the window only hides it, but quitting the app (Cmd+Q,
 * menu or tray Quit, "Restart and install") throws them away. Main asks the
 * renderer first - and must never wedge the quit doing so.
 */

const CLEAN = { editorDirty: false, confirmed: false, systemEnding: false };

test("a quit with nothing unsaved goes straight through, from every door", () => {
  for (const source of ["user", "update", "system"] as const) {
    assert.equal(quitDecision(CLEAN, source), "allow");
  }
});

test("unsaved edits make a user quit and an update restart ask first", () => {
  const dirty = { ...CLEAN, editorDirty: true };
  assert.equal(quitDecision(dirty, "user"), "ask");
  assert.equal(quitDecision(dirty, "update"), "ask");
});

test("OS shutdown or logout is never held up; the local draft covers the edits", () => {
  assert.equal(quitDecision({ ...CLEAN, editorDirty: true }, "system"), "allow");
  assert.equal(quitDecision({ ...CLEAN, editorDirty: true, systemEnding: true }, "user"), "allow");
});

test("once the user said Quit anyway, the quit is not asked about again", () => {
  assert.equal(quitDecision({ ...CLEAN, editorDirty: true, confirmed: true }, "user"), "allow");
  assert.equal(quitDecision({ ...CLEAN, editorDirty: true, confirmed: true }, "update"), "allow");
});

// ── The stateful guard ──────────────────────────────────────────

function harness(opts: { canPrompt?: boolean } = {}) {
  const calls: string[] = [];
  const timers: { fn: () => void; ms: number; cancelled: boolean }[] = [];
  const deps: QuitGuardDeps = {
    prompt: () => {
      calls.push("prompt");
      return opts.canPrompt ?? true;
    },
    onCancel: () => calls.push("cancel"),
    ackTimeoutMs: 5000,
    schedule: (fn, ms) => {
      const t = { fn, ms, cancelled: false };
      timers.push(t);
      return t;
    },
    cancel: (h) => {
      (h as { cancelled: boolean }).cancelled = true;
    },
  };
  const guard = createQuitGuard(deps);
  const fire = () => {
    for (const t of timers.filter((x) => !x.cancelled)) {
      t.cancelled = true;
      t.fn();
    }
  };
  return { guard, calls, timers, fire, quit: () => calls.push("quit"), install: () => calls.push("install") };
}

test("clean: request answers true and asks nobody", () => {
  const h = harness();
  assert.equal(h.guard.request("user", h.quit), true);
  assert.deepEqual(h.calls, []);
});

test("dirty: the quit is held, the renderer is asked, Quit anyway proceeds", () => {
  const h = harness();
  h.guard.setDirty(true);
  assert.equal(h.guard.request("user", h.quit), false);
  assert.deepEqual(h.calls, ["prompt"]);
  assert.equal(h.guard.isAsking(), true);
  h.guard.answer("shown");
  h.guard.answer("quit");
  assert.deepEqual(h.calls, ["prompt", "quit"]);
  assert.equal(h.guard.isAsking(), false);
  // The quit that follows (before-quit fires again) is not asked about.
  assert.equal(h.guard.request("user", h.quit), true);
});

test("dirty: Keep editing calls the quit off and runs nothing", () => {
  const h = harness();
  h.guard.setDirty(true);
  h.guard.request("user", h.quit);
  h.guard.answer("shown");
  h.guard.answer("cancel");
  assert.deepEqual(h.calls, ["prompt", "cancel"]);
  assert.equal(h.guard.isAsking(), false);
  // Still dirty: the next quit asks again.
  assert.equal(h.guard.request("user", h.quit), false);
});

test("the update restart is held the same way and resumes the install on Quit anyway", () => {
  const h = harness();
  h.guard.setDirty(true);
  assert.equal(h.guard.request("update", h.install), false);
  h.guard.answer("shown");
  h.guard.answer("quit");
  assert.deepEqual(h.calls, ["prompt", "install"]);
  // quitAndInstall's own before-quit then passes.
  assert.equal(h.guard.request("user", h.quit), true);
});

test("a renderer that never answers cannot wedge the quit", () => {
  const h = harness();
  h.guard.setDirty(true);
  h.guard.request("user", h.quit);
  assert.equal(h.timers[0]?.ms, 5000);
  h.fire();
  assert.deepEqual(h.calls, ["prompt", "quit"]);
});

test("once the dialog is up, the user takes as long as they like", () => {
  const h = harness();
  h.guard.setDirty(true);
  h.guard.request("user", h.quit);
  h.guard.answer("shown");
  h.fire();
  assert.deepEqual(h.calls, ["prompt"]);
});

test("no window to ask (reclaimed or gone): the quit proceeds", () => {
  const h = harness({ canPrompt: false });
  h.guard.setDirty(true);
  assert.equal(h.guard.request("user", h.quit), true);
  assert.equal(h.guard.isAsking(), false);
});

test("asking twice re-shows the dialog and keeps one pending quit, the latest", () => {
  const h = harness();
  h.guard.setDirty(true);
  h.guard.request("update", h.install);
  h.guard.request("user", h.quit);
  assert.deepEqual(h.calls, ["prompt", "prompt"]);
  h.guard.answer("quit");
  assert.deepEqual(h.calls, ["prompt", "prompt", "quit"]);
  assert.equal(h.timers.filter((t) => !t.cancelled).length, 0);
});

test("OS shutdown while the dialog is up lets the held quit go", () => {
  const h = harness();
  h.guard.setDirty(true);
  h.guard.request("user", h.quit);
  h.guard.answer("shown");
  h.guard.systemEnding();
  assert.deepEqual(h.calls, ["prompt", "quit"]);
  assert.equal(h.guard.request("user", h.quit), true);
});

test("the renderer going away (crash, reload, reclaim) clears the state and releases a held quit", () => {
  const h = harness();
  h.guard.setDirty(true);
  h.guard.request("user", h.quit);
  h.guard.rendererGone();
  assert.deepEqual(h.calls, ["prompt", "quit"]);
  const h2 = harness();
  h2.guard.setDirty(true);
  h2.guard.rendererGone();
  assert.equal(h2.guard.request("user", h2.quit), true);
});

test("a stray answer with no quit pending does nothing", () => {
  const h = harness();
  h.guard.setDirty(true);
  h.guard.answer("quit");
  h.guard.answer("cancel");
  assert.deepEqual(h.calls, []);
  assert.equal(h.guard.request("user", h.quit), false);
});

test("new edits after a Quit anyway that did not quit are asked about again", () => {
  const h = harness();
  h.guard.setDirty(true);
  h.guard.request("update", h.install);
  h.guard.answer("quit");
  h.guard.setDirty(true);
  assert.equal(h.guard.request("user", h.quit), false);
});
