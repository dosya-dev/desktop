import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The release workflow is the only place the store channel actually runs, so
 * the steps that cannot be exercised locally are pinned here instead. Plain
 * text assertions: parsing the YAML would prove the file is well-formed but
 * not that the one line that matters is still in the right step.
 */
const workflow = readFileSync(
  join(import.meta.dirname, "..", "..", "..", "..", ".github", "workflows", "desktop-release.yml"),
  "utf8",
);

/** The body of one `- name: X` step, up to the next step at the same indent. */
function step(name: string): string {
  const start = workflow.indexOf(`      - name: ${name}`);
  assert.notEqual(start, -1, `the workflow has no step named "${name}"`);
  const next = workflow.indexOf("\n      - name: ", start + 1);
  return workflow.slice(start, next === -1 ? undefined : next);
}

test("the store build verifies the bundle before it hands the .pkg on", () => {
  // electron-builder's own hook runs this too, but that hook is the thing most
  // likely to stop firing (it already did once: afterSign is never emitted for
  // the mas target). An explicit CLI call in the job is the check that cannot
  // be silently skipped by a packaging change.
  const build = step("Build and sign the Mac App Store package");
  assert.match(build, /node scripts\/verify-store-bundle-cli\.mjs "\$APP"/);
  // Before the signature check, so a bundle App Store Connect would reject
  // never reaches the upload step.
  assert.ok(
    build.indexOf("verify-store-bundle-cli.mjs") < build.indexOf("pkgutil --check-signature"),
    "the bundle check belongs before pkgutil, not after it",
  );
});

test("CFBundleVersion is set as one integer, not appended to the marketing version", () => {
  // Apple documents CFBundleVersion as up to three period-separated integers;
  // BUILD_NUMBER appended a fourth to X.Y.Z.
  const build = step("Build and sign the Mac App Store package");
  assert.match(build, /BUILD_VERSION_INPUT=\$\(\( GITHUB_RUN_NUMBER \* 100 \+ GITHUB_RUN_ATTEMPT \)\)/);
  assert.match(build, /-c\.buildVersion="\$BUILD_VERSION_INPUT"/);
  assert.doesNotMatch(build, /export BUILD_NUMBER=/);
});

test("the .pkg is kept even when the build failed after producing it", () => {
  const keep = step("Keep the .pkg as a workflow artifact");
  assert.match(keep, /if: "!cancelled\(\) && env\.SKIP_MAS != 'true'"/);
  assert.match(keep, /if-no-files-found: warn/);
});

test("the store job is time-bounded", () => {
  // fastlane waits for App Store Connect to process the build; without a bound
  // a stalled queue holds the manifest job for GitHub's six-hour default.
  const job = workflow.slice(workflow.indexOf("  build-mac-app-store:"), workflow.indexOf("  build-windows:"));
  assert.match(job, /^    timeout-minutes: 90$/m);
});
