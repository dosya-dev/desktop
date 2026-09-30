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
import { buildFileProvider, materializeEntitlements, resolveTeamId } from "./build-file-provider.mjs";
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
 * The identity electron-builder will use. It reads CSC_NAME, then mac.identity,
 * then auto-discovers from the keychain; this repo's release workflow relies on
 * the last of those, so looking only at CSC_NAME would silently never sign.
 */
export function resolveIdentity({ env = process.env, configured = null } = {}) {
  if (env.CSC_IDENTITY_AUTO_DISCOVERY === "false") return null;
  const hint = env.CSC_NAME ?? configured ?? null;

  // codesign needs a name that matches exactly one certificate. electron-builder
  // takes the identity WITHOUT the "Developer ID Application:" prefix, and this
  // team also owns Apple Distribution and 3rd Party Mac Developer certificates
  // with the same common name, so the short form on its own is ambiguous.
  let candidates = [];
  try {
    const found = execFileSync("security", ["find-identity", "-v", "-p", "codesigning"], { encoding: "utf8" });
    candidates = [...found.matchAll(/"(Developer ID Application:[^"]+)"/g)].map((m) => m[1]);
  } catch {
    candidates = [];
  }

  if (hint) {
    const full = candidates.find((c) => c === hint || c.includes(hint));
    if (full) return full;
    // A hint that matches no Developer ID certificate is still honoured: it may
    // name something this lookup cannot see, and codesign will say so plainly.
    return hint;
  }

  const unique = [...new Set(candidates)];
  return unique.length === 1 ? unique[0] : null;
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

export function embedFileProvider({ appPath, identity, version = "0.0.0", mustSign = false }) {
  const staging = join(dirname(appPath), ".file-provider-staging");
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });

  let built = null;
  try {
    built = buildFileProvider({ outDir: staging, version });
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
  const entitlements = materializeEntitlements({ outDir: staging, teamId });

  // The profile goes INSIDE the bundle, and it has to be there before the
  // signature is made: codesign seals the bundle's contents, so a profile added
  // afterwards would break the seal rather than authorize anything.
  const hasProfile = existsSync(EXTENSION_PROFILE);
  if (hasProfile) {
    copyFileSync(EXTENSION_PROFILE, join(destination, "Contents", "embedded.provisionprofile"));
  }

  if (identity && !hasProfile) {
    rmSync(staging, { recursive: true, force: true });
    throw new Error(
      `[file-provider] no provisioning profile at ${EXTENSION_PROFILE}. Signed without one, ` +
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
    // The hardened runtime the app uses, applied to the nested code too.
    "--options", "runtime",
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
export function embedFileProviderAddon({ appPath, identity, mustSign = false }) {
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
    "--options", "runtime",
    destination,
  ]);
  console.log(`[file-provider-addon] signed ${ADDON_FILE_NAME}`);
  return { embedded: true, signed: true };
}

export default async function afterPack(context) {
  if (context.electronPlatformName !== "darwin") return;
  const appPath = join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  const identity = resolveIdentity({ configured: context.packager.platformSpecificBuildOptions?.identity ?? null });
  // If the app itself is going to be signed, everything nested inside it must be.
  const mustSign = Boolean(identity);
  embedFileProvider({
    appPath,
    identity,
    version: context.packager.appInfo.version,
    mustSign,
  });
  embedFileProviderAddon({ appPath, identity, mustSign });
}
