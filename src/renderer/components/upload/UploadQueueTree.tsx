import { useMemo, useState } from "react";
import { Check, ChevronRight, Loader2, AlertCircle, RefreshCw, X } from "lucide-react";
import { FileIcon, FolderIcon } from "@/components/files/FileIcon";
import { formatBytes } from "@/lib/format";
import {
  buildUploadTree, visibleRows, type UploadFolderNode, type UploadLeaf,
} from "@/lib/upload-tree";

export interface UploadQueueItem {
  file: File;
  id: string;
  status: "pending" | "uploading" | "done" | "error";
  progress: number; // 0-100 byte-level
  bytesUploaded: number;
  error?: string;
  // Destination captured at enqueue time. Uploads must never retarget when
  // the active workspace/folder changes mid-queue. The location is not part of
  // this: files land wherever the workspace was created, which no upload can
  // override.
  workspaceId: string;
  folderId: string | null;
  /** Folder path inside a folder upload ("Photos/2024"); "" for a loose file. */
  relativePath: string;
}

/**
 * Past this many rows only the top-level folders start open: a 2,000-file drop
 * expanded in full is the flat list this view exists to replace.
 */
const OPEN_ALL_LIMIT = 50;

const STATE: Record<UploadQueueItem["status"], UploadLeaf["state"]> = {
  pending: "pending", uploading: "active", done: "done", error: "error",
};

const toLeaf = (item: UploadQueueItem): UploadLeaf => ({
  path: item.relativePath,
  size: item.file.size,
  bytesDone: item.bytesUploaded,
  state: STATE[item.status],
});

const INDENT = 18;

export function UploadQueueTree({
  queue,
  onRetry,
  onRemove,
}: {
  queue: UploadQueueItem[];
  onRetry: (ids: string[]) => void;
  onRemove: (ids: string[]) => void;
}) {
  const tree = useMemo(() => buildUploadTree(queue, toLeaf), [queue]);
  // Only what the user toggled is stored; everything else follows the default,
  // so folders arriving later in a long upload pick up the right state.
  const [toggled, setToggled] = useState<Map<string, boolean>>(new Map());
  const openAll = useMemo(() => visibleRows(tree, () => true).length <= OPEN_ALL_LIMIT, [tree]);
  const isOpen = (f: UploadFolderNode<UploadQueueItem>) =>
    toggled.get(f.path) ?? (openAll || !f.path.includes("/"));
  const toggle = (f: UploadFolderNode<UploadQueueItem>) =>
    setToggled((prev) => new Map(prev).set(f.path, !isOpen(f)));

  const rows = visibleRows(tree, isOpen);

  return (
    <div className="space-y-0.5 max-h-80 overflow-auto" role="tree" aria-label="Upload queue">
      {rows.map(({ node, depth }) =>
        node.kind === "folder" ? (
          <FolderRow
            key={`d:${node.path}`}
            folder={node}
            depth={depth}
            open={isOpen(node)}
            onToggle={() => toggle(node)}
            onRetry={() => onRetry(node.items.filter((i) => i.status === "error").map((i) => i.id))}
            onRemove={() => onRemove(node.items.filter((i) => i.status !== "done").map((i) => i.id))}
          />
        ) : (
          <FileRow
            key={node.item.id}
            item={node.item}
            depth={depth}
            onRetry={() => onRetry([node.item.id])}
            onRemove={() => onRemove([node.item.id])}
          />
        ),
      )}
    </div>
  );
}

