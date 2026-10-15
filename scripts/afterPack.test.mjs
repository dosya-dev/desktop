import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, existsSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  embedFileProvider,
  embedFileProviderAddon,
  signWithRetry,
  EXTENSION_PROFILE,
  resolveIdentity,
  isStoreTarget,
  storeTarget,
  STORE_APP_BUNDLE_ID,
  STORE_EXTENSION_BUNDLE_ID,
  EXTENSION_PROFILE_STORE,
  EXTENSION_PROFILE_DEV,
} from "./afterPack.mjs";
import { ADDON_FILE_NAME } from "./build-file-provider-addon.mjs";

const mac = process.platform === "darwin";

test("puts the extension inside the app bundle", { skip: !mac }, () => {
  const root = mkdtempSync(join(tmpdir(), "pack-"));
  const appPath = join(root, "dosya.app");
  mkdirSync(join(appPath, "Contents", "MacOS"), { recursive: true });

  const result = embedFileProvider({ appPath, identity: null });

  assert.ok(
    existsSync(join(appPath, "Contents", "PlugIns", "DosyaFileProvider.appex", "Contents", "Info.plist")),
    "the extension must land in Contents/PlugIns",
  );
  assert.equal(result.embedded, true);
  assert.equal(result.signed, false, "nothing to sign with, so it must say so rather than pretend");
});

test("a machine with no signing identity still gets an app", { skip: !mac }, () => {
  const root = mkdtempSync(join(tmpdir(), "pack-"));
  const appPath = join(root, "dosya.app");
  mkdirSync(join(appPath, "Contents", "MacOS"), { recursive: true });
  assert.doesNotThrow(() => embedFileProvider({ appPath, identity: null }));
});

test("leaves no staging directory behind", { skip: !mac }, () => {
  const root = mkdtempSync(join(tmpdir(), "pack-"));
  const appPath = join(root, "dosya.app");
  mkdirSync(join(appPath, "Contents", "MacOS"), { recursive: true });
  embedFileProvider({ appPath, identity: null });
  assert.equal(existsSync(join(root, ".file-provider-staging")), false);
});

test("embeds the extension's own profile when one is supplied", { skip: !mac }, () => {
  const root = mkdtempSync(join(tmpdir(), "pack-"));
  const appPath = join(root, "dosya.app");
  mkdirSync(join(appPath, "Contents", "MacOS"), { recursive: true });

  if (!existsSync(EXTENSION_PROFILE)) return; // no profile on this machine yet

  embedFileProvider({ appPath, identity: null });
  assert.ok(
    existsSync(join(appPath, "Contents", "PlugIns", "DosyaFileProvider.appex", "Contents", "embedded.provisionprofile")),
    "the extension carries its own profile, not the app's",
  );
});

test("refuses to sign an extension with no profile", { skip: !mac }, () => {
  const root = mkdtempSync(join(tmpdir(), "pack-"));
  const appPath = join(root, "dosya.app");
  mkdirSync(join(appPath, "Contents", "MacOS"), { recursive: true });

  if (existsSync(EXTENSION_PROFILE)) return; // covered by the case above instead

  // Signed without a profile, macOS kills the extension at launch, so a build
  // that is signing must fail here rather than ship something inert.
  assert.throws(() => embedFileProvider({ appPath, identity: "Some Identity (ABCDE12345)" }), /provisioning profile/);
});

test("puts the addon in Contents/Resources, universal", { skip: !mac }, () => {
  const root = mkdtempSync(join(tmpdir(), "pack-"));
  const appPath = join(root, "dosya.app");
  mkdirSync(join(appPath, "Contents", "MacOS"), { recursive: true });

  const result = embedFileProviderAddon({ appPath, identity: null });

  const placed = join(appPath, "Contents", "Resources", ADDON_FILE_NAME);
  assert.ok(statSync(placed).isFile(), "the main process loads it from Resources");
  assert.equal(result.embedded, true);
  assert.equal(result.signed, false, "nothing to sign with, so it must say so rather than pretend");
  const archs = execFileSync("lipo", ["-archs", placed], { encoding: "utf8" }).trim().split(/\s+/).sort();
  assert.deepEqual(archs, ["arm64", "x86_64"], "the app ships one universal binary");
});

test("the addon leaves no staging directory behind", { skip: !mac }, () => {
  const root = mkdtempSync(join(tmpdir(), "pack-"));
  const appPath = join(root, "dosya.app");
  mkdirSync(join(appPath, "Contents", "MacOS"), { recursive: true });
  embedFileProviderAddon({ appPath, identity: null });
  assert.equal(existsSync(join(root, ".file-provider-addon-staging")), false);
});

