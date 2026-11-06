// apps/desktop/src/renderer/lib/text-drafts.ts
//
// Unsaved editor text kept in localStorage, so a crash or a forced quit does
// not lose an edit. Saving is explicit (every save is a new version), which is
// exactly why the in-between text needs somewhere to live.
//
// Keyed by workspace, file and the version the edit started from: a draft
// written against v3 is about v3's text. Storage can be missing or throw
// (private mode, cleared site data), so every access is guarded and a failure
// simply means "no draft".
//
// Framework-free with no "@/" imports, so it runs under `node --test`
// (text-drafts.test.ts).

export type DraftStorage = Pick<Storage, "getItem" | "setItem" | "removeItem" | "key" | "length">;

export interface DraftRef { workspaceId: string; fileId: string; version: number }
export interface Draft { text: string; savedAt: number }

const PREFIX = "dosya_text_draft:";

export function draftKey(ref: DraftRef): string {
  return `${PREFIX}${ref.workspaceId}:${ref.fileId}:v${ref.version}`;
}

export function saveDraft(storage: DraftStorage, ref: DraftRef, text: string, now: number): void {
  try {
    storage.setItem(draftKey(ref), JSON.stringify({ text, savedAt: now }));
  } catch { /* full or unavailable: the edit is still in the editor */ }
}

export function loadDraft(storage: DraftStorage, ref: DraftRef): Draft | null {
  try {
    const raw = storage.getItem(draftKey(ref));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<Draft>;
    if (typeof parsed.text !== "string" || typeof parsed.savedAt !== "number") return null;
    return { text: parsed.text, savedAt: parsed.savedAt };
  } catch {
    return null;
  }
}

/** Every version's draft of one file; other files are left alone. */
export function clearDrafts(storage: DraftStorage, file: { workspaceId: string; fileId: string }): void {
  const prefix = `${PREFIX}${file.workspaceId}:${file.fileId}:v`;
  try {
    const doomed: string[] = [];
    for (let i = 0; i < storage.length; i++) {
      const k = storage.key(i);
      if (k && k.startsWith(prefix)) doomed.push(k);
    }
    for (const k of doomed) storage.removeItem(k);
  } catch { /* nothing to clear if storage is unavailable */ }
}

/**
 * The draft worth offering when the file opens: written after the file last
 * changed (`updatedAtSec` is the API's seconds) and different from what was
 * loaded. Anything else is stale or already saved.
 */
export function draftToOffer(
  storage: DraftStorage,
  ref: DraftRef,
  file: { text: string; updatedAtSec: number },
): Draft | null {
  const draft = loadDraft(storage, ref);
  if (!draft) return null;
  if (draft.savedAt <= file.updatedAtSec * 1000) return null;
  if (draft.text === file.text) return null;
  return draft;
}
