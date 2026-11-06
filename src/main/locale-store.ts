/**
 * The chosen UI language, persisted as `<dir>/locale.json` so the main
 * process (menus, tray) and the renderer agree across restarts. Any read or
 * parse failure falls back to English: a corrupt file must never block boot.
 */

import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { isLocale, type Locale } from "../i18n/locales.ts";

const FILE = "locale.json";

export async function readLocale(dir: string): Promise<Locale> {
  try {
    const parsed: unknown = JSON.parse(await readFile(join(dir, FILE), "utf8"));
    const value = (parsed as { locale?: unknown } | null)?.locale;
    return isLocale(value) ? value : "en";
  } catch {
    return "en";
  }
}

/** Temp file + rename, so a crash mid-write cannot leave a truncated file. */
export async function writeLocale(dir: string, locale: Locale): Promise<void> {
  await mkdir(dir, { recursive: true });
  // Unique per write, so two concurrent writes never share a temp file.
  const tmp = join(dir, `${FILE}.${randomUUID()}.tmp`);
  try {
    await writeFile(tmp, JSON.stringify({ locale }), "utf8");
    await rename(tmp, join(dir, FILE));
  } catch (err) {
    await rm(tmp, { force: true });
    throw err;
  }
}
