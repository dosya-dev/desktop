import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Download, RefreshCw, Monitor, Apple, Terminal, Loader2, AlertTriangle, Store,
} from "lucide-react";
import { apiRequest } from "@/lib/api-client";
import { formatDate, formatBytes } from "@/lib/format";

type Platform = "windows" | "mac" | "linux";

interface Build {
  url: string;
  size: number;
  name: string;
}

interface Release {
  version: string;
  date: string;
  prerelease: boolean;
  builds: Record<Platform, Build | null>;
}

interface ReleasesResponse {
  ok: boolean;
  releases?: Release[];
  error?: string;
}

type Status = { state: string; version?: string; percent?: number };

const PLATFORMS: { id: Platform; label: string; icon: React.ReactNode }[] = [
  { id: "windows", label: "Windows", icon: <Monitor size={15} /> },
  { id: "mac", label: "macOS", icon: <Apple size={15} /> },
  { id: "linux", label: "Linux", icon: <Terminal size={15} /> },
];

function osToPlatform(os: string): Platform {
  if (os === "darwin") return "mac";
  if (os === "win32") return "windows";
  return "linux";
}

function statusHint(status: Status): string {
  switch (status.state) {
    case "checking": return "Checking for updates…";
    case "available": return `Update available: v${status.version}`;
    case "downloading": return `Downloading ${status.percent ?? 0}%`;
    case "ready": return `Update ready: v${status.version}`;
    case "error": return "Update check failed";
    case "not-available": return "Up to date";
    default: return "";
  }
}

