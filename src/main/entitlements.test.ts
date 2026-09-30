import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The extension authenticates by reading a keychain item the app wrote, and the
 * group name is the only thing that makes those the same item. It is declared
 * once, in Session.swift, and everything else is checked AGAINST that rather
 * than restating it: a test that repeats a constant cannot notice the constant
 * is wrong, which is exactly how the first version of these files shipped a
 * group the Swift could never match.
 */
const desktop = join(import.meta.dirname, "..", "..");
const read = (p: string) => readFileSync(join(desktop, p), "utf8");

/** The suffix Session.swift's resolvedAccessGroup() looks for. */
function accessGroupSuffix(): string {
  const swift = read("native/macos/DosyaFileProvider/Sources/DosyaFileProviderCore/Session.swift");
  const match = swift.match(/accessGroupSuffix\s*=\s*"([^"]+)"/);
  assert.ok(match, "Session.swift no longer declares accessGroupSuffix");
  return match[1];
}

function entitlementArray(plist: string, key: string): string[] {
  const match = plist.match(new RegExp(`<key>${key}</key>\\s*<array>([\\s\\S]*?)</array>`));
  if (!match) return [];
  return [...match[1].matchAll(/<string>([^<]*)<\/string>/g)].map((m) => m[1]);
}

test("the extension is entitled to the group the Swift resolves", () => {
  const groups = entitlementArray(read("build/entitlements.fileprovider.plist"), "keychain-access-groups");
  assert.equal(groups.length, 1);
  assert.equal(
    groups[0],
    `__TEAM_ID__.${accessGroupSuffix()}`,
    "resolvedAccessGroup() matches only a group ending in the Swift's suffix",
  );
});

