import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildFileProvider, DEFAULT_EXTENSION_BUNDLE_ID, renderInfoPlist, materializeEntitlements } from "./build-file-provider.mjs";

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

const templatePath = new URL("../native/macos/DosyaFileProvider/AppExtension/Info.plist", import.meta.url);

test("renders the template with the version and bundle identifier filled in", () => {
  const template = readFileSync(templatePath, "utf8");
  const plist = renderInfoPlist({ template, version: "3.1.0", bundleId: "dev.dosya.mac.fileprovider" });
  assert.match(plist, /<key>CFBundleIdentifier<\/key>\s*<string>dev\.dosya\.mac\.fileprovider<\/string>/);
  assert.match(plist, /<key>CFBundleShortVersionString<\/key>\s*<string>3\.1\.0<\/string>/);
  assert.doesNotMatch(plist, /__[A-Z_]+__/, "a placeholder survived");
});

test("the build version is stamped separately from the marketing version", () => {
  // App Store Connect rejects an app extension whose CFBundleVersion differs
  // from its containing app's, and the app's is one monotonic integer per
  // upload rather than X.Y.Z - so the two values differ on every store build.
  const template = readFileSync(templatePath, "utf8");
  const plist = renderInfoPlist({
    template,
    version: "3.0.10",
    buildVersion: "12301",
    bundleId: "dev.dosya.mac.fileprovider",
  });
  assert.match(plist, /<key>CFBundleShortVersionString<\/key>\s*<string>3\.0\.10<\/string>/);
  assert.match(plist, /<key>CFBundleVersion<\/key>\s*<string>12301<\/string>/);
  assert.doesNotMatch(plist, /__[A-Z_]+__/, "a placeholder survived");
});

test("the build version defaults to the marketing version", () => {
  // A local `npm run package:mac` passes no build version; the two values are
  // then the same, which is what every pre-store build shipped.
  const template = readFileSync(templatePath, "utf8");
  const plist = renderInfoPlist({ template, version: "3.0.10", bundleId: "dev.dosya.desktop.fileprovider" });
  assert.match(plist, /<key>CFBundleShortVersionString<\/key>\s*<string>3\.0\.10<\/string>/);
  assert.match(plist, /<key>CFBundleVersion<\/key>\s*<string>3\.0\.10<\/string>/);
});

test("the template carries no literal identifier any more", () => {
  const template = readFileSync(templatePath, "utf8");
  assert.doesNotMatch(template, /dev\.dosya\.desktop\.fileprovider/);
  assert.match(template, /__BUNDLE_ID__/);
});

test("refuses to render without a bundle identifier", () => {
  const template = readFileSync(templatePath, "utf8");
  assert.throws(() => renderInfoPlist({ template, version: "1.0.0", bundleId: "" }), /bundleId/);
  assert.throws(() => renderInfoPlist({ template, version: "1.0.0" }), /bundleId/);
});

test("the default identifier is the Developer ID extension's", () => {
  assert.equal(DEFAULT_EXTENSION_BUNDLE_ID, "dev.dosya.desktop.fileprovider");
});

test("materialized entitlements carry the team-prefixed identifier of the extension being built", () => {
  const out = mkdtempSync(join(tmpdir(), "ent-"));
  const path = materializeEntitlements({ outDir: out, teamId: "53HFF44WQ8", bundleId: "dev.dosya.mac.fileprovider" });
  const xml = readFileSync(path, "utf8");
  assert.match(xml, /<key>com\.apple\.application-identifier<\/key>\s*<string>53HFF44WQ8\.dev\.dosya\.mac\.fileprovider<\/string>/);
  assert.match(xml, /<key>com\.apple\.developer\.team-identifier<\/key>\s*<string>53HFF44WQ8<\/string>/);
  assert.doesNotMatch(xml, /__[A-Z_]+__/);
  assert.doesNotMatch(xml, /<!--/, "codesign hands entitlements to AMFI, which rejects XML comments");
  // The Developer ID build keeps its own identifier by default.
  const dev = readFileSync(materializeEntitlements({ outDir: out, teamId: "53HFF44WQ8" }), "utf8");
  assert.match(dev, /53HFF44WQ8\.dev\.dosya\.desktop\.fileprovider/);
});
