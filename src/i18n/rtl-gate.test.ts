/**
 * RTL source gate. Every physical-direction utility or inline style in src/ is
 * either converted to its logical form, sits on a line (or under a line)
 * carrying `rtl-ok: <reason>` with an allowed reason. There is no ratchet:
 * the count is zero. The vendored reader tree is exempt.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// @ts-expect-error plain .mjs script without types
import { ALLOWED_REASONS, checkGate, markedLines, reasonError, scanTree } from "../../scripts/rtl-codemod.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = join(here, "../..");

function fixture(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "rtl-gate-"));
  for (const [name, text] of Object.entries(files)) {
    const path = join(root, "src", name);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, text);
  }
  return root;
}

test("fails an unmarked ml-2 naming file and line", () => {
  const root = fixture({ "a.tsx": 'const x = 1;\nexport const A = () => <div className="ml-2" />;\n' });
  const errors = checkGate(scanTree(root));
  assert.equal(errors.length, 1);
  assert.match(errors[0], /src\/a\.tsx:2/);
  assert.match(errors[0], /ml-2/);
});

test("passes with rtl-ok on the line or the line above", () => {
  const same = fixture({ "a.tsx": '<div className="ml-2" /> // rtl-ok: media timeline\n' });
  assert.deepEqual(checkGate(scanTree(same)), []);
  const above = fixture({ "a.tsx": '// rtl-ok: media timeline\n<div className="ml-2" />\n' });
  assert.deepEqual(checkGate(scanTree(above)), []);
});

test("counts inline style keys and textAlign as physical", () => {
  for (const body of ["{ paddingLeft: 4 }", "{ marginRight: 4 }", "{ left: 0 }", "{ right: 0 }", "{ textAlign: 'left' }"]) {
    const root = fixture({ "a.ts": `export const s = ${body};\n` });
    assert.equal(checkGate(scanTree(root)).length, 1, body);
  }
});

test("counts css padding-left and ignores logical properties", () => {
  const root = fixture({ "a.css": ".a { padding-left: 4px }\n", "b.css": ".b { padding-inline-start: 4px }\n" });
  assert.deepEqual(Object.keys(scanTree(root)), ["src/a.css"]);
});

test("scans css and ignores tests", () => {
  const root = fixture({ "a.css": ".a { margin-left: 4px }\n", "b.test.tsx": '<div className="ml-2" />\n', "c.test.ts": "const s = { left: 0 };\n" });
  assert.deepEqual(Object.keys(scanTree(root)), ["src/a.css"]);
});

test("every finding is an error", () => {
  const root = fixture({ "a.tsx": '<div className="ml-2 mr-2" />\n', "b.tsx": '<div className="pl-2" />\n' });
  assert.equal(checkGate(scanTree(root)).length, 3);
});

test("requires a reason after rtl-ok:", () => {
  const empty = fixture({ "a.tsx": '<div className="ml-2" /> // rtl-ok:\n' });
  assert.equal(checkGate(scanTree(empty)).length, 1);
  const blank = fixture({ "a.tsx": '<div className="ml-2" /> // rtl-ok:   \n' });
  assert.equal(checkGate(scanTree(blank)).length, 1);
});

test("ignores centering pairs and logical classes", () => {
  const root = fixture({ "a.tsx": '<div className="absolute left-1/2 -translate-x-1/2 ms-2 text-start" />\n' });
  assert.deepEqual(checkGate(scanTree(root)), []);
});

test("exempts the vendored reader tree and nothing else", () => {
  const root = fixture({
    "renderer/lib/reader/foliate-js/a.ts": "export const s = { left: 0 };\n",
    "renderer/lib/reader/reader-page/b.css": ".b { margin-left: 4px }\n",
    "renderer/lib/readerThemes.ts": "export const s = { left: 0 };\n",
    "renderer/lib/readers/c.tsx": '<div className="ml-2" />\n',
  });
  assert.deepEqual(Object.keys(scanTree(root)).sort(), ["src/renderer/lib/readerThemes.ts", "src/renderer/lib/readers/c.tsx"]);
});

test("main process inline styles count too", () => {
  const root = fixture({ "main/window.ts": "const css = { paddingLeft: 4 };\n" });
  assert.deepEqual(Object.keys(scanTree(root)), ["src/main/window.ts"]);
});

test("lists the allowed reasons", () => {
  assert.deepEqual(ALLOWED_REASONS, [
    "centering",
    "pointer coordinates",
    "canvas coordinates",
    "media timeline",
    "code",
    "map",
    "mirrored",
    "physical geometry",
    "rtl selector",
  ]);
});

test("accepts a reason that begins with an allowed one, as a whole word", () => {
  for (const r of ["media timeline", "media timeline, time runs left to right", "mirrored, rtl: counterpart on the same element", "code: a slot name", "Map marker", "physical geometry; symmetric triangle"]) {
    assert.equal(reasonError(r), null, r);
  }
});

test("rejects an unknown reason and a prefix that is part of a longer word", () => {
  for (const r of ["because I said so", "rtl: counterpart on the same element", "codec", "mapping", "centered"]) {
    assert.notEqual(reasonError(r), null, r);
  }
});

test("reads every marker with its reason from a fixture", () => {
  const root = fixture({ "a.tsx": '{/* rtl-ok: mirrored, a pair */}\n<div className="ml-2" /> // rtl-ok: media timeline\n' });
  assert.deepEqual(markedLines(root), [
    { file: "src/a.tsx", line: 1, reason: "mirrored, a pair" },
    { file: "src/a.tsx", line: 2, reason: "media timeline" },
  ]);
});

