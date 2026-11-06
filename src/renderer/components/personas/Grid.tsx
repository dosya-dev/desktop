// apps/desktop/src/renderer/components/personas/Grid.tsx
//
// Ported from apps/web/src/pages/personas/grid.tsx (design-ref Main) - keep
// the behaviour and copy in step.
//
// The Personas grid: named personas first, then the groups nobody has named
// yet, each with "Add a name" (inline rename). The engine decides what is
// shown (at least 3 faces for an unnamed group, 1 for a named one). While
// photos are still being read (`reading`), a dashed "More coming" tile closes
// the not-named section. A saved name reaches the list through the engine's
// change notice.
//
// "Personas settings" is the page header's (pages/PersonasPage), so it is
// there with the empty state too.
import { useState } from "react";
import { Link } from "react-router-dom";
import { Loader2, Plus } from "lucide-react";
import type { PersonasEngine } from "@dosya-dev/personas-engine";
import { useAutoDir } from "@/lib/bidi-ui";
import { useT } from "@/lib/i18n";
import { intlLocale } from "@/lib/locale-state";
import { personaHref, type PersonaCard } from "@/lib/personas";
import { FaceAvatar } from "./FaceAvatar";
import { PersonaNameField } from "./NameField";
import { BORDER } from "./ui";

const COUNT = "text-xs font-medium text-[var(--color-text-muted)]";
const TILES = "grid grid-cols-[repeat(auto-fill,minmax(8.5rem,1fr))]";

export function PersonasGrid({ engine, personas, reading = false, onChanged }: {
  engine: Pick<PersonasEngine, "rename">;
  personas: PersonaCard[];
  /** Photos are still being read: a "More coming" tile ends the not-named section. */
  reading?: boolean;
  /** A name was saved. */
  onChanged?: () => void;
}) {
  const t = useT();
  const ownDir = useAutoDir();
  const named = personas.filter((p) => p.name);
  const unnamed = personas.filter((p) => !p.name);
  const digits = (n: number) => n.toLocaleString(intlLocale("en"));

  return (
    <div className="flex flex-col gap-8">
      {named.length > 0 && (
        <section aria-labelledby="personas-named">
          <h2 id="personas-named" className="mb-3 flex items-center gap-2 text-sm font-semibold">
            {t("personas.heading.named")}
            <span className={COUNT}>{digits(named.length)}</span>
          </h2>
          <ul className={`${TILES} gap-4`}>
            {named.map((p) => (
              <li key={p.id}>
                <Link
                  to={personaHref(p.id)}
                  className="group flex flex-col items-center gap-2 rounded-xl p-2 text-center hover:bg-[var(--color-bg-secondary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)]"
                >
                  <FaceAvatar fileId={p.cover_file_id} box={p.cover_box} name={p.name} className="size-24" />
                  <span className="w-full truncate text-sm font-medium" dir={ownDir}>{p.name}</span>
                  <span className="-mt-1.5 text-xs text-[var(--color-text-muted)]">{t("personas.label.photoCount", { count: p.photo_count })}</span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}

      {(unnamed.length > 0 || reading) && (
        <section aria-labelledby="personas-unnamed">
          <div className="mb-3 flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <h2 id="personas-unnamed" className="flex items-center gap-2 text-sm font-semibold">
              {t("personas.heading.notNamedYet")}
              {unnamed.length > 0 && <span className={COUNT}>{digits(unnamed.length)}</span>}
            </h2>
            <span className="text-xs text-[var(--color-text-muted)]">{t("personas.description.addANameToFindThemInSearch")}</span>
          </div>
          <ul className={`${TILES} gap-3`}>
            {unnamed.map((p) => <UnnamedCard key={p.id} engine={engine} persona={p} onChanged={onChanged} />)}
            {reading && (
              <li data-testid="personas-more-coming" className="flex min-h-36 flex-col items-center justify-center gap-2 rounded-xl border border-dashed p-3 text-center text-[var(--color-text-muted)]" style={BORDER}>
                <span className="flex size-18 items-center justify-center rounded-full border border-dashed" style={BORDER} aria-hidden="true">
                  <Loader2 size={20} className="animate-spin" />
                </span>
                <span className="text-xs">{t("personas.label.moreComing")}</span>
              </li>
            )}
          </ul>
          <p className="mt-4 text-xs text-[var(--color-text-muted)]">{t("personas.description.aFaceNeedsToAppearInAtLeastThreePhotos")}</p>
        </section>
      )}
    </div>
  );
}

function UnnamedCard({ engine, persona: p, onChanged }: { engine: Pick<PersonasEngine, "rename">; persona: PersonaCard; onChanged?: () => void }) {
  const t = useT();
  const [editing, setEditing] = useState(false);
  return (
    <li className="flex flex-col items-center gap-2 rounded-xl border bg-[var(--color-bg)] p-3 text-center" style={BORDER}>
      <Link to={personaHref(p.id)} className="rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)]">
        <FaceAvatar fileId={p.cover_file_id} box={p.cover_box} name={null} className="size-18" />
      </Link>
      <span className="text-xs text-[var(--color-text-muted)]">{t("personas.label.photoCount", { count: p.photo_count })}</span>
      {editing ? (
        <PersonaNameField
          engine={engine}
          personaId={p.id}
          initial=""
          onSaved={() => { setEditing(false); onChanged?.(); }}
          onCancel={() => setEditing(false)}
          className="w-full"
        />
      ) : (
        <button
          type="button"
          onClick={() => setEditing(true)}
          className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-[var(--color-primary)] hover:bg-[var(--color-bg-secondary)]"
        >
          <Plus size={14} aria-hidden="true" />
          {t("personas.action.addAName")}
        </button>
      )}
    </li>
  );
}
