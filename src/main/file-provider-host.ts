/**
 * The parts of the Finder integration that touch the machine: finding and
 * loading the native addon, minting the extension's session, and remembering
 * whether the user wants the location at all.
 *
 * Deliberately free of `electron` imports so the whole file runs under
 * node:test. Everything Electron knows - whether the build is packaged, where
 * its resources are, where userData lives, what the cookie jar holds - arrives
 * as an argument from ipc.ts.
 */
import { createRequire } from "node:module";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { FileProviderNative, MintedSession } from "./file-provider.ts";

/** Must match ADDON_FILE_NAME in scripts/build-file-provider-addon.mjs. */
export const ADDON_FILE_NAME = "dosya-file-provider.node";

/** The file the preference lives in, inside Electron's userData directory. */
const PREFERENCE_FILE = "file-provider.json";

/**
 * Where the addon is. afterPack puts it in Contents/Resources of the packaged
 * app; a dev run has no such directory, so it comes from `out`, where
 * `node scripts/build-file-provider-addon.mjs` writes it. A dev machine that has
 * never run that script simply has no Finder location, which is the same
 * degradation as a non-macOS build.
 */
export function addonPath({
  packaged,
  resourcesPath,
  appRoot,
}: {
  packaged: boolean;
  resourcesPath: string;
  appRoot: string;
}): string {
  return packaged ? join(resourcesPath, ADDON_FILE_NAME) : join(appRoot, "out", ADDON_FILE_NAME);
}

/**
 * The addon, or null when there is none to load. Never throws: a missing addon,
 * a signature the loader refuses, an architecture mismatch - each means no
 * Finder location, and none of them may stop the app from starting.
 *
 * `createRequire` is given the addon's own path rather than a module URL so this
 * works the same whether the main process was bundled to CJS or ESM.
 */
export function loadAddon(path: string): FileProviderNative | null {
  try {
    const loaded = createRequire(path)(path) as FileProviderNative;
    if (typeof loaded?.isSupported !== "function") {
      console.warn("[fileProvider] the addon at", path, "is not the one this build expects");
      return null;
    }
    return loaded;
  } catch (e) {
    console.warn("[fileProvider] no addon:", e instanceof Error ? e.message : e);
    return null;
  }
}

/**
 * Whether the user wants a Finder location. Defaults to on: the location IS the
 * feature, and iOS links without asking. Anything unreadable or unrecognised
 * also reads as on, so a corrupt file does not silently take the feature away.
 */
export async function readPreference(dir: string): Promise<boolean> {
  try {
    const raw = await readFile(join(dir, PREFERENCE_FILE), "utf8");
    return (JSON.parse(raw) as { enabled?: unknown }).enabled === false ? false : true;
  } catch {
    return true;
  }
}

export async function writePreference(dir: string, enabled: boolean): Promise<void> {
  await writeFile(join(dir, PREFERENCE_FILE), JSON.stringify({ enabled }), "utf8");
}

export interface MintDeps {
  /** The session cookie as a ready `name=value` header, or null when signed out. */
  cookieHeader: () => Promise<string | null>;
  fetch: typeof globalThis.fetch;
}

/**
 * Mints the extension a session of its own through
 * POST /api/auth/desktop/linked-session (migration 0185). Authenticated by the
 * desktop's session cookie, which is the only credential this process holds.
 *
 * Throws on anything short of a usable pair, including a 200 whose body is
 * missing a token: writing a session the extension can never use would leave
 * Finder asking to sign in, and the caller's contract is that a failed mint
 * leaves whatever was stored alone.
 */
export async function mintLinkedSession(apiBase: string, deps: MintDeps): Promise<MintedSession> {
  const cookie = await deps.cookieHeader();
  if (!cookie) throw new Error("not signed in");

  const res = await deps.fetch(`${apiBase}/api/auth/desktop/linked-session`, {
    method: "POST",
    headers: { Cookie: cookie, "Content-Type": "application/json" },
    body: JSON.stringify({ purpose: "files-macos" }),
  });
  if (!res.ok) throw new Error(`the linked session was refused (${res.status})`);

  const body = (await res.json()) as { access_token?: unknown; refresh_token?: unknown };
  const access = typeof body.access_token === "string" ? body.access_token : "";
  const refresh = typeof body.refresh_token === "string" ? body.refresh_token : "";
  if (!access || !refresh) throw new Error("the linked session came back without a token pair");

  return { access, refresh, apiBaseUrl: apiBase };
}