export function UpdatesSection() {
  const [version, setVersion] = useState("");
  const [platform, setPlatform] = useState<Platform>("windows");
  const [status, setStatus] = useState<Status>({ state: "idle" });
  // null = not resolved yet. Deliberately tri-state rather than defaulting to
  // false: a Store user must never see the installer download list, not even
  // for the frame before the IPC answers.
  const [storeBuild, setStoreBuild] = useState<boolean | null>(null);

  // Current version + OS (default the platform tab to the user's OS) + live status.
  useEffect(() => {
    let cancelled = false;
    window.electronAPI.getAppVersion().then((v) => { if (!cancelled) setVersion(v); }).catch(() => {});
    window.electronAPI.getPlatform().then((os) => { if (!cancelled) setPlatform(osToPlatform(os)); }).catch(() => {});
    window.electronAPI.getUpdateStatus().then((s) => { if (!cancelled) setStatus(s); }).catch(() => {});
    // Optional call: an older preload without this channel resolves to false
    // rather than throwing and leaving the section stuck on the skeleton.
    (window.electronAPI.isStoreBuild?.() ?? Promise.resolve(false))
      .then((v) => { if (!cancelled) setStoreBuild(v); })
      .catch(() => { if (!cancelled) setStoreBuild(false); });
    const off = window.electronAPI.onUpdateStatusChanged((s: Status) => setStatus(s));
    return () => { cancelled = true; off?.(); };
  }, []);

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ["desktop-releases"],
    queryFn: () => apiRequest<ReleasesResponse>("/api/desktop/releases"),
    staleTime: 5 * 60 * 1000,
    // The Store build never lists installers, so don't fetch them either.
    enabled: storeBuild === false,
  });

  const releases = data?.ok ? data.releases ?? [] : [];

  // "Latest" = the newest release that actually ships a build for this platform.
  const latestForPlatform = useMemo(
    () => releases.find((r) => r.builds[platform])?.version ?? null,
    [releases, platform],
  );

  const hint = statusHint(status);
  const busy = status.state === "checking" || status.state === "downloading";

  // Still resolving which build this is. Hold the skeleton rather than guess.
  if (storeBuild === null) {
    return (
      <div className="space-y-5">
        <div className="h-[74px] animate-pulse rounded-xl" style={{ background: "var(--color-bg-tertiary)" }} />
      </div>
    );
  }

  // Microsoft Store build. The Store owns updates here, so this section shows
  // no self-update controls and, critically, no installer download list - an
  // app distributed through the Store may not pull executable code from
  // anywhere else, and a "Download" button doing exactly that is the kind of
  // thing certification rejects.
  if (storeBuild) {
    return (
      <div className="space-y-5">
        <div
          className="flex flex-wrap items-center justify-between gap-3 rounded-xl border p-4"
          style={{ borderColor: "var(--color-border)", background: "var(--color-bg-secondary)" }}
        >
          <div>
            <p className="text-sm font-medium">dosya Desktop</p>
            <p className="text-xs" style={{ color: "var(--color-text-secondary)" }}>
              {version ? `You're on v${version}` : "Version unknown"} &middot; Updates are managed by the Microsoft Store
            </p>
          </div>
          <button
            onClick={() => window.electronAPI.openStoreUpdates()}
            className="inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-sm font-medium"
            style={{ borderColor: "var(--color-border)" }}
          >
            <Store size={14} /> Open Microsoft Store
          </button>
        </div>
        <p className="text-xs" style={{ color: "var(--color-text-secondary)" }}>
          You installed dosya from the Microsoft Store, so it updates through the Store
          alongside your other apps. Check for a new version under Library &rsaquo; Downloads and updates.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      {/* Current version + update status */}
      <div
        className="flex flex-wrap items-center justify-between gap-3 rounded-xl border p-4"
        style={{ borderColor: "var(--color-border)", background: "var(--color-bg-secondary)" }}
      >
        <div>
          <p className="text-sm font-medium">dosya Desktop</p>
          <p className="text-xs" style={{ color: "var(--color-text-secondary)" }}>
            {version ? `You're on v${version}` : "Version unknown"}{hint ? ` · ${hint}` : ""}
          </p>
        </div>
        {status.state === "ready" ? (
          <button
            onClick={() => window.electronAPI.installUpdate()}
            className="inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium text-white"
            style={{ background: "var(--color-primary)" }}
          >
            <RefreshCw size={14} /> Restart &amp; install
          </button>
        ) : (
          <button
            onClick={() => window.electronAPI.checkForUpdates()}
            disabled={busy}
            className="inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-sm font-medium disabled:opacity-60"
            style={{ borderColor: "var(--color-border)" }}
          >
            {status.state === "checking" ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
            Check for updates
          </button>
        )}
      </div>

      {/* Platform tabs */}
      <div className="flex gap-1 rounded-lg border p-1" style={{ borderColor: "var(--color-border)", width: "fit-content" }}>
        {PLATFORMS.map((p) => (
          <button
            key={p.id}
            onClick={() => setPlatform(p.id)}
            className="inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm transition-colors"
            aria-pressed={platform === p.id}
            style={platform === p.id
              ? { background: "var(--color-bg-tertiary)", color: "var(--color-text)", fontWeight: 500 }
              : { color: "var(--color-text-secondary)" }}
          >
            {p.icon} {p.label}
          </button>
        ))}
      </div>

      {/* Build list */}
      {isLoading ? (
        <div className="space-y-2">
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-14 animate-pulse rounded-lg" style={{ background: "var(--color-bg-tertiary)" }} />
          ))}
        </div>
      ) : isError || !data?.ok ? (
        <div
          className="flex flex-col items-center gap-3 rounded-lg border border-dashed p-8 text-center"
          style={{ borderColor: "var(--color-border)" }}
        >
          <AlertTriangle size={20} style={{ color: "var(--color-danger)" }} />
          <p className="text-sm" style={{ color: "var(--color-text-secondary)" }}>Couldn&rsquo;t load builds.</p>
          <button onClick={() => refetch()} className="rounded-lg border px-3 py-1.5 text-sm" style={{ borderColor: "var(--color-border)" }}>
            Try again
          </button>
        </div>
      ) : releases.length === 0 ? (
        <div className="rounded-lg border border-dashed p-8 text-center" style={{ borderColor: "var(--color-border)" }}>
          <p className="text-sm" style={{ color: "var(--color-text-secondary)" }}>No builds published yet.</p>
        </div>
      ) : (
        <div className="space-y-2">
          {releases.map((r) => {
            const build = r.builds[platform];
            const isInstalled = !!version && r.version === version;
            const isLatest = latestForPlatform === r.version;
            return (
              <div
                key={r.version}
                className="flex items-center justify-between gap-3 rounded-lg border p-3"
                style={{ borderColor: "var(--color-border)" }}
              >
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-medium">v{r.version}</span>
                    {isLatest && <Badge primary>Latest</Badge>}
                    {isInstalled && <Badge>Installed</Badge>}
                    {r.prerelease && <Badge>Pre-release</Badge>}
                  </div>
                  <p className="text-xs" style={{ color: "var(--color-text-secondary)" }}>
                    {r.date ? formatDate(r.date) : ""}{build ? ` · ${formatBytes(build.size)}` : ""}
                  </p>
                </div>
                {build ? (
                  <button
                    onClick={() => window.open(build.url, "_blank")}
                    className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border px-3 py-1.5 text-sm font-medium"
                    style={{ borderColor: "var(--color-border)" }}
                  >
                    <Download size={14} /> Download
                  </button>
                ) : (
                  <span className="shrink-0 text-xs" style={{ color: "var(--color-text-muted)" }}>
                    Not available
                  </span>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function Badge({ children, primary }: { children: React.ReactNode; primary?: boolean }) {
  return (
    <span
      className="rounded-full px-2 py-0.5 text-[10px] font-medium"
      style={primary
        ? { background: "var(--color-primary)", color: "#fff" }
        : { background: "var(--color-bg-tertiary)", color: "var(--color-text-secondary)" }}
    >
      {children}
    </span>
  );
}
