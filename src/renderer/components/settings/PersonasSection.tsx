// apps/desktop/src/renderer/components/settings/PersonasSection.tsx
//
// Ported from apps/web/src/pages/settings/personas.tsx - keep the behaviour
// and copy in step with it.
//
// This member's Personas settings, shown on /personas/settings
// (pages/PersonasSettingsPage.tsx). Personas is each member's own, on their
// own devices, so everything here is about this user in this workspace:
//
// - "Personas in this workspace": on = engine.turnOn. Off asks "Are you
//   sure?" and then engine.turnOff, which deletes the people, names and
//   corrections from all the user's devices.
// - "Read on this device": pause / resume reading on this computer.
// - "Skipped folders": photos under them are never read (engine.skipFolder).
// - "Delete my people in this workspace": the same as switching off.
// - Locked or without a Vault: a line and a link to the Personas page, which
//   has the Vault step.
//
// Desktop differences: skipped folders are named from the workspace's folder
// tree (one GET, the same query the picker needs; as AiSearchSection), and
// the dialog is the files Modal shell.
import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { FolderX, Loader2, Plus, X } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/api-client";
import { useAutoDir } from "@/lib/bidi-ui";
import { useT } from "@/lib/i18n";
import { PERSONAS_PRIVACY_URL } from "@/lib/personas";
import { personasReaderSupported, usePersonasEngine } from "@/lib/personas-device/engine-host";
import { lastPersonasUser } from "@/lib/personas-device/teardown";
import { clearKeyIfLastWorkspace } from "@/lib/personas-device/wipe";
import { FolderPickerModal, type PickerFolder } from "@/components/files/FolderPickerModal";
import { Modal } from "@/components/files/Modal";
import { BORDER, DANGER_BUTTON, EXTERNAL_LINK, OUTLINE_BUTTON, SMALL } from "@/components/personas/ui";

const SMALL_BUTTON = "inline-flex shrink-0 items-center gap-1 rounded-lg border px-2.5 py-1 text-xs font-medium hover:bg-[var(--color-bg-secondary)] disabled:opacity-50";

function Switch({ checked, label, disabled, onClick }: { checked: boolean; label: string; disabled?: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className={`relative h-6 w-11 shrink-0 rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
        checked ? "bg-[var(--color-primary)]" : "bg-[var(--color-border)]"
      }`}
    >
      <div
        className={`absolute top-0.5 h-5 w-5 rounded-full bg-[var(--color-bg)] shadow transition-transform ${
          // rtl-ok: mirrored, the rtl: twin slides the knob the other way
          checked ? "translate-x-5 rtl:-translate-x-5" : "translate-x-0.5 rtl:-translate-x-0.5"
        }`}
      />
    </button>
  );
}

