/**
 * Drag-to-move inside the Files page: which items a drag carries, what it
 * says on the wire, and which folders may take the drop.
 *
 * Kept free of React and of the page's state so it can be tested on Node's
 * own runner (`npm run test:unit`).
 */

/**
 * The dataTransfer type every in-app move drag carries. A drag from the OS
 * never has it, which is how the upload drop zone tells the two apart: it
 * ignores anything carrying this type, and the move targets ignore anything
 * that does not.
 */
export const DRAG_MOVE_TYPE = "application/x-dosya-move";

export interface DragItem {
  id: string;
  kind: "file" | "folder";
}

/** What one drag carries. `name` is the dragged item's own name, for the one-item confirm. */
export interface MovePayload {
  fileIds: string[];
  folderIds: string[];
  name: string;
}

/**
 * The items a drag carries. Dragging an item that is part of the current
 * selection moves the whole selection, files and folders alike; dragging
 * anything else moves just that item and leaves the selection alone, the way
 * a file manager does.
 */
export function dragItems(
  item: DragItem,
  selectedFiles: ReadonlySet<string>,
  selectedFolders: ReadonlySet<string>,
): { fileIds: string[]; folderIds: string[]; fromSelection: boolean } {
  const inSelection = item.kind === "file" ? selectedFiles.has(item.id) : selectedFolders.has(item.id);
  if (!inSelection) {
    return item.kind === "file"
      ? { fileIds: [item.id], folderIds: [], fromSelection: false }
      : { fileIds: [], folderIds: [item.id], fromSelection: false };
  }
  return { fileIds: [...selectedFiles], folderIds: [...selectedFolders], fromSelection: true };
}

export function itemCount(p: Pick<MovePayload, "fileIds" | "folderIds">): number {
  return p.fileIds.length + p.folderIds.length;
}

/** True when a drag carries an in-app move rather than files from the OS. */
/**
 * True when the drag carries files from the computer (the OS sets "Files"),
 * not an in-app move. Those upload; dropped on a folder, into that folder.
 */
export function isOsFileDrag(types: ArrayLike<string> | null | undefined): boolean {
  if (!types || isMoveDrag(types)) return false;
  for (let i = 0; i < types.length; i++) if (types[i] === "Files") return true;
  return false;
}

export function isMoveDrag(types: ArrayLike<string> | null | undefined): boolean {
  if (!types) return false;
  for (let i = 0; i < types.length; i++) if (types[i] === DRAG_MOVE_TYPE) return true;
  return false;
}

/** "" is the URL's spelling of the workspace root; the API speaks null. */
function normalize(id: string | null | undefined): string | null {
  return id ? id : null;
}

/**
 * Whether `targetId` (null = the workspace root) may take this drop. A folder
 * cannot go into itself, so no folder being dragged is a target; and the
 * folder the items already sit in is not one either, since nothing would move.
 * Dropping a folder into its own subfolder cannot happen from here (the
 * targets are siblings in the listing or ancestors on the breadcrumb), and the
 * server refuses it anyway.
 */
export function isValidDropTarget(
  targetId: string | null,
  payload: Pick<MovePayload, "fileIds" | "folderIds">,
  currentFolderId: string | null,
): boolean {
  if (itemCount(payload) === 0) return false;
  const target = normalize(targetId);
  if (target === normalize(currentFolderId)) return false;
  if (target !== null && payload.folderIds.includes(target)) return false;
  return true;
}

export function encodeMovePayload(p: MovePayload): string {
  return JSON.stringify({ v: 1, files: p.fileIds, folders: p.folderIds, name: p.name });
}

const isStringArray = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every((x) => typeof x === "string" && x.length > 0);

/** The payload back, or null for anything this app did not write. */
export function decodeMovePayload(raw: string | null | undefined): MovePayload | null {
  if (!raw) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return null; }
  if (!parsed || typeof parsed !== "object") return null;
  const o = parsed as Record<string, unknown>;
  if (o.v !== 1 || !isStringArray(o.files) || !isStringArray(o.folders)) return null;
  if (o.files.length + o.folders.length === 0) return null;
  return { fileIds: o.files, folderIds: o.folders, name: typeof o.name === "string" ? o.name : "" };
}
