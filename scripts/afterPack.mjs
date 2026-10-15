// electron-builder afterPack: build the two native pieces of the macOS Finder
// integration and put them in the bundle, signed. The File Provider extension
// goes to Contents/PlugIns and the Node addon the main process loads goes to
// Contents/Resources.
//
// Nested code must be signed BEFORE the enclosing bundle, because the app's
// signature seals whatever is inside it. electron-builder runs this hook before
// its own signing pass, and it deliberately skips /Contents/PlugIns when it
// signs, so signing here is both the right order and the only opportunity.
//
// Signing is not optional on a build that is itself being signed: an app signed
// around an unsigned extension fails `codesign --verify --deep --strict` and is
// rejected by notarization. So a missing identity is fatal WHEN the app will be
// signed, and merely logged when it will not, which is what a developer without
// a certificate needs.
import { execFileSync } from "node:child_process";
import { mkdirSync, cpSync, rmSync, existsSync, copyFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildFileProvider, materializeEntitlements, resolveTeamId, DEFAULT_EXTENSION_BUNDLE_ID } from "./build-file-provider.mjs";
import { buildFileProviderAddon, ADDON_FILE_NAME } from "./build-file-provider-addon.mjs";

const here = dirname(fileURLToPath(import.meta.url));

/**
 * The extension's own provisioning profile. An app extension carries its own,
 * separate from the app's: it is a separately signed bundle with its own App ID
 * and its own entitlements, and the app's profile does not cover it.
 *
 * Supplied per machine and by CI from a secret, never committed, because this
 * app is published to a public mirror.
 */
export const EXTENSION_PROFILE = join(here, "..", "build", "fileprovider.provisionprofile");

/**
 * The Mac App Store variant of the extension's profile ("Mac App Store Connect"
 * type, App ID dev.dosya.mac.fileprovider). Same rules as EXTENSION_PROFILE:
 * written by CI from a secret, never committed.
 */
export const EXTENSION_PROFILE_STORE = join(here, "..", "build", "fileprovider.mas.provisionprofile");

/**
 * The mas-dev variant ("Mac App Development" type, App ID
 * dev.dosya.mac.fileprovider). A store-signed .pkg cannot be launched outside
 * the store, so `--mac mas-dev` is how the sandboxed build is run on a real
 * Mac - and a development build signed with the store's profile is refused at
 * launch. Same rules again: never committed.
 */
export const EXTENSION_PROFILE_DEV = join(here, "..", "build", "fileprovider.mas-dev.provisionprofile");

/**
 * The store build's identifiers. dev.dosya.desktop was uploaded to App Store
 * Connect once in July 2026 and that record was deleted, which spends the
 * identifier for the store forever; the Developer ID build keeps it.
 */
export const STORE_APP_BUNDLE_ID = "dev.dosya.mac";
export const STORE_EXTENSION_BUNDLE_ID = "dev.dosya.mac.fileprovider";

/**
 * Which store target is being packed, or null for anything else.
 *
 * electron-builder reports electronPlatformName "mas" for BOTH `mas` and
 * `mas-dev`, and the two are not interchangeable: mas-dev needs the Mac App
 * Development profile and an "Apple Development"/"Mac Developer" certificate
 * (which is what electron-builder itself looks for there), while mas needs the
 * distribution profile and an Apple Distribution certificate. The Target
 * objects in `context.targets` carry the name that tells them apart
 * (app-builder-lib core.js `Target.name`, "mas-dev" for the dev target).
 *
 * No targets listed at all reads as `mas`: that is the shape a hook sees for
 * the real store build, and defaulting to the stricter of the two means a
 * missing signal cannot quietly produce a development-signed submission.
 */
export function storeTarget(context) {
  if (context?.electronPlatformName !== "mas") return null;
  return context.targets?.some((t) => t?.name === "mas-dev") ? "mas-dev" : "mas";
}

/** True for both store targets. */
export function isStoreTarget(context) {
  return storeTarget(context) !== null;
}

/**
 * The certificate type prefixes to look for, most preferred first. codesign
 * needs a name that matches exactly one certificate, and this team owns
 * Developer ID, Apple Distribution, Apple Development and 3rd Party Mac
 * Developer certificates with the same common name, so the short form on its
 * own is ambiguous. The order mirrors electron-builder's own preference per
 * target (macCodeSign.ts).
 */
export function identityPrefixes(target) {
  switch (target) {
    case "mas":
      return ["Apple Distribution:", "3rd Party Mac Developer Application:"];
    case "mas-dev":
      return ["Apple Development:", "Mac Developer:"];
    default:
      return ["Developer ID Application:"];
  }
}

/** `security find-identity -v -p codesigning`, as text. Injected by tests. */
function defaultFindIdentities() {
  return execFileSync("security", ["find-identity", "-v", "-p", "codesigning"], { encoding: "utf8" });
}

