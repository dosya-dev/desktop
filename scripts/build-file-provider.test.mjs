import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildFileProvider } from "./build-file-provider.mjs";

const mac = process.platform === "darwin";

test("assembles a universal bundle macOS can load", { skip: !mac }, () => {
  const out = mkdtempSync(join(tmpdir(), "appex-"));
  const appex = buildFileProvider({ outDir: out });
  assert.ok(appex && existsSync(appex), "no bundle produced");

  const binary = join(appex, "Contents", "MacOS", "DosyaFileProvider");
  assert.ok(existsSync(binary), "no executable inside the bundle");

  // Both slices, or the app fails only on the other kind of Mac.
  const arches = execFileSync("lipo", ["-archs", binary], { encoding: "utf8" });
  assert.match(arches, /arm64/);
  assert.match(arches, /x86_64/);

  // The plist must survive as a real plist and name the class the runtime sees.
  const plist = join(appex, "Contents", "Info.plist");
  execFileSync("plutil", ["-lint", plist]);
  const printed = execFileSync("plutil", ["-p", plist], { encoding: "utf8" });
  // Every macOS app extension Xcode produces carries this, including the ones
  // macOS itself ships, and ours is the only difference from them that is not
  // explained. It is not a verified fix for anything: registration is blocked
  // on notarization first (see the phase 4 notes), so this is alignment, not a
  // diagnosis. Pinned so it cannot be dropped again without a decision.
  assert.match(printed, /CFBundleSupportedPlatforms/);
  assert.match(printed, /MacOSX/);
  assert.match(printed, /com\.apple\.fileprovider-nonui/);
  assert.match(printed, /DosyaFileProviderExtension/);

  // The class the plist names has to exist in the binary. It is registered by
  // the Objective-C runtime from __objc_classlist rather than exported, so it
  // is a LOCAL symbol: `nm -gU` would not show it and the check would pass only
  // by accident on some other build.
  const symbols = execFileSync("nm", ["-a", binary], { encoding: "utf8" });
  assert.match(symbols, /_OBJC_CLASS_\$_DosyaFileProviderExtension/,
    "macOS looks the principal class up by this name; without it the bundle loads and instantiates nothing");
});

test("skips cleanly off macOS", { skip: mac }, () => {
  assert.equal(buildFileProvider({ outDir: tmpdir() }), null);
});
