import { useEffect, useRef, useState } from "react";
import { Check, Palette } from "lucide-react";
import { THEMES, type Mode } from "@/lib/themes";
import { useThemePref } from "@/lib/use-theme-pref";

const MODES: { value: Mode; label: string }[] = [
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
  { value: "system", label: "System" },
];

/**
 * Titlebar theme control: the same mode + theme options as Profile >
 * Appearance, one click from anywhere instead of a trip through Profile.
 * Same `align` contract as NotificationBell: the titlebar puts this in the
 * right cluster on macOS (panel grows leftward) and the left cluster on
 * Windows/Linux (panel must grow rightward, or most of it hangs off-screen).
 */
export function ThemeMenu({ align = "right" }: { align?: "left" | "right" } = {}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const { pref, save } = useThemePref();

  // Outside click and Escape, matching NotificationBell. Registered only
  // while open so it is not a permanent listener.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={wrapRef} className="titlebar-no-drag relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-xs font-medium text-[var(--color-text-secondary)] hover:bg-black/5 transition-colors"
        title="Theme"
        aria-label="Theme"
      >
        <Palette size={13} />
      </button>

      {open && (
        <div
          className={`anim-pop-in absolute top-full z-50 mt-1 w-60 rounded-lg border bg-[var(--color-bg)] p-3 shadow-lg ${
            align === "right" ? "right-0" : "left-0"
          }`}
          style={{
            borderColor: "var(--color-border)",
            transformOrigin: align === "right" ? "top right" : "top left",
          }}
        >
          {/* Mode */}
          <div
            className="mb-3 flex gap-1 rounded-lg p-1"
            style={{ background: "var(--color-bg-tertiary)" }}
          >
            {MODES.map((m) => (
              <button
                key={m.value}
                onClick={() => save({ ...pref, mode: m.value })}
                className={`flex-1 rounded-md px-2 py-1 text-xs font-medium transition-colors ${
                  pref.mode === m.value
                    ? ""
                    : "text-[var(--color-text-secondary)] hover:text-[var(--color-text)]"
                }`}
                style={
                  pref.mode === m.value
                    ? { background: "var(--color-bg)", boxShadow: "0 1px 2px rgba(0,0,0,0.08)" }
                    : undefined
                }
              >
                {m.label}
              </button>
            ))}
          </div>

          {/* Theme swatches */}
          <div className="grid grid-cols-4 gap-2">
            {THEMES.map((t) => {
              const active = pref.theme === t.id;
              return (
                <button
                  key={t.id}
                  onClick={() => save({ ...pref, theme: t.id })}
                  title={t.label}
                  aria-label={t.label}
                  className={`relative flex h-9 items-center justify-center rounded-md border transition-all ${
                    active ? "ring-2 ring-[var(--color-primary)]" : "hover:scale-105"
                  }`}
                  style={{ background: t.swatch.bg, borderColor: "var(--color-border)" }}
                >
                  <span
                    className="h-4 w-4 rounded-full"
                    style={{ background: t.swatch.primary }}
                  />
                  {active && (
                    <Check
                      size={10}
                      className="absolute right-0.5 top-0.5 text-[var(--color-primary)]"
                    />
                  )}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
