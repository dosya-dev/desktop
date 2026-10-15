import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, copyFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifyStoreBundle } from "./verify-store-bundle.mjs";

const APP = "/tmp/x/dosya.app";
const EXT = `${APP}/Contents/PlugIns/DosyaFileProvider.appex`;

/**
 * A fake `exec` answering plutil and codesign the way a correct store build
 * does. plutil answers are keyed by the extracted key as well as the path:
 * the verifier reads three different keys out of each Info.plist, and keying on
 * the path alone would make every one of them the same answer.
 */
const identified = (bundleIdentifier) =>
  `<key>com.apple.application-identifier</key><string>53HFF44WQ8.${bundleIdentifier}</string>` +
  `<key>com.apple.developer.team-identifier</key><string>53HFF44WQ8</string>`;

function goodExec(overrides = {}) {
  const sandboxed = (extra) =>
    `<plist><dict><key>com.apple.security.app-sandbox</key><true/>${extra}</dict></plist>`;
  const answers = {
    [`plutil CFBundleIdentifier ${APP}/Contents/Info.plist`]: "dev.dosya.mac\n",
    [`plutil CFBundleIdentifier ${EXT}/Contents/Info.plist`]: "dev.dosya.mac.fileprovider\n",
    // One monotonic integer per upload, the same on both bundles.
    [`plutil CFBundleVersion ${APP}/Contents/Info.plist`]: "12301\n",
    [`plutil CFBundleVersion ${EXT}/Contents/Info.plist`]: "12301\n",
    [`plutil CFBundleShortVersionString ${APP}/Contents/Info.plist`]: "3.0.10\n",
    [`plutil CFBundleShortVersionString ${EXT}/Contents/Info.plist`]: "3.0.10\n",
    [`plutil ITSAppUsesNonExemptEncryption ${APP}/Contents/Info.plist`]: "false\n",
    [`codesign ${APP}`]: sandboxed(
      "<key>keychain-access-groups</key><array><string>53HFF44WQ8.group.dev.dosya.desktop</string></array>" +
        "<key>com.apple.security.application-groups</key><array><string>group.dev.dosya.desktop</string></array>" +
        identified("dev.dosya.mac"),
    ),
    [`codesign ${EXT}`]: sandboxed(identified("dev.dosya.mac.fileprovider")),
    ...overrides,
  };
  return (cmd, args) => {
    const key = cmd === "plutil" ? `plutil ${args[1]} ${args[args.length - 1]}` : `codesign ${args[args.length - 1]}`;
    if (!(key in answers)) throw new Error(`unexpected call ${key}`);
    return answers[key];
  };
}

const allPresent = () => true;

test("a correct store bundle has no problems", () => {
  assert.deepEqual(verifyStoreBundle({ appPath: APP, exec: goodExec(), exists: allPresent }), []);
});

test("names the app identifier when it is the Developer ID one", () => {
  const problems = verifyStoreBundle({
    appPath: APP,
    exec: goodExec({ [`plutil CFBundleIdentifier ${APP}/Contents/Info.plist`]: "dev.dosya.desktop\n" }),
    exists: allPresent,
  });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /dev\.dosya\.desktop/);
  assert.match(problems[0], /dev\.dosya\.mac/);
});

test("names a missing sandbox entitlement on the extension", () => {
  const problems = verifyStoreBundle({
    appPath: APP,
    exec: goodExec({ [`codesign ${EXT}`]: `<plist><dict>${identified("dev.dosya.mac.fileprovider")}</dict></plist>` }),
    exists: allPresent,
  });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /app-sandbox/);
  assert.match(problems[0], /DosyaFileProvider\.appex/);
});

test("names an extension whose build version drifted from the app's", () => {
  // The app's CFBundleVersion comes from electron-builder, the extension's from
  // scripts/build-file-provider.mjs; App Store Connect rejects the upload when
  // they differ, naming neither value.
  const problems = verifyStoreBundle({
    appPath: APP,
    exec: goodExec({ [`plutil CFBundleVersion ${EXT}/Contents/Info.plist`]: "3.0.10\n" }),
    exists: allPresent,
  });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /extension CFBundleVersion 3\.0\.10 does not match app 12301/);
});

test("names an extension whose marketing version drifted from the app's", () => {
  const problems = verifyStoreBundle({
    appPath: APP,
    exec: goodExec({ [`plutil CFBundleShortVersionString ${EXT}/Contents/Info.plist`]: "3.0.9\n" }),
    exists: allPresent,
  });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /extension CFBundleShortVersionString 3\.0\.9 does not match app 3\.0\.10/);
});

test("names a missing embedded profile", () => {
  const problems = verifyStoreBundle({
    appPath: APP,
    exec: goodExec(),
    exists: (p) => !p.endsWith(`${EXT}/Contents/embedded.provisionprofile`),
  });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /embedded\.provisionprofile/);
});

test("reports every problem at once rather than the first", () => {
  const problems = verifyStoreBundle({
    appPath: APP,
    exec: goodExec({
      [`plutil CFBundleIdentifier ${APP}/Contents/Info.plist`]: "dev.dosya.desktop\n",
      [`codesign ${APP}`]: "<plist><dict></dict></plist>",
    }),
    exists: () => false,
  });
  assert.ok(problems.length >= 4, `expected several problems, got ${problems.length}:\n${problems.join("\n")}`);
});

