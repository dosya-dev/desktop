// apps/desktop/src/renderer/pages/PersonasPage.tsx
//
// Ported from apps/web/src/pages/personas/index.tsx - keep the behaviour in
// step with it. /personas and /personas/:personaId, for every signed-in
// member.
//
// Personas runs on this device (lib/personas-device/engine-host.ts): the
// engine's status picks the screen. off / needs_identity / needs_unlock: the
// first run (components/personas/FirstRun). ready: the progress card over the
// grid (components/personas/Grid), or one persona on /personas/:personaId
// (components/personas/PersonaView). The page re-renders whenever the engine
// reports a change (a read batch, another device's names).
//
// Desktop differences: the Files sidebar is the shell's (AppShell), and the
// workspace comes from workspace-context. A switch while on a persona page
// goes to /personas: the persona belonged to the workspace just left.
import { useEffect, useMemo, useRef } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { Loader2, ScanFace, Settings } from "lucide-react";
import type { PersonasEngine } from "@dosya-dev/personas-engine";
import { FirstRun } from "@/components/personas/FirstRun";
import { PersonasGrid } from "@/components/personas/Grid";
import { PersonaView } from "@/components/personas/PersonaView";
import { PersonasProgressCard } from "@/components/personas/ProgressCard";
import { BORDER, OUTLINE_BUTTON, SMALL } from "@/components/personas/ui";
import { useT } from "@/lib/i18n";
import { personasReaderSupported, usePersonasEngine } from "@/lib/personas-device/engine-host";
import type { ReadyStatus } from "@/lib/personas-progress";
import { useWorkspace } from "@/lib/workspace-context";

export function PersonasPage() {
  const { active } = useWorkspace();
  const { personaId } = useParams();
  const navigate = useNavigate();
  const wsId = active?.id ?? "";

  // A switch (not the first workspace arriving) while on /personas/:id: that
  // persona is the old workspace's, so nothing is rendered for it under the
  // new one and the page goes to the new workspace's list.
  const seenWs = useRef(wsId);
  const switched = seenWs.current !== "" && seenWs.current !== wsId && !!personaId;
  useEffect(() => {
    seenWs.current = wsId;
    if (switched) navigate("/personas", { replace: true });
  }, [wsId, switched, navigate]);

  if (!wsId || switched) return null;
  return <WorkspacePersonas wsId={wsId} personaId={personaId} />;
}

function WorkspacePersonas({ wsId, personaId }: { wsId: string; personaId: string | undefined }) {
  const t = useT();
  const { engine, status, error, refresh } = usePersonasEngine(wsId);

  if (!engine || (!status && !error)) {
    return (
      <div className="flex justify-center py-24" role="status" aria-label={t("common.status.loading")}>
        <Loader2 size={20} className="animate-spin text-[var(--color-text-muted)]" aria-hidden="true" />
      </div>
    );
  }
  if (!status) {
    return (
      <div className="flex flex-col items-center gap-3 py-24 text-center">
        <ScanFace size={32} className="text-[var(--color-text-muted)]" aria-hidden="true" />
        <p className="text-sm text-[var(--color-text-secondary)]">{t("personas.error.couldNotLoadPersonas")}</p>
        <button type="button" className={OUTLINE_BUTTON} style={BORDER} onClick={refresh}>{t("common.action.tryAgain")}</button>
      </div>
    );
  }
  if (status.state !== "ready") return <FirstRun key={wsId} wsId={wsId} state={status.state} engine={engine} />;
  if (personaId) return <PersonaView key={`${wsId}:${personaId}`} wsId={wsId} personaId={personaId} engine={engine} status={status} />;
  return <PersonasOn key={wsId} engine={engine} status={status} />;
}

/**
 * Personas ready: the progress card (this device's reading) over the grid,
 * named first. `status` is a new object after every engine change, so the
 * list is read from the engine again then.
 */
function PersonasOn({ engine, status }: { engine: PersonasEngine; status: ReadyStatus }) {
  const t = useT();
  const supported = personasReaderSupported();
  // eslint-disable-next-line react-hooks/exhaustive-deps -- status is the engine's change signal
  const personas = useMemo(() => engine.listPersonas(), [engine, status]);
  const reading = supported && !status.paused && (status.total === null || status.read < status.total);

  return (
    <div className="mx-auto max-w-5xl">
      <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
        <h1 className="min-w-0 text-2xl font-semibold">{t("common.label.personas")}</h1>
        <Link to="/personas/settings" className={`${OUTLINE_BUTTON} ${SMALL} shrink-0`} style={BORDER}>
          <Settings size={14} aria-hidden="true" />
          {t("personas.action.personasSettings")}
        </Link>
      </div>
      <div className="mb-6 empty:hidden">
        <PersonasProgressCard status={status} supported={supported} onPause={(p) => engine.setPaused(p)} />
      </div>
      {personas.length === 0 && !reading && (
        <div className="flex flex-col items-center gap-3 py-16 text-center">
          <ScanFace size={32} className="text-[var(--color-text-muted)]" aria-hidden="true" />
          <p className="text-sm font-medium">{t("personas.heading.noPeopleYet")}</p>
        </div>
      )}
      {(personas.length > 0 || reading) && <PersonasGrid engine={engine} personas={personas} reading={reading} />}
    </div>
  );
}
