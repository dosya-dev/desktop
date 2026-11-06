// apps/desktop/src/renderer/components/personas/MergeDialog.tsx
//
// Ported from apps/web/src/components/personas/merge-dialog.tsx (design-ref
// Merge) - keep the behaviour and copy in step.
//
// "Merge with <name>": pick another persona that is the same person. The
// engine keeps the named side's name and cover when exactly one side is
// named (R25), so the copy says the target keeps them only when the target
// has a name. Neutral wording, no pronouns (R55). The list and the merge are
// this device's engine (journaled for the user's other devices).
import { useEffect, useMemo, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import type { PersonasEngine } from "@dosya-dev/personas-engine";
import { Modal } from "@/components/files/Modal";
import { useAutoDir } from "@/lib/bidi-ui";
import { useT } from "@/lib/i18n";
import type { PersonaCard } from "@/lib/personas";
import { FaceAvatar } from "./FaceAvatar";
import { BORDER, OUTLINE_BUTTON, PRIMARY_BUTTON } from "./ui";

export function MergeDialog({ open, engine, target, onClose, onMerged }: {
  open: boolean;
  engine: Pick<PersonasEngine, "listPersonas" | "merge">;
  target: PersonaCard;
  onClose: () => void;
  /** Called with the surviving persona id. */
  onMerged: (survivorId: string) => void;
}) {
  const t = useT();
  const ownDir = useAutoDir();
  const [picked, setPicked] = useState<string | null>(null);
  const [merging, setMerging] = useState(false);
  const [failed, setFailed] = useState(false);
  // Each opening starts with nothing picked and no error.
  const [wasOpen, setWasOpen] = useState(open);
  if (wasOpen !== open) {
    setWasOpen(open);
    if (open) { setPicked(null); setFailed(false); }
  }
  const options = useMemo(
    () => (open ? engine.listPersonas().filter((p) => p.id !== target.id) : []),
    [open, engine, target.id],
  );

  // Escape closes, as the page-level dialogs do; not while a merge is running.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape" && !merging) { e.stopPropagation(); onClose(); } };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, merging, onClose]);

  // Focus: the first option when the dialog opens (Cancel when there is
  // nobody to pick), and back to the button that opened the dialog when it
  // closes.
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  const listRef = useRef<HTMLFieldSetElement | null>(null);
  useEffect(() => {
    if (!open) return;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const first = listRef.current?.querySelector<HTMLInputElement>('input[type="radio"]');
    (first ?? cancelRef.current)?.focus();
    return () => { if (opener?.isConnected) opener.focus(); };
  }, [open]);

  if (!open) return null;

  const merge = async () => {
    if (!picked) return;
    setMerging(true);
    setFailed(false);
    try {
      const survivor = await engine.merge(target.id, picked);
      onMerged(survivor || target.id);
    } catch {
      setFailed(true);
    } finally {
      setMerging(false);
    }
  };

  const name = target.name;
  return (
    <Modal onClose={() => { if (!merging) onClose(); }} maxWidth={448}>
      <div role="dialog" aria-modal="true" aria-labelledby="merge-persona-title" className="flex flex-col gap-4">
        <div>
          <h2 id="merge-persona-title" className="text-lg font-semibold" dir={ownDir}>
            {name ? t("personas.heading.mergeWithName", { name }) : t("personas.heading.mergeWithThisPersona")}
          </h2>
          <p className="mt-1 text-sm leading-normal text-[var(--color-text-secondary)]" dir={ownDir}>
            {name ? t("personas.description.pickThePersonaThatIsAlsoName", { name }) : t("personas.description.pickThePersonaThatIsAlsoThisPerson")}
          </p>
        </div>

        {options.length === 0 && (
          <p className="text-sm text-[var(--color-text-secondary)]">{t("personas.description.noOtherPersonasToMerge")}</p>
        )}
        {options.length > 0 && (
          <fieldset ref={listRef} className="min-w-0">
            <legend className="sr-only">{t("personas.label.personaToMerge")}</legend>
            <div className="flex max-h-72 flex-col gap-1.5 overflow-y-auto">
              {options.map((p) => {
                const on = picked === p.id;
                return (
                  <label
                    key={p.id}
                    className={`flex cursor-pointer items-center gap-3 rounded-lg border px-3 py-2 transition-colors ${on ? "border-[var(--color-primary)] bg-[var(--color-bg-secondary)]" : "hover:bg-[var(--color-bg-secondary)]"}`}
                    style={on ? undefined : BORDER}
                  >
                    <input
                      type="radio"
                      name="merge-persona"
                      value={p.id}
                      checked={on}
                      onChange={() => setPicked(p.id)}
                      disabled={merging}
                      className="accent-[var(--color-primary)]"
                    />
                    <FaceAvatar fileId={p.cover_file_id} box={p.cover_box} name={p.name} className="size-9" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium" dir={p.name ? ownDir : undefined}>{p.name ?? t("personas.label.unnamed")}</span>
                      <span className="block text-xs text-[var(--color-text-muted)]">{t("personas.label.photoCount", { count: p.photo_count })}</span>
                    </span>
                  </label>
                );
              })}
            </div>
          </fieldset>
        )}
        {failed && <p role="alert" className="text-sm text-[var(--color-danger)]">{t("personas.error.couldNotMerge")}</p>}

        <div className="flex justify-end gap-2">
          <button ref={cancelRef} type="button" className={OUTLINE_BUTTON} style={BORDER} onClick={onClose} disabled={merging}>{t("common.cancel")}</button>
          <button
            type="button"
            className={PRIMARY_BUTTON}
            style={{ background: "var(--color-primary)" }}
            onClick={() => void merge()}
            disabled={!picked || merging}
          >
            {merging && <Loader2 size={14} className="animate-spin" aria-hidden="true" />}
            {name ? t("personas.action.mergeIntoName", { name }) : t("personas.action.merge")}
          </button>
        </div>
      </div>
    </Modal>
  );
}