test("no Xcode build variable survives into anything codesign reads", () => {
  // `codesign --entitlements` performs no substitution, so a $(…) here would be
  // written into the signature verbatim and grant nothing.
  for (const path of [
    "build/entitlements.fileprovider.plist",
    "build/entitlements.mac.plist",
    "native/macos/DosyaFileProvider/AppExtension/Info.plist",
  ]) {
    // Comments are stripped first: the templates explain in prose why
    // $(AppIdentifierPrefix) is NOT used, and that sentence is not a value.
    const withoutComments = read(path).replace(/<!--[\s\S]*?-->/g, "");
    assert.doesNotMatch(withoutComments, /\$\([A-Za-z]/, `${path} still carries an Xcode variable`);
  }
});

test("the app does not carry the keychain entitlement until a profile exists", () => {
  // keychain-access-groups is authorization-gated: signed without a
  // provisioning profile that grants it, the process is killed at launch. It
  // lands together with mac.provisioningProfile, not before.
  const app = read("build/entitlements.mac.plist");
  const hasEntitlement = entitlementArray(app, "keychain-access-groups").length > 0;
  const hasProfile = /provisioningProfile/.test(read("electron-builder.yml"));
  assert.equal(
    hasEntitlement,
    hasProfile,
    hasEntitlement
      ? "the app claims a keychain group with no provisioning profile configured; it will be killed at launch"
      : "a provisioning profile is configured, so the app should now claim the keychain group too",
  );
});

test("the app's keychain group is the one Session.swift looks for", () => {
  // The app plist must hardcode the full group, team prefix included, because
  // codesign substitutes nothing. So this is the one side that cannot be
  // generated from the Swift, and the one side a rename in Session.swift would
  // leave behind: the extension would follow through __TEAM_ID__ while the app
  // kept writing to the old group, the two would address different keychain
  // items, and every other test here would still pass.
  const groups = entitlementArray(read("build/entitlements.mac.plist"), "keychain-access-groups");
  assert.equal(groups.length, 1, "one group, or the app and the extension can disagree about which");
  const [prefix, ...rest] = groups[0].split(".");
  assert.match(prefix, /^[A-Z0-9]{10}$/, "the app's group must carry a literal team prefix");
  assert.equal(rest.join("."), accessGroupSuffix());
});

test("the app keeps the entitlements it already had", () => {
  const app = read("build/entitlements.mac.plist");
  for (const key of [
    "com.apple.security.cs.allow-jit",
    "com.apple.security.network.client",
    "com.apple.security.files.user-selected.read-write",
  ]) {
    assert.match(app, new RegExp(key.replace(/\./g, "\\.")), `${key} was dropped`);
  }
});

test("the extension may reach the network", () => {
  assert.match(read("build/entitlements.fileprovider.plist"), /com\.apple\.security\.network\.client/);
});

test("the extension's floor is not above the app's", () => {
  // A higher floor means the extension silently never loads on a Mac where the
  // app runs fine, with nothing on screen to explain it.
  const appex = read("native/macos/DosyaFileProvider/AppExtension/Info.plist");
  const floor = appex.match(/<key>LSMinimumSystemVersion<\/key>\s*<string>([^<]+)<\/string>/)?.[1];
  assert.equal(floor, "12.0", "must match the app's LSMinimumSystemVersion");
});

test("the packaging hook is still wired in", () => {
  // Without this line the app packages cleanly with no extension inside, and
  // every other test here still passes.
  assert.match(read("electron-builder.yml"), /^afterPack:\s*scripts\/afterPack\.mjs$/m);
});

test("the release workflow supplies both provisioning profiles", () => {
  // Neither profile is in git: they authorize restricted entitlements and this
  // app is published to a public mirror. That makes CI the only place they can
  // come from, and a workflow that forgets one fails at signing after the build,
  // which on a tag is a wasted release rather than a red check.
  const workflow = readFileSync(
    join(desktop, "..", "..", ".github", "workflows", "desktop-release.yml"),
    "utf8",
  );
  for (const profile of ["build/embedded.provisionprofile", "build/fileprovider.provisionprofile"]) {
    assert.ok(
      workflow.includes(profile),
      `${profile} is required to sign but nothing in the release workflow writes it`,
    );
  }
  // The app's own profile is named in electron-builder.yml; the extension's is
  // named in scripts/afterPack.mjs. Both must be the paths CI writes.
  assert.match(read("electron-builder.yml"), /provisioningProfile:\s*build\/embedded\.provisionprofile/);
  assert.match(read("scripts/afterPack.mjs"), /"fileprovider\.provisionprofile"/);
});

test("the release checks the certificate before it builds", () => {
  // `base64 -i missing-file | gh secret set X` sets X to an EMPTY string: base64
  // fails, prints nothing, and gh stores the nothing. That happened to
  // MAC_CERTIFICATE_P12 on 2026-09-30, and an empty certificate secret is
  // otherwise only discovered by a failed signing step half an hour into a
  // release. This Mac also holds two other certificates whose common name is the
  // same organisation, so "a certificate imported" is not the same as "the right
  // certificate imported".
  const workflow = readFileSync(
    join(desktop, "..", "..", ".github", "workflows", "desktop-release.yml"),
    "utf8",
  );
  assert.match(workflow, /MAC_CERTIFICATE_P12 is empty|P12_BASE64:-\}" \]/);
  // The expected identity is read from electron-builder.yml rather than repeated
  // in the workflow, so a change to one cannot silently disagree with the other.
  assert.match(workflow, /electron-builder\.yml[\s\S]{0,400}find-identity/);
});

test("no entitlements file that codesign reads carries an XML comment", () => {
  // codesign hands entitlements to AMFI, whose parser rejects comments outright:
  // "Failed to parse entitlements: AMFIUnserializeXML: syntax error near line 7".
  // The app's plist goes to codesign verbatim, so it must be clean. The
  // extension's is a template whose comments are stripped when it is
  // materialised, so it may keep them.
  assert.doesNotMatch(read("build/entitlements.mac.plist"), /<!--/);
});
