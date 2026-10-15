// apps/web/src/lib/archive-save.ts
//
// Saving a whole subtree of an archive into a dosya folder, driven from the
// browser: the server saves ONE entry per request, so the pane plans the
// folder structure, creates it level by level, then saves files one at a
// time. Kept free of React and fetch so the awkward parts (relative paths,
// skipped entries, a refused folder, cancellation) are tested on plain data.
//
// This file is copied VERBATIM into web, desktop and mobile (test-all diffs the
// three, as it does archive-tree.ts). It therefore imports nothing: the node
// shape below is the structural subset of each app's TreeNode that it reads.

/** What this module reads off an archive-tree node. Every app's TreeNode fits. */
export interface SaveTreeNode {
  kind: 'dir' | 'file';
  name: string;
  index: number | null;
  method: number;
  encrypted: boolean;
  children: SaveTreeNode[];
}

/** Past this, the honest answer is "save smaller folders or download". The
 *  trigger for a server-side job model, if one is ever needed. */
export const MAX_FOLDER_SAVE_FILES = 500;

/** Compression methods the server will actually stream (store and deflate). */
const OPENABLE_METHODS = new Set([0, 8]);

export interface SavePlanFile { index: number; relDir: string[]; name: string }
export interface SavePlan {
  rootName: string;
  /** Distinct directories beneath the root, shallow first. */
  dirs: string[][];
  files: SavePlanFile[];
  skipped: { name: string; reason: string }[];
}

export function planFolderSave(nodes: SaveTreeNode[], rootName: string): SavePlan | { tooMany: number } {
  const files: SavePlanFile[] = [];
  const dirs: string[][] = [];
  const skipped: { name: string; reason: string }[] = [];
  const walk = (list: SaveTreeNode[], rel: string[]) => {
    for (const n of list) {
      if (n.kind === 'dir') {
        dirs.push([...rel, n.name]);
        walk(n.children, [...rel, n.name]);
        continue;
      }
      if (n.index === null) continue;
      if (n.encrypted) { skipped.push({ name: n.name, reason: 'password-protected' }); continue; }
      if (!OPENABLE_METHODS.has(n.method)) {
        skipped.push({ name: n.name, reason: `unsupported compression (method ${n.method})` });
        continue;
      }
      files.push({ index: n.index, relDir: rel, name: n.name });
    }
  };
  walk(nodes, []);
  if (files.length > MAX_FOLDER_SAVE_FILES) return { tooMany: files.length };
  // Stable: siblings keep the tree's order, parents always precede children.
  dirs.sort((a, b) => a.length - b.length);
  return { rootName, dirs, files, skipped };
}

export interface SaveRunnerDeps {
  /** Create (or find) folders by name under one parent; answers name to id. */
  createFolders(parentId: string | null, names: string[]): Promise<Map<string, string>>;
  saveEntry(index: number, folderId: string | null, name: string): Promise<{ file_id: string; name: string }>;
  /** Called once up front with 0, then after every attempted file. */
  onProgress(done: number, total: number): void;
  isCancelled(): boolean;
}

export interface SaveOutcome {
  saved: number;
  failed: { name: string; message: string }[];
  skipped: number;
  cancelled: boolean;
  rootFolderId: string | null;
}

const messageOf = (err: unknown) => (err instanceof Error && err.message) || 'Request failed';
const joinPath = (parts: string[]) => parts.join('/');

export async function runFolderSave(plan: SavePlan, destFolderId: string | null, deps: SaveRunnerDeps): Promise<SaveOutcome> {
  const failed: SaveOutcome['failed'] = [];
  const total = plan.files.length;
  deps.onProgress(0, total);

  // The wrapping folder. A refusal here is the whole save's refusal: nothing
  // else is attempted, and the message is the server's own.
  let rootId: string | null;
  try {
    rootId = (await deps.createFolders(destFolderId, [plan.rootName])).get(plan.rootName) ?? null;
    if (!rootId) throw new Error('Folder could not be created');
  } catch (err) {
    return {
      saved: 0, failed: [{ name: plan.rootName, message: messageOf(err) }],
      skipped: plan.skipped.length, cancelled: false, rootFolderId: null,
    };
  }

  // Each level: one request per parent that has children at that depth. A
  // folder whose parent failed is not requested; its files are skipped below
  // because no id ever resolves for them.
  const idFor = new Map<string, string>([['', rootId]]);
  for (let depth = 1; ; depth++) {
    const level = plan.dirs.filter((d) => d.length === depth);
    if (level.length === 0) break;
    const byParent = new Map<string, string[]>();
    for (const d of level) {
      const parent = joinPath(d.slice(0, -1));
      if (!idFor.has(parent)) continue;
      byParent.set(parent, [...(byParent.get(parent) ?? []), d[d.length - 1]!]);
    }
    for (const [parent, names] of byParent) {
      const pathOf = (n: string) => (parent ? `${parent}/${n}` : n);
      let made: Map<string, string>;
      try {
        made = await deps.createFolders(idFor.get(parent)!, names);
      } catch (err) {
        for (const n of names) failed.push({ name: pathOf(n), message: messageOf(err) });
        continue;
      }
      for (const n of names) {
        const id = made.get(n);
        if (id) idFor.set(pathOf(n), id);
        else failed.push({ name: pathOf(n), message: 'Folder could not be created' });
      }
    }
  }

  let saved = 0;
  let attempted = 0;
  let cancelled = false;
  for (const f of plan.files) {
    if (deps.isCancelled()) { cancelled = true; break; }
    const folderId = idFor.get(joinPath(f.relDir));
    if (!folderId) {
      // Its folder is already in `failed`; the file is listed too, so the
      // summary's counts add up to the plan and the user can find what did not
      // land.
      failed.push({ name: joinPath([...f.relDir, f.name]), message: 'Its folder could not be created' });
    } else {
      try {
        await deps.saveEntry(f.index, folderId, f.name);
        saved++;
      } catch (err) {
        failed.push({ name: joinPath([...f.relDir, f.name]), message: messageOf(err) });
      }
    }
    attempted++;
    deps.onProgress(attempted, total);
  }
  return { saved, failed, skipped: plan.skipped.length, cancelled, rootFolderId: rootId };
}
