#!/usr/bin/env node
// Builds the macOS File Provider extension as a bundle, without an Xcode
// project. An .appex is an Info.plist plus an executable whose entry point is
// Foundation's NSExtensionMain, so swiftc and lipo are enough.
//
// The sources are the same ones `swift test` covers
// (native/macos/DosyaFileProvider); they are compiled INTO the extension rather
// than linked as a library, which is why nothing in them needs to be public.
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = join(here, "..", "native", "macos", "DosyaFileProvider");
const sources = join(packageRoot, "Sources", "DosyaFileProviderCore");
const plistTemplate = join(packageRoot, "AppExtension", "Info.plist");

const NAME = "DosyaFileProvider";
/** Matches the app's LSMinimumSystemVersion; a higher floor would mean the
 *  extension silently never loads on a Mac where the app runs fine. */
const DEPLOYMENT_TARGET = "12.0";

/**
 * The keychain group, read from the Swift rather than restated here. The
 * extension resolves whichever entitled group ends in this suffix, so a
 * mismatch between the two means it reads a different item than the app writes.
 */
export function accessGroupSuffix() {
  const swift = readFileSync(join(sources, "Session.swift"), "utf8");
  const match = swift.match(/accessGroupSuffix\s*=\s*"([^"]+)"/);
  if (!match) throw new Error("Session.swift no longer declares accessGroupSuffix");
  return match[1];
}

/**
 * The Apple team id, needed because `codesign --entitlements` performs no
 * variable substitution: an unexpanded $(AppIdentifierPrefix) would be written
 * into the signature verbatim. Taken from the environment, or from the trailing
 * (TEAMID) of a signing identity.
 */
export function resolveTeamId({ identity, env = process.env } = {}) {
  if (env.APPLE_TEAM_ID) return env.APPLE_TEAM_ID;
  const fromIdentity = identity?.match(/\(([A-Z0-9]{10})\)\s*$/);
  return fromIdentity ? fromIdentity[1] : null;
}

/** Every .swift under the sources, including any added in a subdirectory. */
function swiftSources() {
  return readdirSync(sources, { recursive: true })
    .filter((f) => String(f).endsWith(".swift"))
    .map((f) => join(sources, String(f)));
}

export function buildFileProvider({ outDir, arches = ["arm64", "x86_64"], version = "0.0.0" } = {}) {
  if (process.platform !== "darwin") {
    console.log("[file-provider] not macOS, skipping");
    return null;
  }
  try {
    execFileSync("xcrun", ["--find", "swiftc"], { stdio: "ignore" });
  } catch {
    console.log("[file-provider] no Xcode toolchain, skipping");
    return null;
  }

  const files = swiftSources();
  const work = join(outDir, ".file-provider-build");
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });

  const slices = arches.map((arch) => {
    const output = join(work, `${NAME}-${arch}`);
    execFileSync("xcrun", [
      "swiftc",
      "-target", `${arch}-apple-macos${DEPLOYMENT_TARGET}`,
      // Matches Package.swift: these sources are a copy of the iOS extension
      // and carry one construct Swift 6 rejects.
      "-swift-version", "5",
      // What Xcode passes for every app extension target: it restricts the API
      // surface the compiler will accept. Measured on Xcode 26.3, neither this
      // nor the matching linker flag sets MH_APP_EXTENSION_SAFE in the Mach-O
      // header, so do not add `-Xlinker -application_extension` expecting it to:
      // it is inert here. The bit matters for frameworks linked INTO an
      // extension, and this executable embeds none.
      "-application-extension",
      "-O",
      "-module-name", NAME,
      // An app extension has no main() of its own; the linker points the
      // executable at Foundation's NSExtensionMain instead.
      "-Xlinker", "-e", "-Xlinker", "_NSExtensionMain",
      "-o", output,
      ...files,
    ], { stdio: "inherit" });
    return output;
  });

  const appex = join(outDir, `${NAME}.appex`);
  rmSync(appex, { recursive: true, force: true });
  mkdirSync(join(appex, "Contents", "MacOS"), { recursive: true });
  execFileSync("lipo", ["-create", ...slices, "-output", join(appex, "Contents", "MacOS", NAME)]);

  // The plist is a template: the version is stamped from the app's.
  const plist = readFileSync(plistTemplate, "utf8").replaceAll("__VERSION__", version);
  writeFileSync(join(appex, "Contents", "Info.plist"), plist);

  rmSync(work, { recursive: true, force: true });
  console.log(`[file-provider] built ${appex} (${arches.join(", ")}, version ${version})`);
  return appex;
}

/**
 * The entitlements to sign with, written into `outDir` with the team id filled
 * in. Returns null when the team id is unknown, which is the caller's signal
 * that it must not sign.
 */
export function materializeEntitlements({ outDir, teamId }) {
  if (!teamId) return null;
  const template = readFileSync(join(here, "..", "build", "entitlements.fileprovider.plist"), "utf8");
  const filled = template.replaceAll("__TEAM_ID__", teamId);
  // Comments are stripped before the check: the template explains in prose why
  // $(AppIdentifierPrefix) is NOT used, and that sentence is not a value.
  const values = filled.replace(/<!--[\s\S]*?-->/g, "");
  if (values.includes("__TEAM_ID__") || values.includes("$(")) {
    throw new Error("entitlements still carry an unexpanded placeholder");
  }
  // Comments are removed, not just ignored: codesign hands entitlements to
  // AMFI, whose XML parser rejects them outright with "syntax error near line N".
  const path = join(outDir, "entitlements.fileprovider.resolved.plist");
  writeFileSync(path, filled.replace(/^\s*<!--[\s\S]*?-->\s*$/gm, "").replace(/\n{3,}/g, "\n"));
  return path;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const out = process.argv[2] ?? join(here, "..", "out");
  mkdirSync(out, { recursive: true });
  buildFileProvider({ outDir: out });
}