/**
 * The identity electron-builder will use. It reads CSC_NAME, then mac.identity,
 * then auto-discovers from the keychain; this repo's release workflow relies on
 * the last of those, so looking only at CSC_NAME would silently never sign.
 */
export function resolveIdentity({ env = process.env, configured = null, target = null, findIdentities = defaultFindIdentities } = {}) {
  if (env.CSC_IDENTITY_AUTO_DISCOVERY === "false") return null;
  const hint = env.CSC_NAME ?? configured ?? null;

  let names = [];
  try {
    names = [...findIdentities().matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  } catch {
    names = [];
  }

  // Grouped by prefix rather than flattened, so a keychain holding two
  // acceptable types still resolves to the preferred one instead of reading as
  // ambiguous.
  const groups = identityPrefixes(target).map((prefix) => [...new Set(names.filter((n) => n.startsWith(prefix)))]);

  if (hint) {
    for (const group of groups) {
      const full = group.find((c) => c === hint || c.includes(hint));
      if (full) return full;
    }
    // A hint that matches no certificate of the right type is still honoured:
    // it may name something this lookup cannot see, and codesign will say so.
    return hint;
  }

  for (const group of groups) {
    // More than one certificate of the preferred type and no hint is genuinely
    // ambiguous: picking one would sign a release under whichever came first.
    if (group.length > 1) return null;
    if (group.length === 1) return group[0];
  }
  return null;
}


/**
 * Runs codesign, retrying only when Apple's secure timestamp service is the thing
 * that failed. Signing the nested objects happens in a burst - the extension and
 * the addon, once per architecture pass and again for the universal one - and
 * timestamp.apple.com refuses some of them with "A timestamp was expected but was
 * not found." A release that dies there has nothing wrong with it.
 *
 * Any other failure is returned immediately: a missing certificate or a locked
 * keychain will not fix itself on the second attempt.
 *
 * Returns the number of attempts it took.
 */
export function signWithRetry(args, { run = defaultCodesign, attempts = 3, waitMs = 3000 } = {}) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      run(args);
      return attempt;
    } catch (e) {
      lastError = annotate(e);
      const text = `${e?.stderr ?? ""}${e?.stdout ?? ""}${e?.message ?? ""}`;
      if (!/timestamp/i.test(text)) throw lastError;
      if (attempt === attempts) break;
      console.log(
        `[codesign] Apple's timestamp service did not answer; retrying (${attempt}/${attempts - 1})`,
      );
      sleepSync(waitMs);
    }
  }
  throw lastError;
}

/**
 * Puts codesign's own reason into the error message. Node's exec errors say only
 * "Command failed", and the line that matters - errSecInternalComponent, a
 * missing timestamp, an entitlements parse error - is in stderr, where a CI log
 * and a crash report never look.
 */
function annotate(e) {
  const text = `${e?.stderr ?? ""}${e?.stdout ?? ""}`.trim();
  const reason = text.split("\n").filter((l) => l.trim()).pop();
  if (reason && typeof e?.message === "string" && !e.message.includes(reason)) {
    e.message = `${e.message}: ${reason.trim()}`;
  }
  return e;
}

/** codesign, with its output captured so the retry can read the reason, and
 *  echoed so a build log still shows it. */
