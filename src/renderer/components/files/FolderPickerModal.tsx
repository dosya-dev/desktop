// apps/desktop/src/renderer/components/files/FolderPickerModal.tsx
//
// The destination picker the file browser uses for Move and Copy, and the
// archive pane uses for Save. It used to live privately inside FileBrowserPage;
// it moved here unchanged when a second caller needed it.
import { useMemo, useRef } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { FolderIcon } from "@/components/files/FileIcon";

export type PickerFolder = { id: string; name: string; parent_id: string | null; file_count: number };

export function FolderPickerModal({
  title,
  actionLabel,
  folders,
  selectedId,
  excludeId,
  isPending,
  onSelect,
  onConfirm,
  onClose,
}: {
  title: string;
  actionLabel: string;
  folders: { id: string; name: string; parent_id: string | null; file_count: number }[];
  selectedId: string | null;
  excludeId?: string;
  isPending: boolean;
  onSelect: (id: string | null) => void;
  onConfirm: () => void;
  onClose: () => void;
}) {
  type Folder = { id: string; name: string; parent_id: string | null; file_count: number };

  // Flatten the (always-expanded) tree into a single ordered list ONCE, in
  // O(n) via a children map - the old code re-filtered the whole array at every
  // node (O(n²)) and rendered every folder unconditionally. Row 0 is the
  // synthetic "Root" option so the whole thing virtualizes uniformly.
  const rows = useMemo(() => {
    const childrenMap = new Map<string | null, Folder[]>();
    for (const f of folders) {
      if (f.id === excludeId) continue; // drop the excluded folder (and thus its subtree)
      const arr = childrenMap.get(f.parent_id);
      if (arr) arr.push(f);
      else childrenMap.set(f.parent_id, [f]);
    }
    const out: { folder: Folder | null; depth: number }[] = [{ folder: null, depth: 0 }];
    const walk = (parentId: string | null, depth: number) => {
      for (const f of childrenMap.get(parentId) ?? []) {
        out.push({ folder: f, depth });
        walk(f.id, depth + 1);
      }
    };
    walk(null, 0);
    return out;
  }, [folders, excludeId]);

  const scrollRef = useRef<HTMLDivElement>(null);
  const ROW_H = 36;
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_H,
    overscan: 12,
  });

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30">
      <div
        className="w-full max-w-sm rounded-xl bg-[var(--color-bg)] shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="border-b px-5 py-4" style={{ borderColor: "var(--color-border)" }}>
          <h3 className="text-lg font-semibold">{title}</h3>
          <p className="text-xs text-[var(--color-text-muted)]">Select destination folder</p>
        </div>

        <div ref={scrollRef} className="max-h-72 overflow-y-auto p-2">
          <div style={{ height: virtualizer.getTotalSize(), position: "relative", width: "100%" }}>
            {virtualizer.getVirtualItems().map((vi) => {
              const row = rows[vi.index];
              const isRoot = row.folder === null;
              const id = isRoot ? null : row.folder!.id;
              const selected = selectedId === id;
              return (
                <button
                  key={vi.key}
                  onClick={() => onSelect(id)}
                  className={`absolute left-0 flex w-full items-center gap-2.5 rounded-lg pr-3 text-sm transition-colors ${
                    selected
                      ? "bg-[var(--color-primary)]/10 font-medium text-[var(--color-primary)]"
                      : "hover:bg-[var(--color-bg-secondary)]"
                  }`}
                  style={{
                    top: 0,
                    height: ROW_H,
                    transform: `translateY(${vi.start}px)`,
                    paddingLeft: `${12 + (isRoot ? 0 : row.depth * 20)}px`,
                  }}
                >
                  <FolderIcon fileCount={isRoot ? 1 : row.folder!.file_count} size={16} />
                  <span className="truncate">{isRoot ? "Root (top level)" : row.folder!.name}</span>
                </button>
              );
            })}
          </div>

          {folders.length === 0 && (
            <p className="py-4 text-center text-sm text-[var(--color-text-muted)]">
              No folders yet
            </p>
          )}
        </div>

        <div className="flex justify-end gap-2 border-t px-5 py-4" style={{ borderColor: "var(--color-border)" }}>
          <button
            onClick={onClose}
            className="rounded-lg border px-4 py-2 text-sm"
            style={{ borderColor: "var(--color-border)" }}
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            disabled={isPending}
            className="rounded-lg px-4 py-2 text-sm font-medium text-[var(--color-primary-fg)] disabled:opacity-50"
            style={{ background: "var(--color-primary)" }}
          >
            {isPending ? "Working..." : actionLabel}
          </button>
        </div>
      </div>
      <div className="fixed inset-0 -z-10" onClick={onClose} />
    </div>
  );
}
