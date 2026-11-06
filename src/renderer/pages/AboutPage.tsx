import { useCallback, useEffect, useMemo, useState, type CSSProperties } from "react";
import { Check, Copy, ChevronLeft } from "lucide-react";
import { useAuth } from "@/lib/auth-context";
import { aboutRows, detailsText, updateButton, updateHint, type AboutInfo, type SyncSummaryInput, type UpdateState } from "@/lib/about-info";
import { AcknowledgementsList } from "@/components/AcknowledgementsList";
import { useDir, useT } from "@/lib/i18n";
import { makeT, type T } from "../../i18n/translator";
import en from "../../i18n/messages/en.json";
import appIcon from "@/assets/app-icon.png";

/**
 * About dosya. Lives in its own small window (src/main/about-window.ts) and
 * answers the questions a support thread opens with: which build, on what,
 * signed in as whom, and is sync healthy. "Copy details" puts exactly that
 * list on the clipboard.
 *
 * Reads only what the app already knows: the main process's about info, the
 * updater, the sync engine's status, the Finder location switch, and the
 * signed-in account from AuthProvider (which wraps every route).
 */
/** Copy Details goes to support, so it is always English. */
const english: T = makeT("en", en, en);

/**
 * Where the Acknowledgements back button sits: the page's inline start,
 * physical because the macOS traffic lights are drawn by the OS on its own
 * start side (top-left, or top-right under a right-to-left OS). On the
 * lights' side it keeps the 5rem reservation; otherwise 1rem.
 */
function backButtonInset(dir: "ltr" | "rtl"): CSSProperties {
  const side = dir === "rtl" ? "right" : "left";
  const lights = document.documentElement.dataset.osDir === "rtl" ? "right" : "left";
  return { [side]: side === lights ? "5rem" : "1rem" }; // rtl-ok: physical geometry, the traffic lights' side is the OS's
}

