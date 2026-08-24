/**
 * Turning a dropped folder into a flat list of files with their relative paths.
 *
 * `dataTransfer.files` cannot do this. A dropped directory still puts ONE entry
 * in that list - a phantom File named after the folder, carrying the directory's
 * inode size (128 on macOS, so a `size === 0` guard does not catch it) and an
 * empty type. Reading its bytes throws NotFoundError, which surfaced here as a
 * generic "could not be uploaded". The only way to see a directory's contents is
 * the FileSystem Entry API: dataTransfer.items -> webkitGetAsEntry().
 *
 * Port of apps/web/src/lib/dropped-entries.ts. The two are deliberately
 * separate copies: the desktop and web bundles are built and released
 * independently, and this repo vendors rather than cross-imports app code
 * (see apps/web/vendor). Fix bugs in both.
 */

/** One file to upload, with the folder path it should land in. */
export interface DroppedEntry {
  /** Folder path relative to the drop target; '' means the target itself. */
  path: string;
  file: File;
}

export interface DroppedTree {
  entries: DroppedEntry[];
  /** Every directory walked, including empty ones, so they can be recreated. */
  dirs: string[];
  /** True when the drop contained at least one directory. */
  hadDirectory: boolean;
  /** Files left out because the batch hit the cap. */
  skipped: number;
}

/**
 * Upper bound on one drop. A folder tree has no natural size limit and this
 * uploader runs the files one at a time, so an unbounded drop is a transfer
 * with no visible end. Anything above this is reported, never silently dropped.
 */
export const MAX_DROPPED_FILES = 2000;

/** OS bookkeeping files - never what someone means to upload. */
const JUNK = new Set([".ds_store", "thumbs.db", "desktop.ini"]);

function isJunk(name: string): boolean {
  // '._foo' is the AppleDouble sidecar written onto non-HFS volumes.
  return JUNK.has(name.toLowerCase()) || name.startsWith("._");
}

const join = (parent: string, name: string) => (parent ? `${parent}/${name}` : name);

function toFile(entry: FileSystemFileEntry): Promise<File | null> {
  return new Promise((resolve) => {
    // A file deleted between the drop and the read rejects here; one unreadable
    // file must not abandon the rest of the tree.
    entry.file((f) => resolve(f), () => resolve(null));
  });
}

/**
 * Read a directory to exhaustion.
 *
 * readEntries hands back a bounded batch (~100 entries in Chromium) and signals
 * the end with an empty array, so a single call silently truncates any large
 * folder. It must be called in a loop.
 */
function readAll(dir: FileSystemDirectoryEntry): Promise<FileSystemEntry[]> {
  const reader = dir.createReader();
  const out: FileSystemEntry[] = [];
  return new Promise((resolve) => {
    const pump = () => {
      reader.readEntries(
        (batch) => {
          if (batch.length === 0) { resolve(out); return; }
          out.push(...batch);
          pump();
        },
        () => resolve(out),
      );
    };
    pump();
  });
}

/**
 * Walk dropped items into files plus their folder paths.
 *
 * MUST be called synchronously from the drop handler: `dataTransfer.items` is
 * only valid for the duration of the event, so the entry objects are taken
 * before the first await.
 */
