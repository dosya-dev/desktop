// apps/desktop/src/renderer/components/personas/PeopleChips.tsx
//
// Ported from apps/web/src/components/personas/people-chips.tsx - keep in step.
//
// "In this photo": the people this device's Personas found in one photo
// (engine.peopleInFile), as chips linking to each persona page. Nothing is
// asked of a server: the engine answers from the decrypted index. The engine
// is loaded on demand, so the viewer does not carry it. Shown only while
// Personas is ready; off, locked, signed out or a failure hide the row. It
// follows the index: a rename elsewhere shows at once.
import { useEffect, useState, type ReactNode } from "react";
import { Link, useInRouterContext } from "react-router-dom";
import type { Box, PersonasEngine } from "@dosya-dev/personas-engine";
import { useAutoDir } from "@/lib/bidi-ui";
import { useT } from "@/lib/i18n";
import { personaHref } from "@/lib/personas";
import { FaceAvatar } from "./FaceAvatar";

type Chip = { persona_id: string; name: string | null; box: Box };

/** One chip per shown persona (a persona can have two faces in a photo); faces of no shown persona have no page. */
function chipsOf(engine: PersonasEngine, fileId: string): Chip[] {
  const seen = new Set<string>();
  const out: Chip[] = [];
  for (const f of engine.peopleInFile(fileId)) {
    if (!f.persona_id || seen.has(f.persona_id)) continue;
    seen.add(f.persona_id);
    out.push({ persona_id: f.persona_id, name: f.name, box: f.box });
  }
  return out;
}

export function PeopleChips({ wsId, fileId, inline = false, className = "", style }: {
  wsId: string;
  fileId: string;
  /** Label and chips on one line (the viewer's strip) instead of stacked (a details column). */
  inline?: boolean;
  className?: string;
  style?: React.CSSProperties;
}) {
  const t = useT();
  const ownDir = useAutoDir();
  // The viewer can be mounted outside a router (tests, embeds): plain links then.
  const routed = useInRouterContext();
  const [people, setPeople] = useState<{ fileId: string; list: Chip[] } | null>(null);

  useEffect(() => {
    if (!wsId) return;
    let cancelled = false;
    let unsubscribe = () => {};
    const show = (list: Chip[]) => { if (!cancelled) setPeople({ fileId, list }); };
    void (async () => {
      let engine: PersonasEngine;
      try {
        engine = (await import("@/lib/personas-device/engine-host")).personasEngine(wsId);
      } catch {
        show([]);
        return;
      }
      const update = async () => {
        try {
          const st = await engine.status();
          show(st.state === "ready" ? chipsOf(engine, fileId) : []);
        } catch {
          show([]);
        }
      };
      if (cancelled) return;
      unsubscribe = engine.subscribe(() => { void update(); });
      await update();
    })();
    return () => { cancelled = true; unsubscribe(); };
  }, [wsId, fileId]);

  if (!people || people.fileId !== fileId || people.list.length === 0) return null;

  return (
    <div className={`${inline ? "flex flex-wrap items-center gap-x-3 gap-y-1.5" : ""} ${className}`} style={style} data-testid="viewer-people">
      <p className="text-xs font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">{t("personas.label.inThisPhoto")}</p>
      <ul className={`flex flex-wrap gap-1.5 ${inline ? "" : "mt-2"}`}>
        {people.list.map((p) => (
          <li key={p.persona_id}>
            <ChipLink routed={routed} to={personaHref(p.persona_id)}>
              <FaceAvatar fileId={fileId} box={p.box} name={p.name} className="size-6" />
              <span className="max-w-32 truncate" dir={p.name ? ownDir : undefined}>{p.name ?? t("personas.label.unnamed")}</span>
            </ChipLink>
          </li>
        ))}
      </ul>
    </div>
  );
}

const CHIP = "inline-flex items-center gap-1.5 rounded-full border bg-[var(--color-bg)] py-0.5 ps-0.5 pe-2.5 text-xs font-medium hover:bg-[var(--color-bg-secondary)]";
const CHIP_STYLE = { borderColor: "var(--color-border)" } as const;

function ChipLink({ routed, to, children }: { routed: boolean; to: string; children: ReactNode }) {
  return routed
    ? <Link to={to} className={CHIP} style={CHIP_STYLE}>{children}</Link>
    : <a href={to} className={CHIP} style={CHIP_STYLE}>{children}</a>;
}
