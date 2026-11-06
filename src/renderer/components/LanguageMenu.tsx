import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown } from "lucide-react";
import { LOCALES, LOCALE_LABELS, localeDir, type Locale } from "../../i18n/locales";
import { useDir, useLocale, useT } from "@/lib/i18n";

/**
 * Titlebar language menu: the button shows the active language's code, the
 * panel lists every shipped language by its own name in its own script, with
 * no flags. Same `align` contract
 * and dismissal as ThemeMenu. `variant="field"` is the Profile > Appearance
 * picker: a full-size button with the language named, opening the same list.
 */
export function LanguageMenu({
  align = "end",
  variant = "titlebar",
}: { align?: "start" | "end"; variant?: "titlebar" | "field" } = {}) {
  const field = variant === "field";
  const [open, setOpen] = useState(false);
  const t = useT();
  const dir = useDir();
  const { locale, setLocale } = useLocale();
  const wrapRef = useRef<HTMLDivElement | null>(null);

  // Outside click and Escape, matching ThemeMenu. Registered only while open.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // The list scrolls; open it with the current language in view.
  useEffect(() => {
    if (!open) return;
    wrapRef.current?.querySelector<HTMLElement>("[role=menuitemradio][aria-checked=true]")?.scrollIntoView?.({ block: "nearest" });
  }, [open]);

  const pick = (id: Locale) => {
    setLocale(id).catch((err) => console.error("[i18n] could not change language:", err));
    setOpen(false);
  };

  return (
    // Language names always read in their own language.
    <div ref={wrapRef} className={field ? "relative inline-block max-w-full" : "titlebar-no-drag relative"}>
      <button
        onClick={() => setOpen((v) => !v)}
        className={
          field
            ? "flex min-w-56 max-w-full items-center gap-2.5 text-start rounded-lg border px-3 py-2 text-sm font-medium hover:bg-[var(--color-bg-tertiary)] transition-colors"
            : "flex items-center gap-1.5 rounded-lg px-2 py-1 text-xs font-medium text-[var(--color-text-secondary)] hover:bg-black/5 transition-colors"
        }
        style={field ? { borderColor: "var(--color-border)" } : undefined}
        title={t("appearance.accessibility.languageName", { name: LOCALE_LABELS[locale] })}
        aria-label={t("appearance.accessibility.languageName", { name: LOCALE_LABELS[locale] })}
        aria-haspopup="menu"
        data-testid={field ? "language-field-button" : "language-menu-button"}
        aria-expanded={open}
      >
        {field ? (
          <>
            {/* Sized to the name so an rtl name still sits at the inline start; truncates in a narrow container. */}
            <span className="lang-name min-w-0 truncate" lang={locale} dir={localeDir(locale)}>{LOCALE_LABELS[locale]}</span>
            <ChevronDown size={14} className="ms-auto shrink-0 text-[var(--color-text-secondary)]" />
          </>
        ) : (
          <span className="uppercase">{locale}</span>
        )}
      </button>

      {open && (
        <div
          role="menu"
          className={`anim-pop-in absolute top-full z-50 mt-1 max-h-[min(70vh,30rem)] overflow-y-auto rounded-lg border bg-[var(--color-bg)] p-1 shadow-lg ${
            align === "end" ? "inset-e-0" : "inset-s-0"
          } ${field ? "w-full" : "w-52"}`}
          style={{
            borderColor: "var(--color-border)",
            transformOrigin: (align === "start") === (dir === "ltr") ? "top left" : "top right",
          }}
        >
          <p className="px-2 pb-1 pt-1.5 text-xs text-[var(--color-text-secondary)]">{t("appearance.label.language")}</p>
          {LOCALES.map((id) => {
            const active = id === locale;
            return (
              <button
                key={id}
                role="menuitemradio"
                aria-checked={active}
                onClick={() => pick(id)}
                className={`flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-start text-sm transition-colors hover:bg-[var(--color-bg-tertiary)] ${
                  active ? "font-medium" : ""
                }`}
              >
                {/* The name in its own language and script. Sized to its text, so an rtl
                    name lines up at the inline start with the others. */}
                <span className="lang-name min-w-0 truncate" lang={id} dir={localeDir(id)}>{LOCALE_LABELS[id]}</span>
                {active && <Check size={14} className="ms-auto shrink-0 text-[var(--color-primary)]" />}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
