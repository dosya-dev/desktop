import { useEffect, useRef, useState } from "react";
import { Check, Palette } from "lucide-react";
import { THEMES, type Mode } from "@/lib/themes";
import { useThemePref } from "@/lib/use-theme-pref";
import { useDir, useT } from "@/lib/i18n";
import { useExitPresence } from "@/lib/use-exit-presence";
import type { MessageKey } from "../../i18n/keys";

const MODES: { value: Mode; label: MessageKey }[] = [
  { value: "light", label: "common.option.light" },
  { value: "dark", label: "common.option.dark" },
  { value: "system", label: "common.option.system" },
];

/**
 * During the theme wipe (withThemeSweep in lib/theme.ts) the view-transition
 * overlay can swallow hit-testing, so a click on the next swatch arrives with
 * <html> as its target. That is not a click outside the menu: picking themes
 * quickly used to close the panel after a few changes.
 */
export function isSweepClick(e: Pick<MouseEvent, "target">): boolean {
  const root = document.documentElement;
  return e.target === root && root.hasAttribute("data-theme-sweep");
}

/**
 * Titlebar theme control: the same mode + theme options as Profile >
 * Appearance, one click from anywhere instead of a trip through Profile.
 * Same `align` contract as NotificationBell: the titlebar puts this in the
 * end cluster on macOS (panel grows toward the start) and the start cluster on
 * Windows/Linux (panel must grow toward the end, or most of it hangs off-screen).
 */
export function ThemeMenu({ align = "end" }: { align?: "start" | "end" } = {}) {
  const t = useT();
  const dir = useDir();
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const { pref, save } = useThemePref();
  // Matches the 120ms exit in .anim-popover[data-closing] (index.css).
  const { mounted, closing } = useExitPresence(open, 120);

  // Outside click and Escape, matching NotificationBell. Registered only
  // while open so it is not a permanent listener.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (isSweepClick(e)) return;
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
        title={t("profile.label.theme")}
        aria-label={t("profile.label.theme")}
      >
        <Palette size={13} />
      </button>

      {mounted && (
        <div
          data-closing={closing ? "" : undefined}
          className={`anim-popover absolute top-full z-50 mt-1 w-60 rounded-lg border bg-[var(--color-bg)] p-3 shadow-lg ${
            align === "end" ? "inset-e-0" : "inset-s-0"
          }`}
          style={{
            borderColor: "var(--color-border)",
            transformOrigin: (align === "start") === (dir === "ltr") ? "top left" : "top right",
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
                {t(m.label)}
              </button>
            ))}
          </div>

          {/* Theme swatches */}
          <div className="grid grid-cols-4 gap-2">
            {THEMES.map((theme) => {
              const active = pref.theme === theme.id;
              return (
                <button
                  key={theme.id}
                  onClick={() => save({ ...pref, theme: theme.id })}
                  title={t(theme.labelKey)}
                  aria-label={t(theme.labelKey)}
                  className={`relative flex h-9 items-center justify-center rounded-md border transition-all ${
                    active ? "ring-2 ring-[var(--color-primary)]" : "hover:scale-105"
                  }`}
                  style={{ background: theme.swatch.bg, borderColor: "var(--color-border)" }}
                >
                  <span
                    className="h-4 w-4 rounded-full"
                    style={{ background: theme.swatch.primary }}
                  />
                  {active && (
                    <Check
                      size={10}
                      className="absolute inset-e-0.5 top-0.5 text-[var(--color-primary)]"
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
