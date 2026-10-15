// Proves a signed Mac App Store bundle carries what App Store Connect checks
// first and reports worst: the sandbox entitlement on the app and on the
// Finder extension, the store identifiers on both, the extension's bundle
// versions matching the app's, and an embedded profile in both. Every problem
// is collected, not just the first, so one build log shows everything that is
// wrong with a signing setup.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { STORE_APP_BUNDLE_ID, STORE_EXTENSION_BUNDLE_ID } from "./afterPack.mjs";

const SANDBOX_KEY = "com.apple.security.app-sandbox";
const TEAM_ID = "53HFF44WQ8";
/** Xcode signs these into every provisioned bundle; TestFlight refuses a bundle
 *  whose profile names an application identifier the signature lacks (ITMS-90886). */
const APP_IDENTIFIER_KEY = "com.apple.application-identifier";
const TEAM_IDENTIFIER_KEY = "com.apple.developer.team-identifier";
const KEYCHAIN_GROUP = "53HFF44WQ8.group.dev.dosya.desktop";
const APP_GROUP = "group.dev.dosya.desktop";

function defaultExec(cmd, args) {
  return execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

/** `<key>k</key>` followed by `<true/>`, tolerant of whitespace and the binary header codesign may print first. */
function hasTrueEntitlement(xml, key) {
  return new RegExp(`<key>${key.replace(/\./g, "\\.")}</key>\\s*<true/>`).test(xml);
}

/** `<key>k</key>` followed by `<string>value</string>`. */
function hasStringEntitlement(xml, key, value) {
  return new RegExp(`<key>${key.replace(/\./g, "\\.")}</key>\\s*<string>${value.replace(/\./g, "\\.")}</string>`).test(xml);
}

/** The two identifier entitlements, checked the same way on both bundles. */
function identifierProblems(xml, label, bundleIdentifier) {
  const out = [];
  if (!hasStringEntitlement(xml, APP_IDENTIFIER_KEY, `${TEAM_ID}.${bundleIdentifier}`)) {
    out.push(`${label} lacks ${APP_IDENTIFIER_KEY} ${TEAM_ID}.${bundleIdentifier} (ITMS-90886)`);
  }
  if (!hasStringEntitlement(xml, TEAM_IDENTIFIER_KEY, TEAM_ID)) {
    out.push(`${label} lacks ${TEAM_IDENTIFIER_KEY} ${TEAM_ID}`);
  }
  return out;
}

/**
 * One Info.plist key of a bundle, as a string. An unreadable value is returned
 * as text rather than thrown: it is reported as the problem it is, and it can
 * never compare equal to the value it is being checked against.
 */
function plistValue(exec, bundlePath, key) {
  try {
    return exec("plutil", ["-extract", key, "raw", "-o", "-", join(bundlePath, "Contents", "Info.plist")]).trim();
  } catch (e) {
    return `<unreadable: ${e?.message ?? e}>`;
  }
}

function bundleId(exec, bundlePath) {
  return plistValue(exec, bundlePath, "CFBundleIdentifier");
}

/**
 * Without `--xml`, codesign's `-d --entitlements -` prints its own bracketed
 * debug dump ("[Dict] [Key] com.apple.security.app-sandbox [Value] [Bool]
 * true") on macOS 15, not the plist XML the regex checks below expect - every
 * entitlement would then read as missing on a correctly signed bundle. `--xml`
 * asks for the original plist back verbatim (see `man codesign`).
 *
 * Returns `{ ok: true, xml }` on success, or `{ ok: false, reason }` when
 * codesign itself fails (unsigned bundle, bad path, ...), so the caller can
 * report that distinctly from an entitlement that was read and found absent.
 */
function readEntitlements(exec, bundlePath) {
  try {
    return { ok: true, xml: exec("codesign", ["-d", "--entitlements", "-", "--xml", bundlePath]) };
  } catch (e) {
    return { ok: false, reason: e?.message ?? String(e) };
  }
}

/**
 * Returns the list of problems with the signed store bundle at `appPath`.
 * Empty means verified. `exec` and `exists` are injectable for tests.
 */
export function verifyStoreBundle({ appPath, exec = defaultExec, exists = existsSync }) {
  const problems = [];
  const extensionPath = join(appPath, "Contents", "PlugIns", "DosyaFileProvider.appex");

  const appId = bundleId(exec, appPath);
  if (appId !== STORE_APP_BUNDLE_ID) {
    problems.push(`app CFBundleIdentifier is ${appId}, expected ${STORE_APP_BUNDLE_ID}`);
  }
  const extId = bundleId(exec, extensionPath);
  if (extId !== STORE_EXTENSION_BUNDLE_ID) {
    problems.push(`extension CFBundleIdentifier is ${extId}, expected ${STORE_EXTENSION_BUNDLE_ID}`);
  }

  // An app extension whose CFBundleVersion differs from its containing app's is
  // rejected by App Store Connect at upload ("The CFBundleVersion of an app
  // extension must match that of its containing parent app"), and the two are
  // stamped by different code paths here - electron-builder for the app,
  // scripts/build-file-provider.mjs for the extension - so they can drift.
  for (const key of ["CFBundleVersion", "CFBundleShortVersionString"]) {
    const appValue = plistValue(exec, appPath, key);
    const extValue = plistValue(exec, extensionPath, key);
    if (appValue !== extValue) {
      problems.push(`extension ${key} ${extValue} does not match app ${appValue}`);
    }
  }

  // A codesign failure is one problem ("could not read entitlements of ..."),
  // not a cascade of "lacks X" for every entitlement that was never actually
  // checked - those two causes need different fixes and must not look alike.
  const appEntitlements = readEntitlements(exec, appPath);
  if (!appEntitlements.ok) {
    problems.push(`could not read entitlements of ${appPath}: ${appEntitlements.reason}`);
  } else {
    const xml = appEntitlements.xml;
    if (!hasTrueEntitlement(xml, SANDBOX_KEY)) {
      problems.push(`dosya.app lacks ${SANDBOX_KEY}`);
    }
    if (!xml.includes(`<string>${KEYCHAIN_GROUP}</string>`)) {
      problems.push(`dosya.app lacks keychain-access-groups ${KEYCHAIN_GROUP}`);
    }
    if (!xml.includes(`<string>${APP_GROUP}</string>`)) {
      problems.push(`dosya.app lacks com.apple.security.application-groups ${APP_GROUP}`);
    }
    problems.push(...identifierProblems(xml, "dosya.app", STORE_APP_BUNDLE_ID));
  }

  const extEntitlements = readEntitlements(exec, extensionPath);
  if (!extEntitlements.ok) {
    problems.push(`could not read entitlements of ${extensionPath}: ${extEntitlements.reason}`);
  } else {
    if (!hasTrueEntitlement(extEntitlements.xml, SANDBOX_KEY)) {
      problems.push(`DosyaFileProvider.appex lacks ${SANDBOX_KEY}`);
    }
    problems.push(...identifierProblems(extEntitlements.xml, "DosyaFileProvider.appex", STORE_EXTENSION_BUNDLE_ID));
  }

  // Without this key App Store Connect holds the build at "Missing Compliance"
  // until the export question is answered by hand on every upload.
  const compliance = plistValue(exec, appPath, "ITSAppUsesNonExemptEncryption");
  if (compliance !== "false") {
    problems.push(`app Info.plist ITSAppUsesNonExemptEncryption is ${compliance}, expected false (export compliance)`);
  }

  for (const bundle of [appPath, extensionPath]) {
    const profile = join(bundle, "Contents", "embedded.provisionprofile");
    if (!exists(profile)) problems.push(`missing ${profile}`);
  }

  return problems;
}
