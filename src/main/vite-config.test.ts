import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Guards one thing the build cannot tell you it has lost.
 *
 * electron-vite 3.1.0 defaults `build.minify` to false for main, preload AND
 * renderer, and exposes no CLI flag for it, so a config that simply omits the
 * option produces a perfectly successful build of unminified sources - which
 * is what every channel shipped until DSK-001 was fixed. There is no error, no
 * warning, and the app works, so nothing else in the repo would notice.
 *
 * This reads the config as TEXT rather than importing it. Importing would
 * execute `react()`, `tailwindcss()` and the Sentry plugin factory, read
 * package.json and branch on SENTRY_AUTH_TOKEN - none of which this assertion
 * needs, all of which could fail for unrelated reasons and turn this into a
 * flaky test of the plugin chain. The same reasoning as
 * `ipc-gate-coverage.test.ts`, which reads source for the same kind of
 * whole-file invariant.
 *
 * The check is positional: each build block is identified by its own
 * `outDir`, and `minify` must appear between that outDir and the start of the
 * next one. So moving a `minify` line out of its block fails even though the
 * file still contains three of them.
 */
const CONFIG = join(import.meta.dirname, "../../electron.vite.config.ts");
const TARGETS = ["out/main", "out/preload", "out/renderer"] as const;

test("every electron-vite target sets build.minify", () => {
  const src = readFileSync(CONFIG, "utf8");

  const positions = TARGETS.map((t) => {
    const marker = `outDir: "${t}",`;
    const at = src.indexOf(marker);
    assert.notEqual(at, -1, `${CONFIG} no longer has a build block with ${marker}`);
    assert.equal(src.indexOf(marker, at + 1), -1, `${marker} appears more than once`);
    return { target: t, at };
  }).sort((a, b) => a.at - b.at);

  for (const [i, { target, at }] of positions.entries()) {
    const end = i + 1 < positions.length ? positions[i + 1].at : src.length;
    const block = src.slice(at, end);
    assert.match(
      block,
      /minify:\s*"esbuild"/,
      `the ${target} build block does not set minify: "esbuild". electron-vite's default is ` +
        `false for this target, so omitting it ships unminified sources (DSK-001).`,
    );
  }
});
