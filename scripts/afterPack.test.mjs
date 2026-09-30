import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, existsSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { embedFileProvider, embedFileProviderAddon, signWithRetry, EXTENSION_PROFILE } from "./afterPack.mjs";
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