export async function readDroppedEntries(
  dt: DataTransfer,
  max: number = MAX_DROPPED_FILES,
): Promise<DroppedTree> {
  // ── synchronous phase ──
  const roots: FileSystemEntry[] = [];
  let entryApi = false;
  for (const item of Array.from(dt.items ?? [])) {
    const get = (item as DataTransferItem & {
      webkitGetAsEntry?: () => FileSystemEntry | null;
    }).webkitGetAsEntry;
    if (typeof get !== "function") continue;
    entryApi = true;
    const entry = get.call(item);
    if (entry) roots.push(entry);
  }
  const looseFiles = entryApi ? [] : Array.from(dt.files ?? []);

  // ── async phase ──
  const tree: DroppedTree = { entries: [], dirs: [], hadDirectory: false, skipped: 0 };

  for (const file of looseFiles) {
    if (isJunk(file.name)) continue;
    if (tree.entries.length >= max) { tree.skipped++; continue; }
    tree.entries.push({ path: "", file });
  }

  const visit = async (entry: FileSystemEntry, parent: string): Promise<void> => {
    if (isJunk(entry.name)) return;
    if (entry.isDirectory) {
      tree.hadDirectory = true;
      const path = join(parent, entry.name);
      tree.dirs.push(path);
      for (const child of await readAll(entry as FileSystemDirectoryEntry)) {
        await visit(child, path);
      }
      return;
    }
    if (!entry.isFile) return;
    // Past the cap, keep walking to report an honest count but stop paying for
    // file handles.
    if (tree.entries.length >= max) { tree.skipped++; return; }
    const file = await toFile(entry as FileSystemFileEntry);
    if (file) tree.entries.push({ path: parent, file });
  };

  for (const root of roots) await visit(root, "");
  return tree;
}

const depth = (p: string) => p.split("/").length;

/**
 * Every folder that has to exist, ordered so a parent is always created before
 * its children - the create call needs its parent's id.
 */
export function orderedDirs(tree: DroppedTree): string[] {
  const all = new Set<string>();
  const add = (path: string) => {
    if (!path) return;
    const parts = path.split("/");
    for (let i = 1; i <= parts.length; i++) all.add(parts.slice(0, i).join("/"));
  };
  for (const d of tree.dirs) add(d);
  for (const e of tree.entries) add(e.path);
  return [...all].sort((a, b) => depth(a) - depth(b) || a.localeCompare(b));
}

export interface FolderPlan {
  /** Relative dir path -> server folder id. */
  ids: Map<string, string>;
  /** Paths that could not be created, plus everything beneath them. */
  failed: string[];
  error?: string;
}

/**
 * Create the folders one level at a time, sequentially.
 *
 * Levels are a correctness boundary: a child needs its parent's id. This
 * uploader is serial anyway, so there is nothing to gain from running siblings
 * concurrently - and staying serial keeps concurrent creates of the same
 * root-level name (where the server's UNIQUE index ignores a NULL parent) off
 * the table entirely.
 */
export async function createFolderTree(
  dirs: string[],
  rootId: string | null,
  create: (name: string, parentId: string | null) => Promise<string>,
): Promise<FolderPlan> {
  const plan: FolderPlan = { ids: new Map(), failed: [] };
  const parentPath = (p: string) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");
  const leaf = (p: string) => p.slice(p.lastIndexOf("/") + 1);

  for (const path of dirs) {
    const parent = parentPath(path);
    // A folder whose parent never got created has nowhere to go. Skipping the
    // whole subtree keeps its files out of the root rather than flattening the
    // tree the user dropped.
    if (parent && !plan.ids.has(parent)) { plan.failed.push(path); continue; }
    try {
      plan.ids.set(path, await create(leaf(path), parent ? plan.ids.get(parent)! : rootId));
    } catch (err) {
      plan.failed.push(path);
      plan.error ??= err instanceof Error ? err.message : "Could not create folder";
    }
  }
  return plan;
}

/**
 * Pair every file with the folder id its path resolved to. Files under a folder
 * that failed are reported, never redirected somewhere the user did not ask for.
 */
export function resolveTargets(
  entries: DroppedEntry[],
  plan: Pick<FolderPlan, "ids">,
  rootId: string | null,
): { targets: { file: File; folderId: string | null }[]; skipped: number } {
  const targets: { file: File; folderId: string | null }[] = [];
  let skipped = 0;
  for (const entry of entries) {
    if (!entry.path) { targets.push({ file: entry.file, folderId: rootId }); continue; }
    const id = plan.ids.get(entry.path);
    if (!id) { skipped++; continue; }
    targets.push({ file: entry.file, folderId: id });
  }
  return { targets, skipped };
}