export function AboutPage() {
  const { user } = useAuth();
  const t = useT();
  const dir = useDir();
  const [info, setInfo] = useState<AboutInfo | null>(null);
  const [update, setUpdate] = useState<UpdateState | null>(null);
  const [sync, setSync] = useState<SyncSummaryInput | null>(null);
  const [finder, setFinder] = useState<{ available: boolean; enabled: boolean } | null>(null);
  const [copied, setCopied] = useState(false);
  const [showAck, setShowAck] = useState(false);

  useEffect(() => {
    const api = window.electronAPI;
    let live = true;
    api.getAboutInfo().then((i) => { if (live) setInfo(i); }).catch(() => {});
    api.getUpdateStatus().then((u) => { if (live) setUpdate(u); }).catch(() => {});
    api.getSyncStatus().then((s) => { if (live) setSync(s); }).catch(() => {});
    Promise.resolve(api.fileProvider?.status()).then((f) => { if (live && f) setFinder(f); }).catch(() => {});
    const offUpdate = api.onUpdateStatusChanged((u: UpdateState) => setUpdate(u));
    const offSync = api.onSyncStatusChanged((s: SyncSummaryInput) => setSync(s));
    return () => { live = false; offUpdate(); offSync(); };
  }, []);

  // Esc closes the window, as every About panel does.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") window.close(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  // The rows in a given language: the chosen one on screen, English for
  // Copy Details.
  const rowsIn = useCallback((tr: T) => aboutRows(tr, info, user?.email, sync, finder), [info, user, sync, finder]);
  const rows = useMemo(() => rowsIn(t), [rowsIn, t]);

  const copyDetails = async () => {
    try {
      await navigator.clipboard.writeText(detailsText(english, info, rowsIn(english)));
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {}
  };

  const button = updateButton(info?.distribution ?? "direct", update);
  const hint = updateHint(update);
  const onUpdate = () => {
    const api = window.electronAPI;
    if (button.action === "check") void api.checkForUpdates();
    else if (button.action === "install") void api.installUpdate();
    else if (button.action === "store") void api.openStoreUpdates();
  };

  const link = (label: string, href: string) => (
    <a
      key={label}
      href={href}
      target="_blank"
      rel="noreferrer"
      className="text-[var(--color-primary)] hover:underline"
    >
      {label}
    </a>
  );

  if (showAck) {
    return (
      <div className="flex h-screen flex-col bg-[var(--color-bg)] text-[var(--color-text)]">
        <div className="titlebar-drag flex h-11 shrink-0 items-center justify-center border-b px-4" style={{ borderColor: "var(--color-border)" }}>
          <button
            onClick={() => setShowAck(false)}
            // Back sits at the page's inline start. The traffic lights sit on
            // the OS's start side; when the two meet it clears them (5rem).
            style={backButtonInset(dir)}
            className="titlebar-no-drag absolute flex items-center gap-1 text-xs text-[var(--color-text-secondary)] hover:text-[var(--color-text)]"
          >
            <ChevronLeft size={14} className="rtl:-scale-x-100" /> {t("common.back")}
          </button>
          <span className="text-sm font-semibold">{t("about.label.acknowledgements")}</span>
        </div>
        <div className="flex-1 overflow-y-auto px-5 py-3">
          <AcknowledgementsList />
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-screen flex-col bg-[var(--color-bg)] text-[var(--color-text)]">
      {/* Drag region in place of a title bar (macOS keeps only the traffic lights). */}
      <div className="titlebar-drag h-11 shrink-0" />
      <div className="flex-1 overflow-y-auto px-6 pb-5">
        <div className="flex items-center gap-4">
          <img src={appIcon} alt="" width={64} height={64} className="rounded-2xl" />
          <div>
            <h1 className="text-2xl font-bold tracking-tight">dosya</h1>
            <p className="font-mono text-xs text-[var(--color-text-secondary)]" data-testid="about-version">
              {info ? t("common.description.versionVersion", { version: info.version }) : t("about.label.version")}
            </p>
          </div>
        </div>

        <dl className="mt-5 divide-y divide-[var(--color-border)] border-t" style={{ borderColor: "var(--color-border)" }}>
          {rows.map(([k, v, ok]) => (
            <div key={k} className="flex items-center justify-between gap-4 py-2 text-[13px]">
              <dt className="text-[var(--color-text-secondary)]">{k}</dt>
              <dd className={`text-end font-mono text-xs ${ok ? "text-[var(--color-success,var(--color-primary))]" : ""}`}>{v}</dd>
            </div>
          ))}
        </dl>

        <div className="mt-4 flex flex-wrap items-center gap-2">
          {button.action && (
            <button
              onClick={onUpdate}
              disabled={button.busy}
              className="rounded-lg px-3 py-1.5 text-sm font-medium text-[var(--color-primary-fg)] disabled:opacity-60"
              style={{ background: "var(--color-primary)" }}
            >
              {button.label}
            </button>
          )}
          <button
            onClick={copyDetails}
            className="flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-sm font-medium"
            style={{ borderColor: "var(--color-border)" }}
          >
            {copied ? <Check size={14} /> : <Copy size={14} />}
            {copied ? t("about.action.copied") : t("about.action.copyDetails")}
          </button>
        </div>
        {hint && <p className="mt-2 text-xs text-[var(--color-text-secondary)]">{hint}</p>}

        <div className="mt-5 flex flex-wrap items-center justify-between gap-x-4 gap-y-1 border-t pt-3 text-xs" style={{ borderColor: "var(--color-border)" }}>
          <div className="flex gap-3">
            {link("dosya.dev", "https://dosya.dev")}
            {link(t("about.label.releaseNotes"), "https://dosya.dev/changelog/")}
            <button onClick={() => setShowAck(true)} className="text-[var(--color-primary)] hover:underline">{t("about.label.acknowledgements")}</button>
          </div>
          <span className="text-[var(--color-text-muted)]">{t("about.label.yearDosyaDev", { year: String(new Date().getFullYear()) })}</span>
        </div>
      </div>
    </div>
  );
}