function FolderRow({
  folder, depth, open, onToggle, onRetry, onRemove,
}: {
  folder: UploadFolderNode<UploadQueueItem>;
  depth: number;
  open: boolean;
  onToggle: () => void;
  onRetry: () => void;
  onRemove: () => void;
}) {
  const pct = folder.totalBytes > 0 ? Math.round((folder.doneBytes / folder.totalBytes) * 100) : 0;
  const finished = folder.doneCount === folder.fileCount;
  const unfinished = folder.fileCount - folder.doneCount;
  return (
    <div
      role="treeitem"
      aria-expanded={open}
      aria-label={folder.name}
      className="group flex items-center gap-2 rounded-lg px-3 py-2 text-sm hover:bg-[var(--color-bg-secondary)] cursor-pointer select-none"
      style={{ paddingLeft: `${12 + depth * INDENT}px` }}
      onClick={onToggle}
    >
      <ChevronRight
        size={14}
        className={`shrink-0 text-[var(--color-text-muted)] transition-transform duration-150 ${open ? "rotate-90" : ""}`}
      />
      <FolderIcon fileCount={folder.fileCount} size={16} />
      <div className="flex-1 min-w-0">
        <div className="flex items-center justify-between gap-2">
          <span className="truncate font-medium">{folder.name}</span>
          <span className="text-xs text-[var(--color-text-muted)] shrink-0">
            {folder.doneCount}/{folder.fileCount} files · {formatBytes(folder.totalBytes)}
            {folder.errorCount > 0 && (
              <span className="text-[var(--color-danger)]"> · {folder.errorCount} failed</span>
            )}
          </span>
        </div>
        {!finished && (
          <div className="mt-1 h-1 w-full rounded-full bg-[var(--color-border)]">
            <div
              className="h-1 rounded-full transition-all duration-300"
              style={{
                width: `${Math.max(pct, 1)}%`,
                background: folder.errorCount > 0 && folder.activeCount === 0 ? "var(--color-danger)" : "var(--color-primary)",
              }}
            />
          </div>
        )}
      </div>
      {finished ? (
        <Check size={16} className="text-[var(--color-primary)] shrink-0" />
      ) : (
        <div className="shrink-0 flex gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
          {folder.errorCount > 0 && (
            <button
              onClick={(e) => { e.stopPropagation(); onRetry(); }}
              className="rounded p-1 text-[var(--color-text-muted)] hover:text-[var(--color-primary)]"
              title="Retry failed in this folder"
            >
              <RefreshCw size={13} />
            </button>
          )}
          {unfinished > 0 && (
            <button
              onClick={(e) => { e.stopPropagation(); onRemove(); }}
              className="rounded p-1 text-[var(--color-text-muted)] hover:text-[var(--color-danger)]"
              title="Remove this folder's unfinished uploads"
            >
              <X size={13} />
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function FileRow({
  item, depth, onRetry, onRemove,
}: {
  item: UploadQueueItem;
  depth: number;
  onRetry: () => void;
  onRemove: () => void;
}) {
  return (
    <div
      role="treeitem"
      className="group flex items-center gap-3 rounded-lg px-3 py-2 text-sm hover:bg-[var(--color-bg-secondary)]"
      // A file sits under its folder's name, past where the chevron would be.
      style={{ paddingLeft: `${12 + depth * INDENT + (depth > 0 ? 22 : 0)}px` }}
    >
      {/* Status icon */}
      {item.status === "done" ? (
        <Check size={16} className="text-[var(--color-primary)] shrink-0" />
      ) : item.status === "uploading" ? (
        <Loader2 size={16} className="animate-spin text-[var(--color-primary)] shrink-0" />
      ) : item.status === "error" ? (
        <AlertCircle size={16} className="text-[var(--color-danger)] shrink-0" />
      ) : (
        <FileIcon name={item.file.name} size={16} className="shrink-0" />
      )}

      {/* File info + progress */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center justify-between">
          <span className="truncate text-sm">{item.file.name}</span>
          <span className="text-xs text-[var(--color-text-muted)] ml-2 shrink-0">
            {item.status === "uploading"
              ? `${formatBytes(item.bytesUploaded)} / ${formatBytes(item.file.size)}`
              : formatBytes(item.file.size)}
          </span>
        </div>
        {/* Per-file progress bar */}
        {item.status === "uploading" && (
          <div className="mt-1 h-1 w-full rounded-full bg-[var(--color-border)]">
            <div
              className="h-1 rounded-full transition-all duration-200"
              style={{ width: `${Math.max(item.progress, 1)}%`, background: "var(--color-primary)" }}
            />
          </div>
        )}
        {item.status === "error" && item.error && (
          <p className="mt-0.5 text-[11px] text-[var(--color-danger)] truncate">{item.error}</p>
        )}
      </div>

      {/* Actions */}
      <div className="shrink-0 flex gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
        {item.status === "error" && (
          <button onClick={onRetry} className="rounded p-1 text-[var(--color-text-muted)] hover:text-[var(--color-primary)]" title="Retry">
            <RefreshCw size={13} />
          </button>
        )}
        {(item.status === "pending" || item.status === "uploading" || item.status === "error") && (
          <button onClick={onRemove} className="rounded p-1 text-[var(--color-text-muted)] hover:text-[var(--color-danger)]" title="Remove">
            <X size={13} />
          </button>
        )}
      </div>
    </div>
  );
}
