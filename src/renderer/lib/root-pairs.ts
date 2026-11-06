import { useEffect, useMemo, useState } from "react";
import { mayShowDefaultName, pairFolderLabel, rootPairIds } from "../../main/sync-pair-label";
import { useT } from "./i18n";

// Whether each pair syncs a workspace root, from the pair config. Shared by
// every screen and row that asks, and kept: a pair never changes between
// root and folder.
const known = new Map<string, boolean>();
let inflight: Promise<void> | null = null;

function readConfig(asked: readonly string[]): Promise<void> {
  if (inflight) return inflight;
  const done = Promise.resolve(window.electronAPI.getSyncConfig?.())
    .then((cfg: { pairs?: { id: string; remoteFolderId?: string | null }[] } | undefined) => {
      const pairs = cfg?.pairs ?? [];
      const roots = rootPairIds(pairs);
      for (const p of pairs) known.set(p.id, roots.has(p.id));
      // A pair the config does not list (yet) shows its name as stored.
      for (const id of asked) if (!known.has(id)) known.set(id, false);
    })
    .finally(() => {
      inflight = null;
    });
  inflight = done;
  return done;
}

/**
 * The ids of the given pairs that sync a workspace root, so their stored
 * default name ("Root") can be shown in the chosen language
 * (pairFolderLabel). The runtime status does not carry remoteFolderId, so
 * this reads the pair config, and only for pairs that carry that name:
 * screens with no such pair never touch the engine.
 */
export function useRootPairIds(pairs: readonly { pairId: string; remoteFolderName: string }[]): ReadonlySet<string> {
  const candidates = pairs.filter(mayShowDefaultName).map((p) => p.pairId).sort().join("\n");
  const [version, setVersion] = useState(0);

  useEffect(() => {
    if (!candidates) return;
    const ids = candidates.split("\n");
    if (ids.every((id) => known.has(id))) return;
    let cancelled = false;
    readConfig(ids)
      .then(() => {
        if (!cancelled) setVersion((v) => v + 1);
      })
      .catch(() => {
        // Unreadable config: the names stay as stored.
      });
    return () => {
      cancelled = true;
    };
  }, [candidates]);

  return useMemo(
    () => new Set(candidates ? candidates.split("\n").filter((id) => known.get(id)) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [candidates, version],
  );
}

/** The folder name to show for each of `pairs`: "Root" on a root pair in the chosen language, any other name as stored. */
export function usePairFolderLabel(
  pairs: readonly { pairId: string; remoteFolderName: string }[],
): (pair: { pairId: string; remoteFolderName: string }) => string {
  const t = useT();
  const roots = useRootPairIds(pairs);
  return (pair) => pairFolderLabel(pair.remoteFolderName, roots.has(pair.pairId), t);
}
