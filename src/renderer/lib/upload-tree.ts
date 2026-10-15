/**
 * Group a flat upload queue back into the folder tree it came from, so a folder
 * upload reads as folders with progress instead of hundreds of unrelated rows.
 *
 * Generic over the queue item: callers describe each item through `view`, which
 * keeps this independent of the page's own queue shape. Port of
 * apps/web/src/lib/upload-tree.ts - deliberately separate copies, as with
 * dropped-entries.ts. Fix bugs in both.
 */

/** What the tree needs to know about one queued file. */
export interface UploadLeaf {
  /** Folder path inside the upload ("Photos/2024"); "" for a loose file. */
  path: string;
  size: number;
  bytesDone: number;
  state: "pending" | "active" | "done" | "error";
}

export interface UploadFolderNode<T> {
  kind: "folder";
  /** Full path, unique within the tree. */
  path: string;
  name: string;
  children: UploadTreeNode<T>[];
  /** Every item anywhere beneath this folder, in queue order. */
  items: T[];
  fileCount: number;
  doneCount: number;
  errorCount: number;
  activeCount: number;
  totalBytes: number;
  doneBytes: number;
}

export interface UploadFileNode<T> {
  kind: "file";
  item: T;
}

export type UploadTreeNode<T> = UploadFolderNode<T> | UploadFileNode<T>;

export function buildUploadTree<T>(items: T[], view: (item: T) => UploadLeaf): UploadTreeNode<T>[] {
  // Folders and files are kept apart per level so folders list first; Map
  // insertion order keeps each in first-seen queue order.
  type Level = { folders: Map<string, UploadFolderNode<T>>; files: UploadFileNode<T>[] };
  const levels = new Map<UploadFolderNode<T> | null, Level>();
  const levelOf = (owner: UploadFolderNode<T> | null): Level => {
    let level = levels.get(owner);
    if (!level) { level = { folders: new Map(), files: [] }; levels.set(owner, level); }
    return level;
  };

  for (const item of items) {
    const leaf = view(item);
    let owner: UploadFolderNode<T> | null = null;
    let path = "";
    for (const name of leaf.path ? leaf.path.split("/") : []) {
      path = path ? `${path}/${name}` : name;
      const level = levelOf(owner);
      let folder = level.folders.get(name);
      if (!folder) {
        folder = {
          kind: "folder", path, name, children: [], items: [],
          fileCount: 0, doneCount: 0, errorCount: 0, activeCount: 0, totalBytes: 0, doneBytes: 0,
        };
        level.folders.set(name, folder);
      }
      folder.items.push(item);
      folder.fileCount++;
      folder.totalBytes += leaf.size;
      if (leaf.state === "done") { folder.doneCount++; folder.doneBytes += leaf.size; }
      else if (leaf.state === "error") folder.errorCount++;
      else if (leaf.state === "active") { folder.activeCount++; folder.doneBytes += leaf.bytesDone; }
      owner = folder;
    }
    levelOf(owner).files.push({ kind: "file", item });
  }

  const assemble = (owner: UploadFolderNode<T> | null): UploadTreeNode<T>[] => {
    const level = levels.get(owner);
    if (!level) return [];
    const folders = [...level.folders.values()];
    for (const folder of folders) folder.children = assemble(folder);
    return [...folders, ...level.files];
  };
  return assemble(null);
}

export interface UploadTreeRow<T> {
  node: UploadTreeNode<T>;
  depth: number;
}

/** Depth-first rows to render; a closed folder shows but its contents do not. */
export function visibleRows<T>(
  nodes: UploadTreeNode<T>[],
  isOpen: (folder: UploadFolderNode<T>) => boolean,
  depth = 0,
  out: UploadTreeRow<T>[] = [],
): UploadTreeRow<T>[] {
  for (const node of nodes) {
    out.push({ node, depth });
    if (node.kind === "folder" && isOpen(node)) visibleRows(node.children, isOpen, depth + 1, out);
  }
  return out;
}
