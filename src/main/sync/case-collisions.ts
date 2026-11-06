/**
 * Remote names that cannot coexist on this device's filesystem.
 *
 * The server stores "Foo.txt" and "foo.txt" as two files; macOS and Windows
 * put both at one path. Downloading them one over the other and then
 * reconciling "the" local file against two base rows is how one cloud copy
 * gets deleted and overwritten by the other's bytes (index-db.ts, the
 * comment on files_by_path). The reconciler asks here, and leaves every
 * member of a collision group out of the plan until a human renames one.
 *
 * Leaf module so node --test can load it.
 */
export interface RemotePathRef {
  remoteId: string;
  relPath: string;
}

export function findCaseCollisions(
  paths: Iterable<RemotePathRef>,
  foldsCase: boolean,
): Map<string, RemotePathRef[]> {
  const byKey = new Map<string, RemotePathRef[]>();
  for (const p of paths) {
    const nfc = p.relPath.normalize("NFC");
    const key = foldsCase ? nfc.toLowerCase() : nfc;
    const group = byKey.get(key);
    if (group) group.push(p);
    else byKey.set(key, [p]);
  }
  for (const [key, group] of byKey) if (group.length < 2) byKey.delete(key);
  return byKey;
}

/**
 * Marker for the Sync page rows the engine writes for a collision. The row
 * type has no kind field, so rows are recognised by this fixed sentence
 * fragment of the message (see SyncEngine.recordCaseCollisions). The engine
 * clears them before every reconcile so a renamed twin is no longer blocked.
 */
export const CASE_COLLISION_MARKER = " differ only by letter case. This device cannot keep both";

export function isCaseCollisionError(err: { error: string }): boolean {
  return err.error.includes(CASE_COLLISION_MARKER);
}

export const FOLDS_CASE = process.platform === "darwin" || process.platform === "win32";
