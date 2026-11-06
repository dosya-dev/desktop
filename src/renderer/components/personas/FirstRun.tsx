// apps/desktop/src/renderer/components/personas/FirstRun.tsx
//
// Ported from apps/web/src/pages/personas/first-run.tsx - keep the behaviour
// and copy in step with it.
//
// The Personas first run, for each engine state that is not ready yet:
//
// - off: what Personas does on this device, and "Start reading on this
//   device" (engine.turnOn). Free on every plan; nobody else has to agree.
// - needs_identity: the same text, the Vault line and the Vault setup form
//   (components/vault/UnlockGate). The new Vault identity seals the user's
//   personas key.
// - needs_unlock: the unlock line and the Vault unlock form (passphrase or
//   recovery key). When the Vault is already unlocked in this window there is
//   nothing to type and Personas opens at once.
//
// After a Vault setup or unlock, unlockPersonas(wsId) hands the identity to
// the engine, which opens (or creates) the personas key and caches it on this
// device; the page then moves on through the engine's status.
import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import type { PersonasEngine } from "@dosya-dev/personas-engine";
import { RecoveryKeyModal } from "@/components/vault/RecoveryKeyModal";
import { SetupCard, UnlockCard } from "@/components/vault/UnlockGate";
import { useT } from "@/lib/i18n";
import { PERSONAS_PRIVACY_URL } from "@/lib/personas";
import { unlockPersonas } from "@/lib/personas-device/engine-host";
import { personasUser } from "@/lib/personas-device/teardown";
import { useVault } from "@/lib/vault/store";
import alex from "@/assets/personas/alex.svg";
import jordan from "@/assets/personas/jordan.svg";
import morgan from "@/assets/personas/morgan.svg";
import sam from "@/assets/personas/sam.svg";
import taylor from "@/assets/personas/taylor.svg";
import { BORDER, EXTERNAL_LINK, OUTLINE_BUTTON, PRIMARY_BUTTON, SMALL } from "./ui";

// Five sample people, the same Open Peeps drawings (CC0) as dosya.dev/personas/: decoration only.
const FACES = [
  { src: sam, size: "size-14", tone: "bg-sky-100" },
  { src: taylor, size: "size-16", tone: "bg-rose-100" },
  { src: alex, size: "size-20", tone: "bg-emerald-100" },
  { src: jordan, size: "size-16", tone: "bg-amber-100" },
  { src: morgan, size: "size-14", tone: "bg-violet-100" },
];

export type FirstRunState = "off" | "needs_identity" | "needs_unlock";

export function FirstRun({ wsId, state, engine }: {
  wsId: string;
  state: FirstRunState;
  engine: Pick<PersonasEngine, "turnOn">;
}) {
  const t = useT();
  return (
    <div className="flex justify-center px-2 pb-10 pt-6">
      <div className="flex w-full max-w-140 flex-col items-center gap-6 text-center">
        <div aria-hidden="true" className="flex items-center ps-3">
          {FACES.map((f, i) => (
            <img key={i} src={f.src} alt="" className={`${f.size} ${f.tone} -ms-3 rounded-full border-[3px] border-[var(--color-bg)]`} />
          ))}
        </div>
        <h1 className="text-3xl font-semibold tracking-tight">{t("personas.heading.findPeopleInYourPhotos")}</h1>
        {state !== "needs_unlock" && (
          <p className="text-base leading-relaxed text-[var(--color-text-secondary)]">{t("personas.description.personasReadsFacesOnThisDevice")}</p>
        )}
        {/* Main's setWindowOpenHandler sends https links to the system browser. */}
        <a href={PERSONAS_PRIVACY_URL} target="_blank" rel="noopener noreferrer" className={EXTERNAL_LINK}>
          {t("personas.action.howPersonasProtectsYourPrivacy")}
        </a>
        {state === "off" && <StartReading engine={engine} />}
        {state === "needs_identity" && <VaultStep wsId={wsId} mode="setup" />}
        {state === "needs_unlock" && <VaultStep wsId={wsId} mode="unlock" />}
      </div>
      {/* Setup shows the one-time recovery key here too (the Vault page is not mounted). */}
      <RecoveryKeyModal />
    </div>
  );
}

function StartReading({ engine }: { engine: Pick<PersonasEngine, "turnOn"> }) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const start = async () => {
    setBusy(true);
    setFailed(false);
    try {
      await engine.turnOn();
    } catch {
      setFailed(true);
    }
    setBusy(false);
  };
  return (
    <div className="flex flex-col items-center gap-3">
      <button type="button" className={PRIMARY_BUTTON} style={{ background: "var(--color-primary)" }} disabled={busy} onClick={() => void start()}>
        {busy && <Loader2 size={16} className="animate-spin" aria-hidden="true" />}
        {t("personas.action.startReadingOnThisDevice")}
      </button>
      {failed && <p role="alert" className="text-sm text-[var(--color-danger)]">{t("personas.error.somethingWentWrongTryAgain")}</p>}
    </div>
  );
}

/**
 * The Vault setup or unlock form, then the hand-over to Personas: as soon as
 * the Vault is unlocked in this window (just now, or already),
 * unlockPersonas runs once. A failure says so with a retry; the Vault stays
 * unlocked.
 */
function VaultStep({ wsId, mode }: { wsId: string; mode: "setup" | "unlock" }) {
  const t = useT();
  const vaultStatus = useVault((s) => s.status);
  const error = useVault((s) => s.error);
  const [opening, setOpening] = useState(false);
  const [failed, setFailed] = useState(false);
  const started = useRef(false);

  // As the Vault page does: bind the persisted Space list to this account.
  useEffect(() => {
    const id = personasUser();
    if (id) useVault.getState().bindOwner(id);
  }, []);

  const open = useCallback(async () => {
    setOpening(true);
    setFailed(false);
    try {
      await unlockPersonas(wsId);
    } catch {
      setFailed(true);
    }
    setOpening(false);
  }, [wsId]);

  useEffect(() => {
    if (vaultStatus !== "unlocked" || started.current) return;
    started.current = true;
    void open();
  }, [vaultStatus, open]);

  const unlocked = vaultStatus === "unlocked";
  return (
    <div className="flex w-full max-w-sm flex-col items-stretch gap-4 text-start">
      <p className="text-center text-sm leading-normal text-[var(--color-text-secondary)]">
        {mode === "setup" ? t("personas.description.personasUsesYourVaultPassphrase") : t("personas.description.unlockWithYourVaultPassphrase")}
      </p>
      {!unlocked && (mode === "setup" ? <SetupCard error={error} /> : <UnlockCard error={error} />)}
      {unlocked && opening && (
        <div className="flex justify-center py-4" role="status" aria-label={t("common.status.loading")}>
          <Loader2 size={20} className="animate-spin text-[var(--color-text-muted)]" aria-hidden="true" />
        </div>
      )}
      {unlocked && failed && (
        <div className="flex flex-col items-center gap-2">
          <p role="alert" className="text-sm text-[var(--color-danger)]">{t("personas.error.somethingWentWrongTryAgain")}</p>
          <button type="button" className={`${OUTLINE_BUTTON} ${SMALL}`} style={BORDER} onClick={() => void open()}>{t("common.action.tryAgain")}</button>
        </div>
      )}
    </div>
  );
}
