#!/usr/bin/env node
// Builds the Node addon the Electron main process loads to reach the shared
// keychain and NSFileProviderManager. Node can reach neither, and no other part
// of the bundle can either: the app's embedded provisioning profile authorizes
// the app's own code and nothing nested inside it, so a helper tool in
// Contents/MacOS is killed on launch (measured: SIGKILL, no output) and a
// nested bundle would need a profile, and so an App ID, of its own.
//
// Written in Swift and compiled together with the extension's Session.swift,
// which keeps the keychain contract one shared definition instead of a constant
// restated on both sides and silently drifting.
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = join(here, "..", "native", "macos", "DosyaFileProvider");
const coreSources = join(packageRoot, "Sources", "DosyaFileProviderCore");
const addonSources = join(packageRoot, "Sources", "DosyaFileProviderAddon");

/**
 * The file the addon shares with the extension. Listed rather than globbed: the
 * rest of the core is the extension's own runtime, which has no business being
 * compiled into the app's process.
 */
const SHARED_CORE = ["Session.swift"];
const ADDON = ["Napi.swift", "Addon.swift", "Domains.swift"];

/** What it is called inside the app bundle, and what the main process requires. */
export const ADDON_FILE_NAME = "dosya-file-provider.node";

/** Matches the app and the extension; a higher floor would mean the app loads
 *  nothing on a Mac where it otherwise runs. */
const DEPLOYMENT_TARGET = "12.0";

/** The official Node-API headers, from the package the Node project publishes. */
export function nodeApiIncludeDir() {
  const require = createRequire(import.meta.url);
  return join(dirname(require.resolve("node-api-headers")), "include");
}

export function addonSourceFiles() {
  return [...SHARED_CORE.map((f) => join(coreSources, f)), ...ADDON.map((f) => join(addonSources, f))];
}

/**
 * Swift reaches a C API through a module map, which the headers package does not
 * ship. Written into the build directory rather than next to the headers, which
 * are read-only in CI.
 */
function writeModuleMap(dir, include) {
  const path = join(dir, "module.modulemap");
  writeFileSync(path, `module CNodeAPI {\n  header "${join(include, "node_api.h")}"\n  export *\n}\n`);
  return path;
}

export function buildFileProviderAddon({ outDir, arches = ["arm64", "x86_64"] } = {}) {
  if (process.platform !== "darwin") {
    console.log("[file-provider-addon] not macOS, skipping");
    return null;
  }
  try {
    execFileSync("xcrun", ["--find", "swiftc"], { stdio: "ignore" });
  } catch {
    console.log("[file-provider-addon] no Xcode toolchain, skipping");
    return null;
  }

  const include = nodeApiIncludeDir();
  const work = join(outDir, ".file-provider-addon-build");
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });
  const moduleMap = writeModuleMap(work, include);

  const files = addonSourceFiles();
  const slices = arches.map((arch) => {
    const output = join(work, `addon-${arch}.dylib`);
    execFileSync(
      "xcrun",
      [
        "swiftc",
        "-target", `${arch}-apple-macos${DEPLOYMENT_TARGET}`,
        // Matches the extension build: these sources carry one construct Swift 6
        // rejects.
        "-swift-version", "5",
        "-O",
        "-module-name", "DosyaFileProviderAddon",
        "-emit-library",
        "-Xcc", `-fmodule-map-file=${moduleMap}`,
        "-Xcc", `-I${include}`,
        // napi_* is resolved from the host process (node, or Electron) at load
        // time; the addon links against no Node library of its own.
        "-Xlinker", "-undefined", "-Xlinker", "dynamic_lookup",
        "-o", output,
        ...files,
      ],
      { stdio: "inherit" },
    );
    return output;
  });

  const addon = join(outDir, ADDON_FILE_NAME);
  rmSync(addon, { force: true });
  execFileSync("lipo", ["-create", ...slices, "-output", addon]);
  rmSync(work, { recursive: true, force: true });
  console.log(`[file-provider-addon] built ${addon} (${arches.join(", ")})`);
  return addon;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const out = process.argv[2] ?? join(here, "..", "out");
  mkdirSync(out, { recursive: true });
  buildFileProviderAddon({ outDir: out });
}