export function PersonasSection({ wsId }: { wsId: string }) {
  const t = useT();
  const ownDir = useAutoDir();
  const { engine, status, error, refresh } = usePersonasEngine(wsId);
  const [busy, setBusy] = useState<"on" | "skip" | null>(null);
  const [offOpen, setOffOpen] = useState(false);
  const [turningOff, setTurningOff] = useState(false);
  const [offFailed, setOffFailed] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [picked, setPicked] = useState<string | null>(null);

  const ready = status?.state === "ready";
  // Read on every render: the hook re-renders on every engine change.
  const skipped = engine && ready ? engine.skippedFolders() : [];

  // Skipped folders are kept as bare ids; their names come from the folder
  // tree, which the Add folder picker needs anyway.
  const tree = useQuery({
    queryKey: ["folders-tree", wsId],
    queryFn: () => api.get<{ ok: boolean; folders: PickerFolder[] }>(`/api/folders/tree?workspace_id=${encodeURIComponent(wsId)}`),
    enabled: !!wsId && (skipped.length > 0 || pickerOpen),
  });
  const folders = tree.data?.folders ?? [];

  // The turn-off dialog: Cancel takes focus when it opens, Escape closes it
  // (not while turning off), and focus goes back to the opener on close.
  const offCancelRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    if (!offOpen) return;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    offCancelRef.current?.focus();
    return () => { if (opener?.isConnected) opener.focus(); };
  }, [offOpen]);
  useEffect(() => {
    if (!offOpen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape" && !turningOff) { e.stopPropagation(); setOffOpen(false); } };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [offOpen, turningOff]);

  const header = (
    <div className="mb-4">
      <h1 className="text-2xl font-semibold">{t("personas.action.personasSettings")}</h1>
      <p className="mt-1 max-w-xl text-sm text-[var(--color-text-secondary)]">{t("personas.description.groupsThePhotosInThisWorkspaceByThePeopleInThem")}</p>
      <p className="mt-1.5">
        {/* Main's setWindowOpenHandler sends https links to the system browser. */}
        <a href={PERSONAS_PRIVACY_URL} target="_blank" rel="noopener noreferrer" className={EXTERNAL_LINK}>
          {t("personas.action.howPersonasProtectsYourPrivacy")}
        </a>
      </p>
    </div>
  );
  const card = "max-w-xl rounded-xl border px-4 py-4";

  if (!engine || (!status && !error)) {
    return (
      <div data-testid="personas-section">
        {header}
        <div className="flex justify-center py-10" role="status" aria-label={t("common.status.loading")}>
          <Loader2 size={20} className="animate-spin text-[var(--color-text-muted)]" aria-hidden="true" />
        </div>
      </div>
    );
  }
  if (!status) {
    return (
      <div data-testid="personas-section">
        {header}
        <div className={`${card} flex flex-wrap items-center gap-4`} style={BORDER}>
          <p role="alert" className="min-w-0 flex-1 basis-72 text-sm text-[var(--color-text-secondary)]">{t("personas.error.couldNotLoadPersonas")}</p>
          <button type="button" className={`${OUTLINE_BUTTON} ${SMALL}`} style={BORDER} onClick={refresh}>{t("common.action.tryAgain")}</button>
        </div>
      </div>
    );
  }

  if (status.state === "needs_identity" || status.state === "needs_unlock") {
    return (
      <div data-testid="personas-section">
        {header}
        <div className={`${card} flex flex-wrap items-center gap-4`} style={BORDER}>
          <p className="min-w-0 flex-1 basis-72 text-sm text-[var(--color-text-secondary)]">
            {status.state === "needs_identity" ? t("personas.description.personasUsesYourVaultPassphrase") : t("personas.description.unlockWithYourVaultPassphrase")}
          </p>
          <Link to="/personas" className={`${OUTLINE_BUTTON} ${SMALL}`} style={BORDER}>{t("personas.action.openPersonas")}</Link>
        </div>
      </div>
    );
  }

  const supported = personasReaderSupported();
  const paused = ready && status.paused;

  const turnOn = async () => {
    setBusy("on");
    try {
      await engine.turnOn();
      toast.success(t("settings.feedback.settingsUpdated"));
    } catch {
      toast.error(t("settings.error.failedToSave"), { description: t("personas.error.somethingWentWrongTryAgain") });
    }
    setBusy(null);
  };

  const turnOff = async () => {
    setTurningOff(true);
    setOffFailed(false);
    try {
      await engine.turnOff();
      // The last workspace on this device: its cached key goes too.
      await clearKeyIfLastWorkspace(lastPersonasUser());
      setOffOpen(false);
      toast.success(t("settings.feedback.settingsUpdated"));
    } catch {
      setOffFailed(true);
    }
    setTurningOff(false);
  };
  const openOff = () => { setOffFailed(false); setOffOpen(true); };

  const skip = async (id: string, on: boolean) => {
    setBusy("skip");
    try {
      await engine.skipFolder(id, on);
    } catch {
      toast.error(t("settings.error.failedToSave"), { description: t("personas.error.somethingWentWrongTryAgain") });
    }
    setBusy(null);
  };

  const nameOf = (id: string) => folders.find((f) => f.id === id)?.name
    ?? (tree.isSuccess || tree.isError ? t("file-requests.label.unknownFolder") : "…");
  // A folder already skipped (and so its subtree) is not offered again.
  const pickable = folders.filter((f) => !skipped.includes(f.id));
  const openPicker = () => { setPicked(null); setPickerOpen(true); };
  const addFolder = () => {
    setPickerOpen(false);
    if (!picked || skipped.includes(picked)) return;
    void skip(picked, true);
  };

  return (
    <div data-testid="personas-section">
      {header}

      <div className="max-w-xl divide-y rounded-xl border" style={BORDER}>
        <div className="flex items-center justify-between gap-4 px-4 py-4">
          <p className="text-sm font-medium">{t("personas.label.personasInThisWorkspace")}</p>
          <Switch
            checked={ready}
            label={t("personas.label.personasInThisWorkspace")}
            disabled={busy !== null}
            onClick={() => (ready ? openOff() : void turnOn())}
          />
        </div>

        {ready && (
          supported ? (
            <div className="flex items-center justify-between gap-4 px-4 py-4">
              <p className="text-sm font-medium">{t("personas.label.readOnThisDevice")}</p>
              <Switch checked={!paused} label={t("personas.label.readOnThisDevice")} onClick={() => engine.setPaused(!paused)} />
            </div>
          ) : (
            <p className="px-4 py-4 text-xs text-[var(--color-text-muted)]">{t("personas.description.thisDeviceCantReadPhotos")}</p>
          )
        )}

        {ready && (
          <div className="px-4 py-4">
            <div className="flex items-center justify-between gap-4">
              <p className="text-sm font-medium">{t("personas.label.skippedFolders")}</p>
              <button type="button" className={SMALL_BUTTON} style={BORDER} disabled={busy !== null} onClick={openPicker}>
                {busy === "skip" ? <Loader2 size={12} className="animate-spin" aria-hidden="true" /> : <Plus size={12} aria-hidden="true" />}
                {t("settings.action.addFolder")}
              </button>
            </div>
            {skipped.length > 0 && (
              <ul className="mt-3 flex flex-wrap gap-1.5">
                {skipped.map((id) => {
                  const name = nameOf(id);
                  return (
                    <li key={id} className="inline-flex items-center gap-1 rounded-md border bg-[var(--color-bg-secondary)] py-0.5 ps-2 pe-1 text-xs" style={BORDER}>
                      <FolderX size={12} className="text-[var(--color-text-muted)]" aria-hidden="true" />
                      <span className="max-w-48 truncate" dir={ownDir ?? "auto"}>{name}</span>
                      <button
                        type="button"
                        aria-label={t("personas.action.stopSkippingFolder", { folder: name })}
                        disabled={busy !== null}
                        onClick={() => void skip(id, false)}
                        className="rounded p-0.5 hover:bg-[var(--color-bg-tertiary)] disabled:opacity-50"
                      >
                        <X size={12} aria-hidden="true" />
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        )}
      </div>

      {ready && (
        <div
          className="mt-4 flex max-w-xl flex-wrap items-center gap-4 rounded-xl border px-4 py-4"
          style={{ borderColor: "color-mix(in oklab, var(--color-danger) 35%, transparent)" }}
        >
          <p className="min-w-0 flex-1 basis-64 text-xs text-[var(--color-text-muted)]">{t("personas.description.yourPeopleNamesAndCorrectionsAreDeleted")}</p>
          <button type="button" className={`${DANGER_BUTTON} px-3 py-1.5 text-xs`} style={{ background: "var(--color-danger)" }} onClick={openOff}>
            {t("personas.action.deleteMyPeopleInThisWorkspace")}
          </button>
        </div>
      )}

      {pickerOpen && (
        <FolderPickerModal
          title={t("personas.label.skippedFolders")}
          actionLabel={t("settings.action.addFolder")}
          folders={pickable}
          selectedId={picked}
          isPending={tree.isLoading}
          onSelect={setPicked}
          onConfirm={addFolder}
          onClose={() => setPickerOpen(false)}
        />
      )}

      {offOpen && (
        <Modal onClose={() => { if (!turningOff) setOffOpen(false); }} maxWidth={448}>
          <div role="dialog" aria-modal="true" aria-labelledby="personas-off-title">
            <h2 id="personas-off-title" className="text-lg font-semibold">{t("common.heading.areYouSure")}</h2>
            <p className="mt-2 text-sm leading-normal text-[var(--color-text-secondary)]">{t("personas.description.yourPeopleNamesAndCorrectionsAreDeleted")}</p>
            {offFailed && <p role="alert" className="mt-3 text-sm text-[var(--color-danger)]">{t("personas.error.somethingWentWrongTryAgain")}</p>}
            <div className="mt-5 flex justify-end gap-2">
              <button ref={offCancelRef} type="button" className={OUTLINE_BUTTON} style={BORDER} onClick={() => setOffOpen(false)} disabled={turningOff}>{t("common.cancel")}</button>
              <button type="button" className={DANGER_BUTTON} style={{ background: "var(--color-danger)" }} onClick={() => void turnOff()} disabled={turningOff}>
                {turningOff && <Loader2 size={14} className="animate-spin" aria-hidden="true" />}
                {t("personas.action.turnOffAndDelete")}
              </button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}
