import { test } from "node:test";
import assert from "node:assert/strict";
import {
  collectDesktopDiagnostics, composeBody, diagnosticsRows, summariseSync, redactPaths,
  BODY_MAX, DIAGNOSTICS_STRING_MAX,
} from "./bug-report.ts";

const INFO = { version: "3.0.11", distribution: "direct", arch: "arm64", platform: "macOS 24.6.0", locale: "en-GB" };

test("collectDesktopDiagnostics builds the v1 desktop document", () => {
  const d = collectDesktopDiagnostics({
    info: INFO, sync: "2 folders · 1 in error · 3 files failed", workspaceId: "ws_1",
    page: "/sync?localPath=%2FUsers%2Fx", errorRef: "evt_1", errorMessage: "boom", now: 1_760_000_000,
  });
  assert.deepEqual(d, {
    v: 1, client: "desktop", app_version: "3.0.11", build: "direct arm64", platform: "macOS 24.6.0", locale: "en-GB",
    workspace_id: "ws_1", page: "/sync", error_ref: "evt_1", error_message: "boom",
    extra: { Sync: "2 folders · 1 in error · 3 files failed" }, captured_at: 1_760_000_000,
  });
});

test("collectDesktopDiagnostics copes with no info, no sync and empty strings", () => {
  const d = collectDesktopDiagnostics({ info: null, sync: null, workspaceId: "", page: null, errorRef: undefined as unknown as null, errorMessage: "", now: 1 });
  assert.equal(d.app_version, "unknown");
  assert.equal(d.build, null);
  assert.equal(d.platform, "unknown");
  assert.equal(d.locale, null);
  assert.equal(d.workspace_id, null);
  assert.equal(d.page, null);
  assert.equal(d.error_ref, null);
  assert.equal(d.error_message, null);
  assert.deepEqual(d.extra, {});
  assert.ok(!JSON.stringify(d).includes("undefined"));
});

test("summariseSync counts folders, errors and failed files and notes a global pause", () => {
  assert.equal(summariseSync(null), null);
  assert.equal(summariseSync({ pairs: [], globalPaused: false }), "no folders");
  assert.equal(summariseSync({ pairs: [{ status: "idle", fileErrorCount: 0 }, { status: "error", fileErrorCount: 3 }], globalPaused: false }), "2 folders · 1 in error · 3 files failed");
  assert.equal(summariseSync({ pairs: [{ status: "idle", fileErrorCount: 0 }], globalPaused: true }), "1 folder · paused");
  assert.equal(summariseSync({ pairs: [], globalPaused: true }), "no folders · paused");
});

test("diagnosticsRows labels the id Error reference, skips empty rows and never names the vendor", () => {
  const rows = diagnosticsRows(collectDesktopDiagnostics({ info: INFO, sync: null, workspaceId: null, page: "/files", errorRef: "evt_9", errorMessage: null, now: 1 }));
  const labels = rows.map((r) => r.label);
  assert.ok(labels.includes("Error reference"));
  assert.ok(labels.includes("App"));
  assert.ok(labels.includes("System"));
  assert.ok(!labels.includes("Workspace"));
  assert.ok(!labels.includes("Sync"));
  assert.equal(rows.find((r) => r.label === "Error reference")?.value, "evt_9");
  assert.ok(!JSON.stringify(rows).toLowerCase().includes("sentry"));
});

test("composeBody appends the log under a marker and keeps the user's text whole when the tail is long", () => {
  const text = "The Clients folder has said Preparing for an hour.";
  const tail = Array.from({ length: 200 }, (_, i) => `2026-10-03T09:00:${String(i % 60).padStart(2, "0")} ${"z".repeat(480)}`).join("\n");
  const body = composeBody(text, tail, 200);
  assert.ok(body.startsWith(text + "\n\n--- Recent log (last 200 lines) ---\n"));
  assert.ok(body.length <= BODY_MAX, `body is ${body.length}`);
  // Cut from the START of the tail, so the newest lines survive.
  assert.ok(body.endsWith(tail.slice(-100)));
});