test("the installed Tailwind is 4.2 or newer and compiles the logical utilities", async () => {
  const req = createRequire(join(appRoot, "package.json"));
  const pkgJson = req.resolve("tailwindcss/package.json");
  const pkgDir = dirname(pkgJson);
  const [major, minor] = (JSON.parse(readFileSync(pkgJson, "utf8")).version as string).split(".").map(Number);
  assert.ok(major > 4 || (major === 4 && minor >= 2), `tailwindcss ${major}.${minor} is older than 4.2`);

  const mod = await import(req.resolve("tailwindcss"));
  const compile = mod.compile ?? mod.default?.compile;
  const sheets: Record<string, string> = {
    tailwindcss: "index.css",
    "tailwindcss/utilities": "utilities.css",
    "tailwindcss/theme": "theme.css",
    "tailwindcss/preflight": "preflight.css",
  };
  const compiler = await compile('@import "tailwindcss";', {
    base: pkgDir,
    loadStylesheet: async (id: string, _base: string) => ({
      content: readFileSync(join(pkgDir, sheets[id] ?? id), "utf8"),
      base: pkgDir,
      path: id,
    }),
  });
  const candidates = ["inset-s-0", "rounded-ss", "rtl:-scale-x-100"];
  const css: string = compiler.build(candidates);
  for (const c of candidates) {
    const selector = "." + c.replace(/[:/.]/g, (m) => "\\" + m);
    assert.ok(css.includes(selector), `${c} did not compile`);
  }
});

test("real source: no physical-direction use outside an rtl-ok line", () => {
  assert.deepEqual(checkGate(scanTree(appRoot)), []);
});

test("real source: every rtl-ok line has an allowed reason", () => {
  const marked = markedLines(appRoot) as Array<{ file: string; line: number; reason: string }>;
  const bad = marked.map((m) => ({ m, e: reasonError(m.reason) })).filter((x) => x.e);
  assert.deepEqual(bad.map((x) => `${x.m.file}:${x.m.line} ${x.e}`), []);
});

test("real source: the marked lines, for the reviewer", () => {
  const marked = markedLines(appRoot) as Array<{ file: string; line: number; reason: string }>;
  console.log(`# ${marked.length} rtl-ok lines`);
  for (const m of marked) console.log(`# ${m.file}:${m.line} ${m.reason}`);
  assert.ok(marked.length > 0);
});
