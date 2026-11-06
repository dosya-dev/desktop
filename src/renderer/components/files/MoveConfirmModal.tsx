import { useEffect, useRef } from "react";
import { Move } from "lucide-react";
import { Modal } from "@/components/files/Modal";
import { useT } from "@/lib/i18n";
import { richText } from "@/lib/rich-text";
import { Bdi } from "@/lib/bidi-ui";

/**
 * Asks before a drag-and-drop move runs. A drop is easy to make by accident
 * (a slipped mouse, a tile released one row too low), so nothing moves until
 * Move is pressed.
 *
 * Enter confirms and Escape cancels, registered on the window like LockModal's
 * shortcuts because focus may be anywhere once the drop lands. Enter on the
 * Cancel button is left to the button itself.
 */
export function MoveConfirmModal({
  names,
  fileCount,
  folderCount,
  folderName,
  pending = false,
  onConfirm,
  onCancel,
}: {
  /** Names of the items being moved, in order; the first one names a single-item move. */
  names: string[];
  /** Files the user moved (without Live Photo twins). */
  fileCount: number;
  /** Folders the user moved. */
  folderCount: number;
  /** The destination as the breadcrumb shows it. */
  folderName: string;
  pending?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const t = useT();
  const moveRef = useRef<HTMLButtonElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const latest = useRef({ onConfirm, onCancel, pending });
  useEffect(() => { latest.current = { onConfirm, onCancel, pending }; });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        latest.current.onCancel();
      } else if (e.key === "Enter") {
        if (e.target === cancelRef.current) return;
        e.preventDefault();
        if (!latest.current.pending) latest.current.onConfirm();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  useEffect(() => { moveRef.current?.focus(); }, []);

  // Design standard for confirmations: a fixed question as the title, and a
  // description that says exactly what is about to happen.
  const count = fileCount + folderCount;
  const single = count === 1;
  const bold = (text: string) => <strong className="font-semibold text-[var(--color-text)]">{text}</strong>;
  const description = single
    ? richText(t, "files.description.youAreMovingNameToFolder", {}, { name: bold(names[0] ?? ""), folder: bold(folderName) })
    : fileCount > 0 && folderCount > 0
      ? richText(t, "files.description.youAreMovingFilesAndFoldersToFolder", { files: fileCount, folders: folderCount }, { folder: bold(folderName) })
      : fileCount > 0
        ? richText(t, "files.description.youAreMovingFilesToFolder", { files: fileCount }, { folder: bold(folderName) })
        : richText(t, "files.description.youAreMovingFoldersToFolder", { folders: folderCount }, { folder: bold(folderName) });

  return (
    <Modal onClose={onCancel}>
      <div className="flex items-start gap-3" role="alertdialog" aria-modal="true" aria-labelledby="move-confirm-title" aria-describedby="move-confirm-description">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-[var(--color-primary)]/10">
          <Move size={20} className="text-[var(--color-primary)]" />
        </div>
        <div className="min-w-0">
          <h3 id="move-confirm-title" className="text-lg font-semibold text-[var(--color-text)]">{t("common.heading.areYouSure")}</h3>
          <p id="move-confirm-description" className="mt-1 text-sm text-[var(--color-text-secondary)]">{description}</p>
          {!single && names.length > 1 && names.length <= 5 && (
            <ul className="mt-2 space-y-0.5 text-xs text-[var(--color-text-muted)]">
              {names.map((n, i) => (
                <li key={i} className="truncate">· <Bdi>{n}</Bdi></li>
              ))}
            </ul>
          )}
        </div>
      </div>
      <div className="mt-5 flex justify-end gap-2">
        <button
          ref={cancelRef}
          type="button"
          onClick={onCancel}
          className="rounded-lg border px-4 py-2 text-sm text-[var(--color-text)] hover:bg-[var(--color-bg-secondary)] focus:border-[var(--color-primary)] focus:outline-none focus:ring-1 focus:ring-[var(--color-primary)]"
          style={{ borderColor: "var(--color-border)" }}
        >
          {t("common.cancel")}
        </button>
        <button
          ref={moveRef}
          type="button"
          onClick={onConfirm}
          disabled={pending}
          // Theme tokens only, like the Create folder / Rename dialogs: a fixed
          // white label is unreadable on themes with a light primary, and a
          // ring offset paints a white halo on dark backgrounds.
          className="rounded-lg bg-[var(--color-primary)] px-4 py-2 text-sm font-medium text-[var(--color-primary-fg)] hover:bg-[var(--color-primary-hover)] focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]/40 disabled:opacity-50"
        >
          {t("files.action.move")}
        </button>
      </div>
    </Modal>
  );
}