test("an unsigned addon is fatal when the app is being signed", { skip: !mac }, () => {
  const root = mkdtempSync(join(tmpdir(), "pack-"));
  const appPath = join(root, "dosya.app");
  mkdirSync(join(appPath, "Contents", "MacOS"), { recursive: true });
  // An app signed around an unsigned Mach-O fails --deep --strict and
  // notarization, exactly as it does for the extension.
  assert.throws(
    () => embedFileProviderAddon({ appPath, identity: null, mustSign: true }),
    /signing identity/i,
  );
});

test("signing retries when Apple's timestamp service does not answer", () => {
  // Observed on a real build: two nested objects signed, the third came back
  // "A timestamp was expected but was not found." Signing six objects in a burst
  // is enough to get refused, and a release must not die on it.
  let calls = 0;
  const attempts = signWithRetry(["--sign", "x", "target"], {
    waitMs: 0,
    run: () => {
      calls += 1;
      if (calls < 3) {
        const e = new Error("Command failed");
        e.stderr = "target: A timestamp was expected but was not found.\n";
        throw e;
      }
    },
  });
  assert.equal(calls, 3);
  assert.equal(attempts, 3);
});

test("signing does not retry a real refusal", () => {
  let calls = 0;
  assert.throws(
    () =>
      signWithRetry(["--sign", "x", "target"], {
        waitMs: 0,
        run: () => {
          calls += 1;
          const e = new Error("Command failed");
          e.stderr = "target: errSecInternalComponent\n";
          throw e;
        },
      }),
    /errSecInternalComponent/,
  );
  assert.equal(calls, 1, "a broken keychain is not going to fix itself on attempt two");
});

test("signing gives up after the last attempt", () => {
  let calls = 0;
  assert.throws(
    () =>
      signWithRetry(["--sign", "x", "target"], {
        waitMs: 0,
        attempts: 2,
        run: () => {
          calls += 1;
          const e = new Error("Command failed");
          e.stderr = "A timestamp was expected but was not found.";
          throw e;
        },
      }),
    /timestamp/,
  );
  assert.equal(calls, 2);
});

const BOTH_CERTS = [
  '  1) AAAA "Developer ID Application: DOSYA PTY LTD (53HFF44WQ8)"',
  '  2) BBBB "Apple Distribution: DOSYA PTY LTD (53HFF44WQ8)"',
  '  3) CCCC "3rd Party Mac Developer Installer: DOSYA PTY LTD (53HFF44WQ8)"',
  '  4) DDDD "Apple Development: DOSYA PTY LTD (53HFF44WQ8)"',
  "     4 valid identities found",
].join("\n");

test("a Developer ID build resolves the Developer ID certificate", () => {
  const id = resolveIdentity({
    env: {},
    configured: "DOSYA PTY LTD (53HFF44WQ8)",
    findIdentities: () => BOTH_CERTS,
  });
  assert.equal(id, "Developer ID Application: DOSYA PTY LTD (53HFF44WQ8)");
});

test("a store build resolves the Apple Distribution certificate from the same short name", () => {
  const id = resolveIdentity({
    env: {},
    configured: "DOSYA PTY LTD (53HFF44WQ8)",
    target: "mas",
    findIdentities: () => BOTH_CERTS,
  });
  assert.equal(id, "Apple Distribution: DOSYA PTY LTD (53HFF44WQ8)");
});

test("a mas-dev build resolves the development certificate, not the distribution one", () => {
  // A store-signed .pkg cannot be launched outside the store, so mas-dev is how
  // the sandboxed build is run locally - and electron-builder itself looks for
  // "Apple Development"/"Mac Developer" there. Signing it with Apple
  // Distribution produces a bundle macOS refuses to launch.
  const id = resolveIdentity({
    env: {},
    configured: "DOSYA PTY LTD (53HFF44WQ8)",
    target: "mas-dev",
    findIdentities: () => BOTH_CERTS,
  });
  assert.equal(id, "Apple Development: DOSYA PTY LTD (53HFF44WQ8)");
});

test("a mas-dev build auto-discovers the development certificate with no hint", () => {
  const id = resolveIdentity({ env: {}, target: "mas-dev", findIdentities: () => BOTH_CERTS });
  assert.equal(id, "Apple Development: DOSYA PTY LTD (53HFF44WQ8)");
});

test("a store build falls back to the older 3rd Party Mac Developer Application name", () => {
  // electron-builder accepts either common name for mas; only this one is in
  // some teams' keychains.
  const legacy = '  1) AAAA "3rd Party Mac Developer Application: DOSYA PTY LTD (53HFF44WQ8)"';
  const id = resolveIdentity({ env: {}, target: "mas", findIdentities: () => legacy });
  assert.equal(id, "3rd Party Mac Developer Application: DOSYA PTY LTD (53HFF44WQ8)");
});

