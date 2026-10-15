import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, sep } from "node:path";

/**
 * Run with `npm run test:unit` - Node's own test runner, no Electron. This
 * file reads source as plain TEXT and has no import graph, which is why it
 * stays here while its sibling ipc-sender.test.ts runs on vitest.
 *
 * Every IPC channel in the main process must be registered through the gate in
 * ipc-sender.ts (`handle`/`on` from `makeIpcGate`), never through `ipcMain`
 * directly, so each one refuses a message that did not come from the app's own
 * top-level renderer (S-1).
 *
 * That was a 74-call-site mechanical change with no way to prove it is
 * complete, and a missed site is a silently ungated channel - it keeps working
 * exactly as before, so no other test and no amount of clicking will ever show
 * it. This DISCOVERS every file under src/main that registers a channel rather
 * than naming them: the first version of this test carried an explicit list,
 * and updater.ts's 8 channels slipped past it for exactly that reason. A new
 * file that registers a channel and forgets the gate now fails immediately,
 * and nobody has to remember to update a list.
 */

const MAIN_DIR = import.meta.dirname;

/**
 * The gate's own definition. It is the one place `ipcMain.handle`/`.on` are
 * legitimately named - in its doc comments, and as the `IpcRegistrar` type it
 * is handed - so it cannot be held to the rule it defines.
 */
const GATE_MODULE = "ipc-sender.ts";

/** Every non-test .ts source file under src/main, as paths relative to it. */
function mainSources(): string[] {
  return readdirSync(MAIN_DIR, { recursive: true, encoding: "utf8" })
    .map((p) => String(p))
    .filter((p) => p.endsWith(".ts") && !p.endsWith(".test.ts"))
    .filter((p) => p.split(sep).join("/") !== GATE_MODULE)
    .map((p) => p.split(sep).join("/"))
    .sort();
}

/**
 * Drop comments before scanning, so prose that mentions `ipcMain.handle(`
 * - including the notes explaining why the gate exists - cannot fail the test.
 * Only whole comment lines are stripped, never a mid-line `//`, so a URL
 * inside a string literal can never swallow real code after it.
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, " "))
    .split("\n")
    .map((line) => {
      const t = line.trimStart();
      return t.startsWith("//") || t.startsWith("*") ? "" : line;
    })
    .join("\n");
}

/**
 * Every registering method on `ipcMain`, longest name first so the
 * alternation cannot match a prefix and then fail on the `(`.
 *
 * `handleOnce` is spelled out because leaving it to `handle` does not work:
 * the alternation would match "handle", then require `\s*\(`, find the "O" of
 * "Once", and give up - so `ipcMain.handleOnce(...)` read as gated when it
 * was not. It would also have passed the whole-file fallback check below,
 * because the files that could plausibly contain one (`ipc.ts`, `index.ts`)
 * already name `ipcMain` AND call `makeIpcGate`.
 *
 * Note `makeIpcGate` deliberately exposes no `once`/`handleOnce`: if one is
 * ever needed, this test going red is the intended way to force that
 * conversation rather than a bare registration slipping through.
 */
const REGISTRATION = /\bipcMain\s*\.\s*(handleOnce|handle|once|on)\s*\(/g;

/**
 * `file:line: text` for every bare ipcMain registration in `code`.
 *
 * Matched against the whole file, not line by line: `\s` spans newlines, so
 * a registration written as
 *
 *     ipcMain
 *       .handle("channel", ...)
 *
 * is a single registration that a per-line scan cannot see at all.
 */
function bareRegistrations(rel: string, code: string): string[] {
  const lines = code.split("\n");
  // Index of the first character of each line, so a match offset can be
  // turned into a line number without re-splitting per match.
  const lineStarts: number[] = [];
  let at = 0;
  for (const line of lines) {
    lineStarts.push(at);
    at += line.length + 1;
  }

  const hits: string[] = [];
  for (const m of code.matchAll(REGISTRATION)) {
    const offset = m.index ?? 0;
    let lineIndex = lineStarts.findIndex((start) => start > offset) - 1;
    if (lineIndex < 0) lineIndex = lines.length - 1;
    hits.push(`src/main/${rel}:${lineIndex + 1}: ${lines[lineIndex].trim()}`);
  }
  return hits;
}

const sources = mainSources().map((rel) => ({
  rel,
  code: stripComments(readFileSync(join(MAIN_DIR, rel), "utf8")),
}));

test("the scan actually reaches the main-process sources", () => {
  // Without this, a broken walk would make every check below pass vacuously -
  // which is the failure mode of a guard nobody would notice.
  assert.ok(sources.length > 40, `only ${sources.length} source files discovered under src/main - the walk is broken`);
  for (const expected of ["ipc.ts", "index.ts", "updater.ts", "sync/ipc-handlers.ts"]) {
    assert.ok(
      sources.some((s) => s.rel === expected),
      `src/main/${expected} was not discovered by the walk - the walk is broken`,
    );
  }
});

test("every IPC channel in src/main is registered through the gate, not bare ipcMain", () => {
  const hits = sources.flatMap(({ rel, code }) => bareRegistrations(rel, code));
  const files = [...new Set(hits.map((h) => h.split(":")[0]))];
  assert.equal(
    hits.length,
    0,
    `${hits.length} IPC channel(s) in ${files.length} file(s) are registered on bare ipcMain and are NOT ` +
      `sender-validated:\n` +
      hits.map((h) => `  ${h}`).join("\n") +
      `\nUse the gate: \`const gate = makeIpcGate(ipcMain, rendererOrigin({ isPackaged: app.isPackaged, ` +
      `devServerUrl: process.env.ELECTRON_RENDERER_URL }))\` from ./ipc-sender, then \`gate.handle(...)\` / ` +
      `\`gate.on(...)\` - or take an \`IpcGate\` as a parameter, the way updater.ts does. See ipc-sender.ts ` +
      `for why (S-1).`,
  );
});

test("a file that touches ipcMain at all does so only to build the gate", () => {
  // The complement of the check above: zero bare registrations because
  // somebody deleted the gate and its handlers with it would otherwise pass
  // silently. Any file still naming `ipcMain` must hand it to makeIpcGate.
  const offenders = sources
    .filter(({ code }) => /\bipcMain\b/.test(code) && !/\bmakeIpcGate\s*\(/.test(code))
    .map(({ rel }) => `src/main/${rel}`);
  assert.deepEqual(
    offenders,
    [],
    `these files reference ipcMain without building the gate, so their IPC channels have lost their sender ` +
      `validation (S-1):\n` + offenders.map((f) => `  ${f}`).join("\n"),
  );
});

test("the gate is still wired up where the channels are registered", () => {
  // Belt and braces for the three registrars that build their own gate.
  for (const rel of ["ipc.ts", "sync/ipc-handlers.ts", "index.ts"]) {
    const found = sources.find((s) => s.rel === rel);
    assert.ok(found, `src/main/${rel} not found`);
    assert.match(
      found.code,
      /makeIpcGate\s*\(/,
      `src/main/${rel}: no makeIpcGate(...) call. Its IPC channels have lost their sender validation (S-1).`,
    );
  }
  // updater.ts takes the gate as a parameter instead of building one, so it
  // must never reach for ipcMain - which the two checks above already assert -
  // and must route its registrations through that parameter.
  const updater = sources.find((s) => s.rel === "updater.ts");
  assert.ok(updater, "src/main/updater.ts not found");
  assert.match(
    updater.code,
    /gate\.handle\s*\(/,
    "src/main/updater.ts: no gate.handle(...) call. Its 8 update channels have lost their sender validation (S-1).",
  );
});
