import { defaultMenuState, type MenuContext } from "./menu-template.ts";
import type { T } from "../i18n/translator.ts";

/**
 * Contexts the English menu template was captured under at b32e39925, before
 * the right-to-left work. fixtures/menu-template-en-b32e39925.json holds what
 * the builder returned for each: English must still build exactly that.
 */
export const FIXTURE_PAIRS = [
  { pairId: "p1", name: "Photos", localPath: "/Users/a/Photos" },
  { pairId: "p2", name: "Reports 2026", localPath: "/Users/a/Reports" },
];

export function fixtureCases(t: T): { name: string; ctx: MenuContext }[] {
  const base = (over: Partial<MenuContext>): MenuContext => ({
    platform: "darwin",
    isDev: false,
    distribution: "direct",
    updateState: "idle",
    sync: null,
    state: defaultMenuState(),
    t,
    ...over,
  });
  const files = { ...defaultMenuState(), route: "/files", viewMode: "table" as const, selectionCount: 1, canGoBack: true };
  const sync = { summary: "All synced", globalPaused: false, unresolvedConflicts: 2, pairs: FIXTURE_PAIRS };
  const out: { name: string; ctx: MenuContext }[] = [];
  for (const platform of ["darwin", "win32", "linux"] as const) {
    out.push({ name: `${platform} default`, ctx: base({ platform }) });
    out.push({ name: `${platform} files + sync`, ctx: base({ platform, state: files, sync }) });
    out.push({ name: `${platform} one pair, dev, update ready`, ctx: base({ platform, isDev: true, updateState: "ready", sync: { ...sync, pairs: [FIXTURE_PAIRS[0]], unresolvedConflicts: 0 } }) });
  }
  out.push({ name: "mas store", ctx: base({ distribution: "mas", state: { ...files, route: "/text-editor/x", signedIn: false } }) });
  return out;
}
