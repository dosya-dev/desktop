// apps/desktop/src/renderer/components/personas/NameField.tsx
//
// Ported from apps/web/src/components/personas/name-field.tsx - keep in step.
//
// Inline name editor for a persona: Enter (or Save) saves through the
// engine's rename (journaled, so the user's other devices get the name),
// Escape cancels. A taken or invalid name keeps the field open with the
// reason under it.
import { useState } from "react";
import { Check, X } from "lucide-react";
import type { PersonasEngine } from "@dosya-dev/personas-engine";
import { useAutoDir } from "@/lib/bidi-ui";
import { useT } from "@/lib/i18n";
import { personasErrorCode } from "@/lib/personas";

/** Longest name the engine accepts. */
const NAME_MAX = 60;

const ICON_BUTTON = "inline-flex size-7 shrink-0 items-center justify-center rounded-md text-[var(--color-text-muted)] hover:bg-[var(--color-bg-secondary)] hover:text-[var(--color-text)] disabled:opacity-50";

export function PersonaNameField({ engine, personaId, initial, onSaved, onCancel, className = "" }: {
  engine: Pick<PersonasEngine, "rename">;
  personaId: string;
  initial: string;
  onSaved: () => void;
  onCancel: () => void;
  className?: string;
}) {
  const t = useT();
  const ownDir = useAutoDir();
  const [value, setValue] = useState(initial);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    const name = value.trim();
    if (!name) { setError(t("personas.error.typeAName")); return; }
    if (name === initial.trim()) { onCancel(); return; }
    setSaving(true);
    setError(null);
    try {
      await engine.rename(personaId, name);
      onSaved();
    } catch (err) {
      const code = personasErrorCode(err);
      setError(
        code === "name_taken" ? t("personas.error.nameTaken")
          : code === "name_invalid" ? t("personas.error.nameInvalid")
          : t("personas.error.couldNotSaveName"),
      );
      setSaving(false);
    }
  };

  return (
    <div className={`min-w-0 ${className}`}>
      <div className="flex items-center gap-1">
        <input
          autoFocus
          type="text"
          aria-label={t("personas.label.name")}
          aria-invalid={error ? true : undefined}
          value={value}
          maxLength={NAME_MAX}
          disabled={saving}
          placeholder={t("personas.label.name")}
          onChange={(e) => { setValue(e.target.value); setError(null); }}
          onKeyDown={(e) => {
            if (e.key === "Enter") { e.preventDefault(); void save(); }
            else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); onCancel(); }
          }}
          className="h-7 min-w-0 flex-1 rounded-md border bg-[var(--color-bg)] px-2 text-sm outline-none focus:border-[var(--color-primary)] focus:ring-1 focus:ring-[var(--color-primary)] disabled:opacity-50"
          style={{ borderColor: error ? "var(--color-danger)" : "var(--color-border)" }}
          dir={ownDir}
        />
        <button type="button" onClick={() => void save()} disabled={saving} aria-label={t("common.save")} title={t("common.save")} className={ICON_BUTTON}>
          <Check size={14} aria-hidden="true" />
        </button>
        <button type="button" onClick={onCancel} disabled={saving} aria-label={t("common.cancel")} title={t("common.cancel")} className={ICON_BUTTON}>
          <X size={14} aria-hidden="true" />
        </button>
      </div>
      {error && <p role="alert" className="mt-1 text-xs text-[var(--color-danger)]">{error}</p>}
    </div>
  );
}