test("composeBody without a log is just the text, and an empty tail adds nothing", () => {
  assert.equal(composeBody("hi", null, 200), "hi");
  assert.equal(composeBody("hi", "", 200), "hi");
  assert.equal(composeBody("  hi  ", null, 200), "hi");
});

test("composeBody clamps oversized user text so the body never exceeds BODY_MAX", () => {
  const text = "a".repeat(12_000);
  const tail = "2026-10-03T09:00:00 log line\n".repeat(50);
  const body = composeBody(text, tail, 200);
  assert.equal(body.length, BODY_MAX);
  assert.equal(body, text.slice(0, BODY_MAX));
  assert.ok(!body.includes("--- Recent log"));
});

test("composeBody returns the text alone when there is no room left for the marker", () => {
  const text = "b".repeat(9_490);
  const tail = "2026-10-03T09:00:00 log line\n".repeat(50);
  const body = composeBody(text, tail, 200);
  assert.equal(body, text);
  assert.equal(body.length, 9_490);
});

test("redactPaths replaces a macOS home path and keeps the words before it", () => {
  assert.equal(redactPaths("Sync folder not found: /Users/f/Work"), "Sync folder not found: <path>");
});

test("redactPaths replaces a Linux home path", () => {
  assert.equal(redactPaths("ENOENT: no such file, open '/home/alex/Documents/x.txt'"), "ENOENT: no such file, open '<path>'");
});

test("redactPaths replaces a Windows backslash path with any drive letter", () => {
  assert.equal(redactPaths("Sync folder not found: D:\\Users\\alex\\Work"), "Sync folder not found: <path>");
});

test("redactPaths replaces a Windows forward-slash path", () => {
  assert.equal(redactPaths("Sync folder not found: C:/Users/alex/Work"), "Sync folder not found: <path>");
});

test("redactPaths replaces a file:// URL through the next whitespace or quote", () => {
  // No quote or whitespace before the closing paren, so it rides along too;
  // the file:// rule only promises a stop at whitespace or a quote.
  assert.equal(
    redactPaths("Loading chunk 4 failed. (file:///C:/Users/alex/AppData/Local/dosya/app.asar/chunk.js)"),
    "Loading chunk 4 failed. (<path>",
  );
  assert.equal(redactPaths('at file:///Users/f/Code/app/main.js:10:4 in init'), "at <path> in init");
});

test("redactPaths replaces a quoted path inside an EPERM message", () => {
  assert.equal(
    redactPaths("EPERM: operation not permitted, open '/Users/f/Library/Caches/x'"),
    "EPERM: operation not permitted, open '<path>'",
  );
});

test("redactPaths leaves a message without a path unchanged", () => {
  assert.equal(redactPaths("Sync folder is paused"), "Sync folder is paused");
  assert.equal(redactPaths(""), "");
});

test("collectDesktopDiagnostics redacts a local path out of error_message", () => {
  const d = collectDesktopDiagnostics({
    info: INFO, sync: null, workspaceId: null, page: "/sync", errorRef: null,
    errorMessage: "Sync folder not found: /Users/f/Work", now: 1,
  });
  assert.equal(d.error_message, "Sync folder not found: <path>");
});

test("collectDesktopDiagnostics redacts paths out of extra values too", () => {
  const d = collectDesktopDiagnostics({
    info: INFO, sync: "Sync folder not found: /Users/f/Work", workspaceId: null, page: null,
    errorRef: null, errorMessage: null, now: 1,
  });
  assert.equal(d.extra.Sync, "Sync folder not found: <path>");
});

test("collectDesktopDiagnostics clamps every string field to DIAGNOSTICS_STRING_MAX", () => {
  const d = collectDesktopDiagnostics({
    info: INFO, sync: null, workspaceId: null, page: null, errorRef: null,
    errorMessage: "x".repeat(2_000), now: 1,
  });
  assert.equal(d.error_message?.length, DIAGNOSTICS_STRING_MAX);
  assert.equal(DIAGNOSTICS_STRING_MAX, 300);
});
