import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { storeAppPathFromArtifacts } from "./afterAllArtifactBuild.mjs";

const OUT = "/tmp/release";

test("a .pkg artifact resolves to the mas-universal app", () => {
  const appPath = storeAppPathFromArtifacts({
    artifactPaths: [join(OUT, "mas-universal", "dosya-3.0.10-universal.pkg")],
    outDir: OUT,
    exists: (p) => p === join(OUT, "mas-universal", "dosya.app"),
    readDir: () => ["mas-universal"],
  });
  assert.equal(appPath, join(OUT, "mas-universal", "dosya.app"));
});

test("a build with no .pkg is not a store build and resolves to nothing", () => {
  const appPath = storeAppPathFromArtifacts({
    artifactPaths: [join(OUT, "dosya-3.0.10-universal.dmg"), join(OUT, "dosya-3.0.10-universal-mac.zip")],
    outDir: OUT,
    exists: () => true,
    readDir: () => ["mac-universal"],
  });
  assert.equal(appPath, null);
});

test("falls back to whichever mas* directory holds the app", () => {
  // `--mac mas-dev`, or a single-arch pass, names the directory something else.
  const appPath = storeAppPathFromArtifacts({
    artifactPaths: [join(OUT, "mas-dev-universal", "dosya-3.0.10-universal.pkg")],
    outDir: OUT,
    exists: (p) => p === join(OUT, "mas-dev-universal", "dosya.app"),
    readDir: () => ["mac-universal", "mas-dev-universal"],
  });
  assert.equal(appPath, join(OUT, "mas-dev-universal", "dosya.app"));
});

test("a .pkg with no app on disk still names the path, so the verifier fails the build", () => {
  // Fail-closed: a package was produced, so something must be verified. Naming
  // the expected path makes the verifier's problems point at the real miss
  // instead of the hook silently passing an unverified bundle to the store.
  const appPath = storeAppPathFromArtifacts({
    artifactPaths: [join(OUT, "dosya-3.0.10-universal.pkg")],
    outDir: OUT,
    exists: () => false,
    readDir: () => [],
  });
  assert.equal(appPath, join(OUT, "mas-universal", "dosya.app"));
});

test("a directory listing that cannot be read is not fatal", () => {
  const appPath = storeAppPathFromArtifacts({
    artifactPaths: [join(OUT, "dosya-3.0.10-universal.pkg")],
    outDir: OUT,
    exists: () => false,
    readDir: () => {
      throw new Error("ENOENT");
    },
  });
  assert.equal(appPath, join(OUT, "mas-universal", "dosya.app"));
});
