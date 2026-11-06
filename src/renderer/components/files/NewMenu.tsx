import { useEffect, useRef, useState } from "react";
import { ChevronDown, FileCode, FileText, FileType, FolderPlus, Plus } from "lucide-react";
import { useDir, useT } from "@/lib/i18n";
import { useExitPresence } from "@/lib/use-exit-presence";
import type { NewFileKind } from "@/lib/blank-files";

/** What the Files "New" commands can make. */
export type NewChoice = "folder" | NewFileKind;

const ICONS: Record<NewChoice, typeof FolderPlus> = {
  folder: FolderPlus,
  markdown: FileCode,
  text: FileText,
  word: FileType,
};

export function NewChoiceIcon({ choice, size = 14 }: { choice: NewChoice; size?: number }) {
  const Icon = ICONS[choice];
  return <Icon size={size} aria-hidden className="shrink-0" />;
}

/**
 * The choices this member may use, in menu order. Folder follows the
 * create_folders permission, the files follow upload_files (a new file is an
 * upload of a blank body).
 */
export function useNewChoices(canFolder: boolean, canFiles: boolean): { choice: NewChoice; label: string }[] {
  const t = useT();
  const out: { choice: NewChoice; label: string }[] = [];
  if (canFolder) out.push({ choice: "folder", label: t("common.label.folder") });
  if (canFiles) {
    out.push({ choice: "markdown", label: t("files.option.markdownFile") });
    out.push({ choice: "text", label: t("files.option.textFile") });
    out.push({ choice: "word", label: t("files.option.wordDocument") });
  }
  return out;
}

/**
 * Toolbar "New" button and its dropdown. Escape and an outside click close
 * it (the ThemeMenu pattern); the arrow keys, Home and End move between the
 * items, and focus goes back to the button when it closes from the keyboard.
 */
export function NewMenuButton({
  choices,
  onPick,
}: {
  choices: { choice: NewChoice; label: string }[];
  onPick: (choice: NewChoice) => void;
}) {
  const t = useT();
  const dir = useDir();
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  // Matches the 120ms exit in .anim-popover[data-closing] (index.css).
  const { mounted, closing } = useExitPresence(open, 120);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      setOpen(false);
      buttonRef.current?.focus();
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const items = () => Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>("[role=menuitem]") ?? []);

  // Opened from the keyboard: land on the first item so the arrows work at once.
  const openFromKeyboard = () => {
    setOpen(true);
    requestAnimationFrame(() => items()[0]?.focus());
  };

  const onMenuKey = (e: React.KeyboardEvent) => {
    const list = items();
    if (list.length === 0) return;
    const at = list.indexOf(document.activeElement as HTMLButtonElement);
    let next = -1;
    if (e.key === "ArrowDown") next = at < 0 ? 0 : (at + 1) % list.length;
    else if (e.key === "ArrowUp") next = at < 0 ? list.length - 1 : (at - 1 + list.length) % list.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = list.length - 1;
    else if (e.key === "Tab") { setOpen(false); return; }
    if (next < 0) return;
    e.preventDefault();
    list[next].focus();
  };

  if (choices.length === 0) return null;

  return (
    <div ref={wrapRef} className="relative">
      <button
        ref={buttonRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" && !open) { e.preventDefault(); openFromKeyboard(); }
        }}
        aria-haspopup="menu"
        aria-expanded={open}
        className="flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-sm font-medium hover:bg-[var(--color-bg-secondary)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--color-primary)]"
        style={{ borderColor: "var(--color-border)" }}
      >
        <Plus size={14} />
        {t("files.action.new")}
        <ChevronDown size={12} className="text-[var(--color-text-muted)]" aria-hidden />
      </button>

      {mounted && (
        <div
          ref={menuRef}
          role="menu"
          aria-label={t("files.action.new")}
          data-closing={closing ? "" : undefined}
          onKeyDown={onMenuKey}
          className="anim-popover absolute inset-e-0 top-full z-50 mt-1 w-48 rounded-lg border bg-[var(--color-bg)] py-1 shadow-lg"
          // The panel hangs from the button's inline-end corner and grows from it.
          style={{ borderColor: "var(--color-border)", transformOrigin: dir === "rtl" ? "top left" : "top right" }} // rtl-ok: mirrored
        >
          {choices.map(({ choice, label }, i) => (
            <div key={choice}>
              {/* The folder sits apart from the three files, as in the context menu. */}
              {i > 0 && choice !== "folder" && choices[i - 1].choice === "folder" && (
                <div className="my-1 h-px bg-[var(--color-border)]" />
              )}
              <button
                type="button"
                role="menuitem"
                onClick={() => { setOpen(false); onPick(choice); }}
                className="flex w-full items-center gap-2 px-3 py-1.5 text-sm hover:bg-[var(--color-bg-secondary)] focus:bg-[var(--color-bg-secondary)] focus:outline-none"
              >
                <NewChoiceIcon choice={choice} />
                {label}
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