test("a store build with only a Developer ID certificate keeps the hint and lets codesign explain", () => {
  const onlyDevId = '  1) AAAA "Developer ID Application: DOSYA PTY LTD (53HFF44WQ8)"';
  const id = resolveIdentity({ env: {}, configured: "DOSYA PTY LTD (53HFF44WQ8)", target: "mas", findIdentities: () => onlyDevId });
  assert.equal(id, "DOSYA PTY LTD (53HFF44WQ8)");
});

test("storeTarget tells the two store targets apart, and neither from darwin", () => {
  // electron-builder reports electronPlatformName "mas" for BOTH mas and
  // mas-dev; only the Target object's name says which, and the two need
  // different profiles and different signing identities.
  assert.equal(storeTarget({ electronPlatformName: "mas", targets: [{ name: "pkg" }] }), "mas");
  assert.equal(storeTarget({ electronPlatformName: "mas", targets: [{ name: "mas-dev" }] }), "mas-dev");
  assert.equal(storeTarget({ electronPlatformName: "darwin", targets: [{ name: "dmg" }] }), null);
  assert.equal(storeTarget({ electronPlatformName: "mas" }), "mas", "no targets listed is the store build");
  assert.equal(storeTarget({}), null);
});

test("isStoreTarget stays true for both store targets", () => {
  assert.equal(isStoreTarget({ electronPlatformName: "mas" }), true);
  assert.equal(isStoreTarget({ electronPlatformName: "mas", targets: [{ name: "mas-dev" }] }), true);
  assert.equal(isStoreTarget({ electronPlatformName: "darwin" }), false);
  assert.equal(isStoreTarget({}), false);
});

test("the dev extension profile is its own file, not the store one", () => {
  assert.ok(EXTENSION_PROFILE_DEV.endsWith("build/fileprovider.mas-dev.provisionprofile"));
  assert.notEqual(EXTENSION_PROFILE_DEV, EXTENSION_PROFILE_STORE);
});

test("the store identifiers nest correctly", () => {
  assert.equal(STORE_APP_BUNDLE_ID, "dev.dosya.mac");
  assert.ok(STORE_EXTENSION_BUNDLE_ID.startsWith(`${STORE_APP_BUNDLE_ID}.`), "an extension's identifier must start with its app's");
  assert.ok(EXTENSION_PROFILE_STORE.endsWith("build/fileprovider.mas.provisionprofile"));
});

test("a store build stamps the store identifier into the extension", { skip: !mac }, () => {
  const root = mkdtempSync(join(tmpdir(), "pack-"));
  const appPath = join(root, "dosya.app");
  mkdirSync(join(appPath, "Contents", "MacOS"), { recursive: true });
  embedFileProvider({ appPath, identity: null, target: "mas" });
  const plist = join(appPath, "Contents", "PlugIns", "DosyaFileProvider.appex", "Contents", "Info.plist");
  const printed = execFileSync("plutil", ["-p", plist], { encoding: "utf8" });
  assert.match(printed, /dev\.dosya\.mac\.fileprovider/);
});

test("the embedded extension carries the app's build version, not its marketing version", { skip: !mac }, () => {
  // App Store Connect rejects an app extension whose CFBundleVersion differs
  // from its containing app's, and the app's is electron-builder's buildVersion.
  const root = mkdtempSync(join(tmpdir(), "pack-"));
  const appPath = join(root, "dosya.app");
  mkdirSync(join(appPath, "Contents", "MacOS"), { recursive: true });
  embedFileProvider({ appPath, identity: null, version: "3.0.10", buildVersion: "12301", target: "mas" });
  const plist = join(appPath, "Contents", "PlugIns", "DosyaFileProvider.appex", "Contents", "Info.plist");
  const read = (key) => execFileSync("plutil", ["-extract", key, "raw", "-o", "-", plist], { encoding: "utf8" }).trim();
  assert.equal(read("CFBundleVersion"), "12301");
  assert.equal(read("CFBundleShortVersionString"), "3.0.10");
});

test("a signed store build without the store extension profile is refused by name", { skip: !mac }, () => {
  if (existsSync(EXTENSION_PROFILE_STORE)) return; // this machine has one; nothing to prove
  const root = mkdtempSync(join(tmpdir(), "pack-"));
  const appPath = join(root, "dosya.app");
  mkdirSync(join(appPath, "Contents", "MacOS"), { recursive: true });
  assert.throws(
    () => embedFileProvider({ appPath, identity: "Apple Distribution: DOSYA PTY LTD (53HFF44WQ8)", target: "mas" }),
    /fileprovider\.mas\.provisionprofile/,
  );
});