function defaultCodesign(args) {
  try {
    const out = execFileSync("codesign", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    if (out) process.stdout.write(out);
  } catch (e) {
    if (e?.stderr) process.stderr.write(e.stderr);
    throw e;
  }
}

/** A blocking wait, because everything around it is synchronous. */
function sleepSync(ms) {
  if (ms <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function embedFileProvider({ appPath, identity, version = "0.0.0", buildVersion = version, mustSign = false, target = null }) {
  const store = target !== null;
  const staging = join(dirname(appPath), ".file-provider-staging");
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });

  // The same identifier is stamped into Info.plist and signed into the
  // entitlements (com.apple.application-identifier); TestFlight refuses the
  // build when the two disagree or the entitlement is missing (ITMS-90886).
  const bundleId = store ? STORE_EXTENSION_BUNDLE_ID : DEFAULT_EXTENSION_BUNDLE_ID;
  let built = null;
  try {
    built = buildFileProvider({
      outDir: staging,
      version,
      // App Store Connect rejects an app extension whose CFBundleVersion
      // differs from its containing app's, so the extension is stamped with the
      // app's build version, not with the marketing version.
      buildVersion,
      bundleId,
    });
  } finally {
    if (!built) rmSync(staging, { recursive: true, force: true });
  }
  if (!built) {
    if (mustSign) {
      throw new Error("[file-provider] the extension could not be built, and this build is being signed");
    }
    return { embedded: false, signed: false };
  }

  const plugIns = join(appPath, "Contents", "PlugIns");
  mkdirSync(plugIns, { recursive: true });
  const destination = join(plugIns, "DosyaFileProvider.appex");
  rmSync(destination, { recursive: true, force: true });
  cpSync(built, destination, { recursive: true });

  const teamId = resolveTeamId({ identity });
  const entitlements = materializeEntitlements({ outDir: staging, teamId, bundleId });

  // mas-dev is signed with a Mac App Development profile: the store's
  // distribution profile would be refused at launch on a developer's own Mac.
  const profile = target === "mas" ? EXTENSION_PROFILE_STORE : target === "mas-dev" ? EXTENSION_PROFILE_DEV : EXTENSION_PROFILE;

  // The profile goes INSIDE the bundle, and it has to be there before the
  // signature is made: codesign seals the bundle's contents, so a profile added
  // afterwards would break the seal rather than authorize anything.
  const hasProfile = existsSync(profile);
  if (hasProfile) {
    copyFileSync(profile, join(destination, "Contents", "embedded.provisionprofile"));
  }

  if (identity && !hasProfile) {
    rmSync(staging, { recursive: true, force: true });
    throw new Error(
      `[file-provider] no provisioning profile at ${profile}. Signed without one, ` +
        "macOS kills the extension at launch, so this is fatal rather than a warning.",
    );
  }

  if (!identity || !entitlements) {
    rmSync(staging, { recursive: true, force: true });
    if (mustSign) {
      throw new Error(
        "[file-provider] cannot sign the extension: " +
          (identity ? "no team id (set APPLE_TEAM_ID)" : "no signing identity") +
          ". An app signed around an unsigned extension fails notarization.",
      );
    }
    console.log("[file-provider] unsigned; macOS will not load the extension in this build");
    return { embedded: true, signed: false };
  }

  signWithRetry([
    "--force",
    "--sign", identity,
    "--timestamp",
    // The hardened runtime is a Developer ID concept. The store build is sandboxed
    // instead, and electron-builder signs the app without it, so the nested code matches.
    ...(store ? [] : ["--options", "runtime"]),
    "--entitlements", entitlements,
    destination,
  ]);
  rmSync(staging, { recursive: true, force: true });
  console.log(`[file-provider] signed the extension for team ${teamId}`);
  return { embedded: true, signed: true };
}


/**
 * Builds the Node addon and puts it in Contents/Resources, signed. The main
 * process loads it from there to reach the shared keychain and
 * NSFileProviderManager, neither of which Node can touch.
 *
 * No entitlements are passed, and that is not an omission: a library has none of
 * its own, it runs with the entitlements of the process that loads it, and the
 * process here is the app's, authorized by the app's embedded profile. A
 * keychain group claimed by nested code the profile does not cover is what gets
 * that code killed at launch.
 *
 * It still needs a signature by the same team, or library validation refuses to
 * load it into a hardened-runtime process.
 */
export function embedFileProviderAddon({ appPath, identity, mustSign = false, target = null }) {
  const store = target !== null;
  const staging = join(dirname(appPath), ".file-provider-addon-staging");
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });

  let built = null;
  try {
    built = buildFileProviderAddon({ outDir: staging });
  } finally {
    if (!built) rmSync(staging, { recursive: true, force: true });
  }
  if (!built) {
    if (mustSign) {
      throw new Error("[file-provider-addon] could not be built, and this build is being signed");
    }
    return { embedded: false, signed: false };
  }

  const resources = join(appPath, "Contents", "Resources");
  mkdirSync(resources, { recursive: true });
  const destination = join(resources, ADDON_FILE_NAME);
  rmSync(destination, { force: true });
  copyFileSync(built, destination);
  rmSync(staging, { recursive: true, force: true });

  if (!identity) {
    if (mustSign) {
      throw new Error(
        "[file-provider-addon] cannot sign the addon: no signing identity. An app signed " +
          "around an unsigned binary fails notarization.",
      );
    }
    console.log("[file-provider-addon] unsigned; a signed app would refuse to load it");
    return { embedded: true, signed: false };
  }

  signWithRetry([
    "--force",
    "--sign", identity,
    "--timestamp",
    // The hardened runtime is a Developer ID concept. The store build is sandboxed
    // instead, and electron-builder signs the app without it, so the nested code matches.
    ...(store ? [] : ["--options", "runtime"]),
    destination,
  ]);
  console.log(`[file-provider-addon] signed ${ADDON_FILE_NAME}`);
  return { embedded: true, signed: true };
}

export default async function afterPack(context) {
  const target = storeTarget(context);
  if (context.electronPlatformName !== "darwin" && target === null) return;
  const appPath = join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  const identity = resolveIdentity({ configured: context.packager.platformSpecificBuildOptions?.identity ?? null, target });
  // If the app itself is going to be signed, everything nested inside it must be.
  const mustSign = Boolean(identity);
  embedFileProvider({
    appPath,
    identity,
    version: context.packager.appInfo.version,
    // CFBundleVersion as electron-builder computed it for the app (buildVersion
    // config, BUILD_NUMBER, or the version itself) - the extension must carry
    // the identical value.
    buildVersion: context.packager.appInfo.buildVersion,
    mustSign,
    target,
  });
  embedFileProviderAddon({ appPath, identity, mustSign, target });
}
