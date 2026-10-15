import { useEffect, useState } from "react";
import { X } from "lucide-react";
import { Modal } from "./files/Modal";

/**
 * Help › Keyboard Shortcuts. A static reference: every row here is a key the
 * app actually binds (application menu accelerators and the pages' own
 * handlers), written with the platform's modifier glyphs.
 */
type Row = [label: string, keys: string];
type Section = { title: string; rows: Row[] };

/** `mod` is ⌘ on macOS and Ctrl elsewhere; the other glyphs are spelled per platform too. */
export function shortcutSections(platform: string): Section[] {
  const mac = platform === "darwin";
  const mod = mac ? "⌘" : "Ctrl+";
  const shift = mac ? "⇧" : "Shift+";
  const alt = mac ? "⌥" : "Alt+";
  const k = (...parts: string[]) => parts.join("");
  return [
    {
      title: "Go",
      rows: [
        ["Back / Forward", `${k(mod, "[")} / ${k(mod, "]")}`],
        ["Dashboard, Files, Upload, Shared, Vault, Sync", `${k(mod, "1")} to ${k(mod, "6")}`],
        ["Workspaces, Team, Settings", `${k(mod, "7")} to ${k(mod, "9")}`],
        ["Search dosya", k(mod, "K")],
      ],
    },
    {
      title: "Files",
      rows: [
        ["New folder", k(shift, mod, "N")],
        ["Upload files", k(mod, "U")],
        ["Select all", k(mod, "A")],
        ["Rename selected file", "F2"],
        ["Delete selected file", mac ? "⌫" : "Delete"],
        ["Show file details", k(mod, "I")],
      ],
    },
    {
      title: "View",
      rows: [
        ["Show or hide the sidebar", k(alt, mod, "S")],
        ["Zoom in / out / reset", `${k(mod, "+")} / ${k(mod, "−")} / ${k(mod, "0")}`],
        ["Full screen", mac ? "⌃⌘F" : "F11"],
      ],
    },
    {
      title: "Viewer",
      rows: [
        ["Find in document", k(mod, "F")],
        ["Previous / next file", "← / →"],
        ["Older / newer version", "↑ / ↓"],
        ["Close", "Esc"],
      ],
    },
    {
      title: "App",
      rows: [
        ["Settings", k(mod, ",")],
        ["Keyboard shortcuts", k(mod, "/")],
        ["Report a problem", k(shift, mod, "B")],
      ],
    },
  ];
}

export function ShortcutsDialog({ onClose }: { onClose: () => void }) {
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
      <div className="mb-4 flex items-center justify-between">
        <h3 className="text-lg font-semibold">Keyboard shortcuts</h3>
        <button onClick={onClose} aria-label="Close" className="rounded-md p-1 text-[var(--color-text-muted)] hover:bg-[var(--color-bg-tertiary)]">
          <X size={16} />
        </button>
      </div>
      <div className="max-h-[60vh] space-y-5 overflow-y-auto pr-1">
        {shortcutSections(platform).map((s) => (
          <section key={s.title}>
            <h4 className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">{s.title}</h4>
            <dl className="divide-y" style={{ borderColor: "var(--color-border)" }}>
              {s.rows.map(([label, keys]) => (
                <div key={label} className="flex items-center justify-between gap-4 py-1.5 text-sm">
                  <dt className="text-[var(--color-text)]">{label}</dt>
                  <dd className="font-mono text-xs text-[var(--color-text-secondary)]">{keys}</dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
      </div>
    </Modal>
  );
}
