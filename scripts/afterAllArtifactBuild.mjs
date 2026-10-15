// electron-builder afterAllArtifactBuild: on the Mac App Store target, refuse a
// bundle App Store Connect would refuse.
//
// This is NOT an afterSign hook, and it cannot be: app-builder-lib packs the mas
// targets with `{ sign: false }` and signs them through signMas() instead
// (macPackager.js packMasTargets), a path that never emits afterSign. An
// afterSign hook therefore fires only for the dmg/zip target, where there is no
// store bundle to look at, so the check would never run for the one target it
// exists for. afterAllArtifactBuild runs once at the very end of the build, with
// the signed .app on disk beside the .pkg that was made from it.
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { verifyStoreBundle } from "./verify-store-bundle.mjs";

/** electron-builder.yml `productName`, which is what the .app on disk is called. */
const APP_FILENAME = "dosya.app";

function defaultReadDir(dir) {
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name);
}

/**
 * The store app to verify, or null when this build produced no store package.
 *
 * Pure apart from the two injected filesystem seams, so the path logic is
 * testable without a two-hour universal build. A `.pkg` among the artifacts is
 * what identifies a store build: it is the only target that produces one, and
 * the hook sees no electronPlatformName of its own.
 *
 * electron-builder puts a mas target's output in `<outDir>/<target name><arch
 * suffix>`, so the universal store build lands in `mas-universal`. The listing
 * fallback covers `mas-dev` and any single-arch pass. When nothing is found the
 * expected path is returned anyway: a package exists, so the verifier must run
 * and say what is missing rather than the hook passing an unverified bundle.
 */
export function storeAppPathFromArtifacts({
  artifactPaths = [],
  outDir,
  exists = existsSync,
  readDir = defaultReadDir,
  appName = APP_FILENAME,
}) {
  if (!artifactPaths.some((p) => typeof p === "string" && p.toLowerCase().endsWith(".pkg"))) return null;

  const expected = join(outDir, "mas-universal", appName);
  if (exists(expected)) return expected;

  let entries = [];
  try {
    entries = readDir(outDir);
  } catch {
    entries = [];
  }
  for (const entry of entries) {
    if (!String(entry).startsWith("mas")) continue;
    const candidate = join(outDir, String(entry), appName);
    if (exists(candidate)) return candidate;
  }
  return expected;
}

export default async function afterAllArtifactBuild(result) {
  const appPath = storeAppPathFromArtifacts({ artifactPaths: result.artifactPaths, outDir: result.outDir });
  if (!appPath) return [];

  const problems = verifyStoreBundle({ appPath });
  if (problems.length > 0) {
    throw new Error(`[store-bundle] the signed store bundle is not acceptable:\n  - ${problems.join("\n  - ")}`);
  }
  console.log(`[store-bundle] verified ${appPath}: sandboxed, store identifiers, matching versions, profiles embedded`);
  // Adds no artifacts of its own; electron-builder publishes whatever is returned.
  return [];
}
