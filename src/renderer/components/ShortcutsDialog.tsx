import { useEffect, useState } from "react";
import { X } from "lucide-react";
import { Modal } from "./files/Modal";
import { currentDir, t as currentT, useDir, useT } from "@/lib/i18n";
import type { T } from "../../i18n/translator";

/**
 * Help › Keyboard Shortcuts. A static reference: every row here is a key the
 * app actually binds (application menu accelerators and the pages' own
 * handlers), written with the platform's modifier glyphs.
 */
type Row = [label: string, keys: string];
type Section = { title: string; rows: Row[] };

/**
 * `mod` is ⌘ on macOS and Ctrl elsewhere; the other glyphs are spelled per
 * platform too. Labels come from `t` (the current language by default); the
 * key names stay as printed on the keyboard. `dir` orders the arrow pair:
 * in a right-to-left language the previous file is the right arrow, and the
 * pair reads from the right, so the glyphs swap (the label stays as written).
 */
export function shortcutSections(platform: string, t: T = currentT, dir: "ltr" | "rtl" = currentDir()): Section[] {
  const mac = platform === "darwin";
  const mod = mac ? "⌘" : "Ctrl+";
  const shift = mac ? "⇧" : "Shift+";
  const alt = mac ? "⌥" : "Alt+";
  const k = (...parts: string[]) => parts.join("");
  return [
    {
      title: t("shortcuts.heading.go"),
      rows: [
        [t("shortcuts.label.backForward"), `${k(mod, "[")} / ${k(mod, "]")}`],
        [t("shortcuts.label.dashboardFilesUploadSharedVaultSync"), t("shortcuts.label.fromToTo", { from: k(mod, "1"), to: k(mod, "6") })],
        [t("shortcuts.label.workspacesTeamSettings"), t("shortcuts.label.fromToTo", { from: k(mod, "7"), to: k(mod, "9") })],
        [t("shortcuts.label.searchDosya"), k(mod, "K")],
      ],
    },
    {
      title: t("common.label.files"),
      rows: [
        [t("common.action.newFolder"), k(shift, mod, "N")],
        [t("common.action.uploadFiles"), k(mod, "U")],
        [t("common.action.selectAll"), k(mod, "A")],
        [t("shortcuts.label.renameSelectedFile"), "F2"],
        [t("shortcuts.label.deleteSelectedFile"), mac ? "⌫" : "Delete"],
        [t("shortcuts.label.showFileDetails"), k(mod, "I")],
      ],
    },
    {
      title: t("shortcuts.heading.view"),
      rows: [
        [t("shortcuts.label.showOrHideTheSidebar"), k(alt, mod, "S")],
        [t("shortcuts.label.zoomInOutReset"), `${k(mod, "+")} / ${k(mod, "−")} / ${k(mod, "0")}`],
        [t("shortcuts.label.fullScreen"), mac ? "⌃⌘F" : "F11"],
      ],
    },
    {
      title: t("shortcuts.heading.viewer"),
      rows: [
        [t("shortcuts.label.findInDocument"), k(mod, "F")],
        [t("shortcuts.label.previousNextFile"), dir === "rtl" ? "→ / ←" : "← / →"],
        [t("shortcuts.label.olderNewerVersion"), "↑ / ↓"],
        [t("common.close"), "Esc"],
      ],
    },
    {
      title: t("report-problem.label.app"),
      rows: [
        [t("common.label.settings"), k(mod, ",")],
        [t("shortcuts.heading.keyboardShortcuts"), k(mod, "/")],
        [t("shortcuts.label.reportAProblem"), k(shift, mod, "B")],
      ],
    },
  ];
}

export function ShortcutsDialog({ onClose }: { onClose: () => void }) {
  const t = useT();
  const dir = useDir();
  const [platform, setPlatform] = useState<string>("darwin");
  useEffect(() => {
    let live = true;
    window.electronAPI?.getPlatform?.().then((p) => { if (live) setPlatform(p); }).catch(() => {});
    return () => { live = false; };
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <Modal onClose={onClose} maxWidth={520}>
      <div data-testid="shortcuts-dialog">
        <div className="mb-4 flex items-center justify-between">
          <h3 className="text-lg font-semibold">{t("shortcuts.heading.keyboardShortcuts")}</h3>
          <button onClick={onClose} aria-label={t("common.close")} className="rounded-md p-1 text-[var(--color-text-muted)] hover:bg-[var(--color-bg-tertiary)]">
            <X size={16} />
          </button>
        </div>
        <div className="max-h-[60vh] space-y-5 overflow-y-auto pe-1">
          {shortcutSections(platform, t, dir).map((s) => (
            <section key={s.title}>
              <h4 className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">{s.title}</h4>
              <dl className="divide-y" style={{ borderColor: "var(--color-border)" }}>
                {s.rows.map(([label, keys]) => (
                  <div key={label} className="flex items-center justify-between gap-4 py-1.5 text-sm">
                    <dt className="text-[var(--color-text)]">{label}</dt>
                    <dd translate="no" className="font-mono text-xs text-[var(--color-text-secondary)]">{keys}</dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
        </div>
      </div>
    </Modal>
  );
}