test("names a missing application identifier on the extension (ITMS-90886, the first TestFlight rejection)", () => {
  // The extension is signed by our script, not Xcode, so nothing adds the two
  // identifier entitlements unless the template carries them. App Store Connect
  // accepted this exact bundle for upload and then refused it for TestFlight.
  const problems = verifyStoreBundle({
    appPath: APP,
    exec: goodExec({ [`codesign ${EXT}`]: "<plist><dict><key>com.apple.security.app-sandbox</key><true/></dict></plist>" }),
    exists: allPresent,
  });
  assert.equal(problems.length, 2, problems.join("\n"));
  assert.match(problems[0], /DosyaFileProvider\.appex lacks com\.apple\.application-identifier 53HFF44WQ8\.dev\.dosya\.mac\.fileprovider/);
  assert.match(problems[0], /ITMS-90886/);
  assert.match(problems[1], /team-identifier 53HFF44WQ8/);
});

test("names a missing export-compliance key (App Store Connect's 'Missing Compliance' hold)", () => {
  const problems = verifyStoreBundle({
    appPath: APP,
    exec: (cmd, args) => {
      if (cmd === "plutil" && args[1] === "ITSAppUsesNonExemptEncryption") throw new Error("No value at that key path");
      return goodExec()(cmd, args);
    },
    exists: allPresent,
  });
  assert.equal(problems.length, 1, problems.join("\n"));
  assert.match(problems[0], /ITSAppUsesNonExemptEncryption/);
});

test("reports one problem when codesign itself fails, not one per entitlement it never read", () => {
  const exec = goodExec();
  const problems = verifyStoreBundle({
    appPath: APP,
    exec: (cmd, args) => {
      if (cmd === "codesign" && args[args.length - 1] === APP) throw new Error("boom");
      return exec(cmd, args);
    },
    exists: allPresent,
  });
  assert.equal(problems.length, 1, `expected exactly one problem, got:\n${problems.join("\n")}`);
  assert.match(problems[0], /could not read entitlements/);
  assert.match(problems[0], new RegExp(APP.replace(/\//g, "\\/")));
  assert.match(problems[0], /boom/);
});

// Regression guard for codesign's `--xml` flag: the fakes above answer in XML
// no matter what, so they cannot tell a correct `exec` call from one that
// forgot `--xml` and would get back codesign's bracketed debug dump instead
// (`[Dict] [Key] com.apple.security.app-sandbox [Value] [Bool] true`) on
// macOS 15. This test signs a real, minimal bundle and reads it back with the
// verifier's actual `exec` (execFileSync + real codesign), so it fails if
// `--xml` is ever removed.
test(
  "a real ad-hoc signed app bundle has its entitlements read correctly (proves --xml, not a fake)",
  { skip: process.platform !== "darwin" },
  () => {
    const dir = mkdtempSync(join(tmpdir(), "store-bundle-"));
    try {
      const appPath = join(dir, "dosya.app");
      const macosDir = join(appPath, "Contents", "MacOS");
      mkdirSync(macosDir, { recursive: true });
      copyFileSync("/usr/bin/true", join(macosDir, "dosya"));
      writeFileSync(
        join(appPath, "Contents", "Info.plist"),
        [
          '<?xml version="1.0" encoding="UTF-8"?>',
          '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
          '<plist version="1.0">',
          "<dict>",
          "    <key>CFBundleIdentifier</key>",
          "    <string>dev.dosya.mac</string>",
          "    <key>CFBundleExecutable</key>",
          "    <string>dosya</string>",
          "    <key>ITSAppUsesNonExemptEncryption</key>",
          "    <false/>",
          "    <key>CFBundleVersion</key>",
          "    <string>12301</string>",
          "    <key>CFBundleShortVersionString</key>",
          "    <string>3.0.10</string>",
          "</dict>",
          "</plist>",
          "",
        ].join("\n"),
      );
      // The real app's identifier entitlements are injected by electron-builder
      // at sign time, so this ad-hoc fixture adds them to the template itself.
      const entitlementsPath = join(dir, "entitlements.plist");
      writeFileSync(
        entitlementsPath,
        readFileSync(join(import.meta.dirname, "..", "build", "entitlements.mas.plist"), "utf8").replace(
          "</dict>",
          "    <key>com.apple.application-identifier</key>\n    <string>53HFF44WQ8.dev.dosya.mac</string>\n" +
            "    <key>com.apple.developer.team-identifier</key>\n    <string>53HFF44WQ8</string>\n</dict>",
        ),
      );
      // Ad-hoc signing (`--sign -`) needs no certificate, which is why this
      // test can run on any machine rather than only one with a signing identity.
      execFileSync("codesign", ["--force", "--sign", "-", "--entitlements", entitlementsPath, appPath]);

      // Real exec/exists (execFileSync + existsSync), reading the real signature.
      const problems = verifyStoreBundle({ appPath });

      for (const p of problems) {
        assert.ok(
          !p.includes("dosya.app lacks"),
          `the app's own entitlements (app-sandbox, keychain-access-groups, application-groups) ` +
            `were signed in and present, so this must never fire; if it does, codesign's output is ` +
            `no longer being parsed as XML:\n${p}`,
        );
      }
      // The extension bundle and both embedded profiles genuinely do not exist
      // in this minimal fixture, so those - and only those - problems remain.
      assert.ok(
        problems.some((p) => p.includes("extension CFBundleIdentifier")),
        `expected an extension-identifier problem among:\n${problems.join("\n")}`,
      );
      assert.ok(
        problems.some((p) => p.includes("embedded.provisionprofile")),
        `expected a missing-profile problem among:\n${problems.join("\n")}`,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
