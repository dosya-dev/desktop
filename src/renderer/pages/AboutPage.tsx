import { useEffect, useMemo, useState } from "react";
import { Check, Copy, ChevronLeft } from "lucide-react";
import { useAuth } from "@/lib/auth-context";
import { channelName, syncLine, updateButton, updateHint, type SyncSummaryInput, type UpdateState } from "@/lib/about-info";
import acknowledgements from "virtual:acknowledgements";
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
interface AboutInfo {
  version: string;
  distribution: string;
  platform: string;
  arch: string;
  electron: string;
  chrome: string;
}

export function AboutPage() {
  const { user } = useAuth();
  const [info, setInfo] = useState<AboutInfo | null>(null);
  const [update, setUpdate] = useState<UpdateState | null>(null);
  const [sync, setSync] = useState<SyncSummaryInput | null>(null);
  const [finder, setFinder] = useState<{ available: boolean; enabled: boolean } | null>(null);
  const [copied, setCopied] = useState(false);
  const [showAck, setShowAck] = useState(false);
  const [openAck, setOpenAck] = useState<string | null>(null);

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

  const rows = useMemo(() => {
    const list: [string, string, boolean?][] = [];
    if (info) {
      list.push(["Channel", channelName(info.distribution)]);
      list.push(["System", `${info.platform} · ${info.arch}`]);
      list.push(["Engine", `Electron ${info.electron} · Chromium ${info.chrome}`]);
    }
    list.push(["Signed in as", user?.email ?? "Not signed in"]);
    list.push(["Sync", syncLine(sync), !!sync && sync.pairs.length > 0 && syncLine(sync).startsWith("All synced")]);
    if (finder?.available) list.push(["Finder location", finder.enabled ? "On" : "Off", finder.enabled]);
    return list;
  }, [info, user, sync, finder]);

  const copyDetails = async () => {
    const lines = [
      `dosya ${info?.version ?? ""} (${info ? channelName(info.distribution) : "unknown channel"})`,
      ...rows.map(([k, v]) => `${k}: ${v}`),
    ];
    try {
      await navigator.clipboard.writeText(lines.join("\n"));
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
            className="titlebar-no-drag absolute left-20 flex items-center gap-1 text-xs text-[var(--color-text-secondary)] hover:text-[var(--color-text)]"
          >
            <ChevronLeft size={14} /> Back
          </button>
          <span className="text-sm font-semibold">Acknowledgements</span>
        </div>
        <div className="flex-1 overflow-y-auto px-5 py-3">
          <p className="mb-3 text-xs text-[var(--color-text-secondary)]">
            dosya is built with these open-source packages. Select one to read its licence.
          </p>
          <ul className="divide-y" style={{ borderColor: "var(--color-border)" }}>
            {acknowledgements.map((a: { name: string; version: string; license: string; text: string | null }) => (
              <li key={a.name} className="py-1.5">
                <button
                  onClick={() => setOpenAck(openAck === a.name ? null : a.name)}
                  className="flex w-full items-center justify-between gap-3 text-left text-sm"
                >
                  <span>{a.name} <span className="font-mono text-xs text-[var(--color-text-muted)]">{a.version}</span></span>
                  <span className="font-mono text-[11px] text-[var(--color-text-secondary)]">{a.license}</span>
                </button>
                {openAck === a.name && (
                  <pre className="mt-2 max-h-48 overflow-y-auto whitespace-pre-wrap rounded-lg p-3 font-mono text-[11px] leading-relaxed text-[var(--color-text-secondary)]" style={{ background: "var(--color-bg-secondary)" }}>
                    {a.text ?? `Licensed under ${a.license}. No licence file ships with the package.`}
                  </pre>
                )}
              </li>
            ))}
          </ul>
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
              {info ? `Version ${info.version}` : "Version …"}
            </p>
          </div>
        </div>

        <dl className="mt-5 divide-y border-t" style={{ borderColor: "var(--color-border)" }}>
          {rows.map(([k, v, ok]) => (
            <div key={k} className="flex items-center justify-between gap-4 py-2 text-[13px]">
              <dt className="text-[var(--color-text-secondary)]">{k}</dt>
              <dd className={`text-right font-mono text-xs ${ok ? "text-[var(--color-success,var(--color-primary))]" : ""}`}>{v}</dd>
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
            {copied ? "Copied" : "Copy Details"}
          </button>
        </div>
        {hint && <p className="mt-2 text-xs text-[var(--color-text-secondary)]">{hint}</p>}

        <div className="mt-5 flex flex-wrap items-center justify-between gap-x-4 gap-y-1 border-t pt-3 text-xs" style={{ borderColor: "var(--color-border)" }}>
          <div className="flex gap-3">
            {link("dosya.dev", "https://dosya.dev")}
            {link("Release Notes", "https://dosya.dev/changelog/")}
            <button onClick={() => setShowAck(true)} className="text-[var(--color-primary)] hover:underline">Acknowledgements</button>
          </div>
          <span className="text-[var(--color-text-muted)]">© {new Date().getFullYear()} dosya.dev</span>
        </div>
      </div>
    </div>
  );
}
