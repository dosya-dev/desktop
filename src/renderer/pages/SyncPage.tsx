import { useState, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  RefreshCw,
  Plus,
  FolderSync,
  Pause,
  Play,
  Trash2,
  FolderOpen,
  Loader2,
  CheckCircle2,
  AlertCircle,
  Clock,
  Upload,
  Download,
  Settings,
  Zap,
  MoreHorizontal,
  HelpCircle,
  X,
  ArrowUpDown,
  ArrowUp,
  ArrowDown,
  ShieldCheck,
  HardDriveDownload,
} from "lucide-react";
import { useSyncStore, type SyncPairRuntimeStatus, type SyncConflict } from "@/lib/sync-store";
import { useWorkspace } from "@/lib/workspace-context";
import { api } from "@/lib/api-client";
import { formatBytes, formatRelative } from "@/lib/format";
import { FolderIcon, syncIconSrc } from "@/components/files/FileIcon";
import { toast } from "sonner";

type Tab = "overview" | "conflicts" | "settings";

const SYNC_MODES = [
  { id: "two-way", label: "Full Sync", desc: "Mirror every action in both directions. Changes on either side are reflected everywhere." },
  { id: "push", label: "Push to Cloud", desc: "Local changes are sent to the cloud. Cloud changes are ignored locally." },
  { id: "push-safe", label: "Protect & Upload", desc: "Only upload files to the cloud. Nothing is ever deleted on the cloud." },
  { id: "pull", label: "Pull from Cloud", desc: "Cloud changes are downloaded locally. Local changes are ignored on the cloud." },
  { id: "pull-safe", label: "Save to Device", desc: "Only download files from the cloud. Nothing is ever deleted locally." },
];

export function SyncPage() {
  const { active, workspaces } = useWorkspace();
  const { status, conflicts, isLoading, init, refresh } = useSyncStore();
  const [tab, setTab] = useState<Tab>("overview");
  const [showAdd, setShowAdd] = useState(false);
  const [showHelp, setShowHelp] = useState(false);

  useEffect(() => {
    const cleanup = init();
    return cleanup;
  }, [init]);

  const allPairs = status?.pairs ?? [];
  const allTransfers = status?.activeTransfers ?? [];
  // Use unresolvedConflicts from status (always up-to-date) as primary source,
  // fall back to the separate conflicts array from the store
  const allConflicts = (status?.unresolvedConflicts?.length ? status.unresolvedConflicts : conflicts) ?? [];

  // Show only data belonging to the active workspace.
  // Sync runs in the background for all workspaces — this is just a UI filter.
  const pairIds = new Set(
    active ? allPairs.filter((p) => p.workspaceId === active.id).map((p) => p.pairId) : allPairs.map((p) => p.pairId),
  );
  const pairs = allPairs.filter((p) => pairIds.has(p.pairId));
  const transfers = allTransfers.filter((t) => pairIds.has(t.pairId));
  const wsConflicts = allConflicts.filter((c) => pairIds.has(c.pairId));

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Sync</h1>
          <p className="text-sm text-[var(--color-text-muted)]">
            Keep local folders in sync with your dosya.dev workspace
          </p>
        </div>
        <div className="flex items-center gap-2">
          {/* Pause/Resume all pairs in this workspace */}
          {pairs.length > 0 && (() => {
            const allPaused = pairs.every((p) => p.status === "paused");
            const anyRunning = pairs.some((p) => p.status !== "paused");
            return allPaused ? (
              <button
                onClick={async () => {
                  for (const p of pairs) {
                    await window.electronAPI.resumeSyncPair(p.pairId);
                  }
                  refresh();
                }}
                className="flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-sm text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-secondary)]"
                style={{ borderColor: "var(--color-border)" }}
                title="Resume all sync pairs in this workspace"
              >
                <Play size={13} /> Resume all
              </button>
            ) : (
              <button
                onClick={async () => {
                  for (const p of pairs) {
                    await window.electronAPI.pauseSyncPair(p.pairId);
                  }
                  refresh();
                }}
                className="flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-sm text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-secondary)]"
                style={{ borderColor: "var(--color-border)" }}
                title="Pause all sync pairs in this workspace"
              >
                <Pause size={13} /> Pause all
              </button>
            );
          })()}
          <button
            onClick={() => setShowHelp(true)}
            className="flex items-center justify-center rounded-full w-7 h-7 text-[var(--color-text-muted)] hover:bg-[var(--color-bg-tertiary)] hover:text-[var(--color-text-secondary)] transition-colors"
            title="How sync works"
          >
            <HelpCircle size={16} />
          </button>
          <button
            onClick={() => setShowAdd(true)}
            className="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium text-white"
            style={{ background: "var(--color-primary)" }}
          >
            <Plus size={14} /> Add sync folder
          </button>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 border-b" style={{ borderColor: "var(--color-border)" }}>
        {([
          { id: "overview" as Tab, label: "Overview" },
          { id: "conflicts" as Tab, label: "Issues", count: wsConflicts.length + pairs.filter((p) => p.status === "error").length },
          { id: "settings" as Tab, label: "Settings" },
        ]).map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`flex items-center gap-1.5 px-3 pb-2.5 text-sm font-medium transition-colors ${
              tab === t.id
                ? "border-b-2 border-[var(--color-primary)] text-[var(--color-primary)]"
                : "text-[var(--color-text-secondary)]"
            }`}
          >
            {t.label}
            {"count" in t && t.count! > 0 && (
              <span className="rounded-full bg-[var(--color-danger)]/10 px-1.5 text-xs text-[var(--color-danger)]">
                {t.count}
              </span>
            )}
          </button>
        ))}
      </div>

      {/* Content */}
      {tab === "overview" && (
        <div>
          {isLoading ? (
            <div className="space-y-2">
              {[1, 2, 3].map((i) => (
                <div key={i} className="h-12 animate-pulse rounded-lg bg-[var(--color-bg-tertiary)]" />
              ))}
            </div>
          ) : pairs.length === 0 ? (
            <div className="flex flex-col items-center justify-center rounded-xl border py-16" style={{ borderColor: "var(--color-border)" }}>
              <img src={syncIconSrc()} alt="" width={48} height={48} className="mb-3 opacity-50" />
              <p className="text-sm font-medium">No sync folders yet</p>
              <p className="mt-1 text-xs text-[var(--color-text-muted)]">
                Add a folder to start syncing files between your computer and dosya.dev
              </p>
              <button
                onClick={() => setShowAdd(true)}
                className="mt-4 flex items-center gap-1.5 rounded-lg px-4 py-2 text-sm font-medium text-white"
                style={{ background: "var(--color-primary)" }}
              >
                <Plus size={14} /> Add sync folder
              </button>
            </div>
          ) : (
            <div className="overflow-auto">
              <table className="w-full text-left text-sm">
                <thead>
                  <tr className="border-b text-xs text-[var(--color-text-muted)]" style={{ borderColor: "var(--color-border)" }}>
                    <th className="py-2.5 pl-4 pr-2 font-medium">Folder</th>
                    <th className="py-2.5 px-2 font-medium w-28">Mode</th>
                    <th className="py-2.5 px-2 font-medium w-28">Status</th>
                    <th className="py-2.5 px-2 font-medium w-28">Last synced</th>
                    <th className="py-2.5 px-2 w-24"></th>
                  </tr>
                </thead>
                <tbody>
                  {pairs.map((pair) => (
                    <SyncPairRow
                      key={pair.pairId}
                      pair={pair}
                      transfers={transfers.filter((t) => t.pairId === pair.pairId)}
                      onRefresh={refresh}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {tab === "conflicts" && (() => {
        const errorPairs = pairs.filter((p) => p.status === "error" && p.errorMessage);
        const hasIssues = wsConflicts.length > 0 || errorPairs.length > 0;

        return (
          <div className="space-y-3">
            {!hasIssues ? (
              <div className="flex flex-col items-center justify-center rounded-xl border py-16" style={{ borderColor: "var(--color-border)" }}>
                <CheckCircle2 size={32} className="mb-2 text-[var(--color-primary)]" />
                <p className="text-sm text-[var(--color-text-muted)]">No issues</p>
              </div>
            ) : (
              <>
                {/* Pair errors */}
                {errorPairs.map((p) => (
                  <div
                    key={p.pairId}
                    className="flex items-start gap-3 rounded-xl border p-4"
                    style={{ borderColor: "var(--color-border)" }}
                  >
                    <AlertCircle size={16} className="mt-0.5 shrink-0 text-[var(--color-danger)]" />
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium">{p.remoteFolderName}</p>
                      <p className="mt-0.5 text-xs text-[var(--color-danger)]">{p.errorMessage}</p>
                      <p className="mt-1 text-[11px] text-[var(--color-text-muted)] font-mono truncate">{p.localPath}</p>
                    </div>
                    <button
                      onClick={() => { window.electronAPI.syncNow(p.pairId); refresh(); }}
                      className="shrink-0 rounded-lg border px-3 py-1.5 text-xs font-medium hover:bg-[var(--color-bg-secondary)]"
                      style={{ borderColor: "var(--color-border)" }}
                    >
                      Retry
                    </button>
                  </div>
                ))}

                {/* File conflicts */}
                {wsConflicts.map((c) => (
                  <ConflictCard key={c.id} conflict={c} onResolve={refresh} />
                ))}
              </>
            )}
          </div>
        );
      })()}

      {tab === "settings" && <SyncSettings />}

      {/* Add Sync Pair Modal */}
      {/* How Sync Works Modal */}
      {showHelp && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30">
          <div className="w-full max-w-lg rounded-xl bg-[var(--color-bg)] shadow-xl" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between border-b px-6 py-4" style={{ borderColor: "var(--color-border)" }}>
              <h3 className="text-lg font-semibold">How sync works</h3>
              <button onClick={() => setShowHelp(false)} className="rounded p-1 hover:bg-[var(--color-bg-tertiary)]">
                <X size={16} />
              </button>
            </div>
            <div className="px-6 py-5 space-y-5 max-h-[70vh] overflow-y-auto">
              <p className="text-sm text-[var(--color-text-secondary)]">
                Sync keeps a folder on your computer connected to a folder in your dosya.dev workspace. Changes are transferred automatically based on the sync mode you choose.
              </p>

              <div className="space-y-3">
                <h4 className="text-sm font-semibold">Sync modes</h4>

                <div className="flex items-start gap-3 rounded-lg bg-[var(--color-bg-secondary)] p-3">
                  <ArrowUpDown size={16} className="mt-0.5 shrink-0 text-[var(--color-primary)]" />
                  <div>
                    <p className="text-sm font-medium">Full Sync</p>
                    <p className="text-xs text-[var(--color-text-muted)]">
                      Two-way mirror. Changes on either side (add, edit, delete) are reflected on the other. Best for keeping two locations identical.
                    </p>
                  </div>
                </div>

                <div className="flex items-start gap-3 rounded-lg bg-[var(--color-bg-secondary)] p-3">
                  <ArrowUp size={16} className="mt-0.5 shrink-0 text-[var(--color-primary)]" />
                  <div>
                    <p className="text-sm font-medium">Push to Cloud</p>
                    <p className="text-xs text-[var(--color-text-muted)]">
                      One-way upload. Local changes are sent to the cloud, including deletions. Cloud-only changes are ignored locally.
                    </p>
                  </div>
                </div>

                <div className="flex items-start gap-3 rounded-lg bg-[var(--color-bg-secondary)] p-3">
                  <ShieldCheck size={16} className="mt-0.5 shrink-0 text-[var(--color-primary)]" />
                  <div>
                    <p className="text-sm font-medium">Protect & Upload</p>
                    <p className="text-xs text-[var(--color-text-muted)]">
                      Safe backup mode. Files are uploaded to the cloud but never deleted there, even if you delete them locally. Best for backups.
                    </p>
                  </div>
                </div>

                <div className="flex items-start gap-3 rounded-lg bg-[var(--color-bg-secondary)] p-3">
                  <ArrowDown size={16} className="mt-0.5 shrink-0 text-[var(--color-primary)]" />
                  <div>
                    <p className="text-sm font-medium">Pull from Cloud</p>
                    <p className="text-xs text-[var(--color-text-muted)]">
                      One-way download. Cloud changes are downloaded locally, including deletions. Local-only changes are ignored.
                    </p>
                  </div>
                </div>

                <div className="flex items-start gap-3 rounded-lg bg-[var(--color-bg-secondary)] p-3">
                  <HardDriveDownload size={16} className="mt-0.5 shrink-0 text-[var(--color-primary)]" />
                  <div>
                    <p className="text-sm font-medium">Save to Device</p>
                    <p className="text-xs text-[var(--color-text-muted)]">
                      Safe download mode. Files are downloaded from the cloud but never deleted locally, even if removed from the cloud.
                    </p>
                  </div>
                </div>
              </div>

              <div className="space-y-2">
                <h4 className="text-sm font-semibold">How it works</h4>
                <ul className="space-y-1.5 text-xs text-[var(--color-text-secondary)]">
                  <li className="flex gap-2"><span className="font-semibold text-[var(--color-text)] shrink-0">1.</span> Pick a remote folder in your workspace and a local folder on your computer.</li>
                  <li className="flex gap-2"><span className="font-semibold text-[var(--color-text)] shrink-0">2.</span> Choose a sync mode that fits your use case.</li>
                  <li className="flex gap-2"><span className="font-semibold text-[var(--color-text)] shrink-0">3.</span> The sync engine watches for changes and transfers files automatically in the background.</li>
                  <li className="flex gap-2"><span className="font-semibold text-[var(--color-text)] shrink-0">4.</span> You can pause, resume, or remove a sync pair at any time without losing files.</li>
                </ul>
              </div>

              <div className="space-y-2">
                <h4 className="text-sm font-semibold">Good to know</h4>
                <ul className="space-y-1.5 text-xs text-[var(--color-text-secondary)]">
                  <li>Sync runs in the background even when the window is closed (app stays in the system tray).</li>
                  <li>If a conflict is detected (same file changed in both places), you'll be notified in the Conflicts tab.</li>
                  <li>Temporary files, system files (.DS_Store, node_modules, .git, etc.) are automatically ignored.</li>
                  <li>Removing a sync pair stops syncing but does not delete any files on either side.</li>
                </ul>
              </div>
            </div>
            <div className="flex justify-end border-t px-6 py-4" style={{ borderColor: "var(--color-border)" }}>
              <button
                onClick={() => setShowHelp(false)}
                className="rounded-lg px-4 py-2 text-sm font-medium text-white"
                style={{ background: "var(--color-primary)" }}
              >
                Got it
              </button>
            </div>
          </div>
          <div className="fixed inset-0 -z-10" onClick={() => setShowHelp(false)} />
        </div>
      )}

      {showAdd && (
        <AddSyncPairModal onClose={() => setShowAdd(false)} onAdded={refresh} />
      )}
    </div>
  );
}

// ── SyncPairRow (table row) ─────────────────────────────────────────

function SyncPairRow({
  pair,
  transfers,
  onRefresh,
}: {
  pair: SyncPairRuntimeStatus;
  transfers: { fileName: string; direction: string; bytesTotal: number; bytesTransferred: number }[];
  onRefresh: () => void;
}) {
  const [showMenu, setShowMenu] = useState(false);
  const [menuPos, setMenuPos] = useState({ top: 0, right: 0 });

  const statusConfig: Record<string, { icon: React.ReactNode; color: string; label: string; dot: string }> = {
    idle: { icon: <CheckCircle2 size={12} />, color: "var(--color-primary)", label: "Synced", dot: "bg-green-500" },
    syncing: { icon: <Loader2 size={12} className="animate-spin" />, color: "#3b82f6", label: "Syncing", dot: "bg-blue-500" },
    paused: { icon: <Pause size={12} />, color: "var(--color-text-muted)", label: "Paused", dot: "bg-gray-400" },
    error: { icon: <AlertCircle size={12} />, color: "var(--color-danger)", label: "Error", dot: "bg-red-500" },
    offline: { icon: <AlertCircle size={12} />, color: "#f59e0b", label: "Offline", dot: "bg-yellow-500" },
    "rate-limited": { icon: <Clock size={12} />, color: "#f59e0b", label: "Waiting", dot: "bg-yellow-500" },
  };

  const s = statusConfig[pair.status] ?? statusConfig.error;

  // Progress info for syncing state
  const isSyncing = transfers.length > 0 || pair.totalFilesInBatch > 0;
  let progressPct = 0;
  let progressLabel = "";
  if (isSyncing) {
    const total = pair.totalFilesInBatch || transfers.length;
    const completed = pair.completedFilesInBatch || 0;
    const activeBytes = transfers.reduce((a, t) => a + t.bytesTransferred, 0);
    const activeTotalBytes = transfers.reduce((a, t) => a + t.bytesTotal, 0);
    const activeFraction = activeTotalBytes > 0 ? activeBytes / activeTotalBytes : 0;
    const effective = completed + activeFraction * transfers.length;
    progressPct = total > 0 ? Math.min(100, Math.round((effective / total) * 100)) : 0;
    progressLabel = `${completed}/${total} files`;
  }

  return (
    <>
      <tr
        className="border-b hover:bg-[var(--color-bg-secondary)] transition-colors"
        style={{ borderColor: "var(--color-border)" }}
      >
        {/* Folder */}
        <td className="py-2.5 pl-4 pr-2">
          <div className="flex items-center gap-2.5">
            <img src={syncIconSrc()} alt="" width={20} height={20} className="shrink-0" />
            <div className="min-w-0">
              <p className="truncate text-sm font-medium">{pair.remoteFolderName}</p>
              <p className="truncate text-[11px] text-[var(--color-text-muted)] font-mono max-w-[260px]">
                {pair.localPath}
              </p>
            </div>
          </div>
        </td>

        {/* Mode */}
        <td className="py-2.5 px-2">
          <span className="rounded-full bg-[var(--color-bg-tertiary)] px-2 py-0.5 text-[10px] font-medium text-[var(--color-text-secondary)] whitespace-nowrap">
            {SYNC_MODES.find(m => m.id === pair.syncMode)?.label ?? "Protect & Upload"}
          </span>
        </td>

        {/* Status */}
        <td className="py-2.5 px-2">
          {isSyncing ? (
            <div className="space-y-1">
              <span className="flex items-center gap-1.5 text-xs font-medium" style={{ color: s.color }}>
                {s.icon} {progressLabel}
              </span>
              <div className="h-1 w-20 rounded-full bg-[var(--color-border)]">
                <div
                  className="h-1 rounded-full transition-all"
                  style={{ width: `${Math.max(progressPct, 2)}%`, background: s.color }}
                />
              </div>
            </div>
          ) : (
            <span className="flex items-center gap-1.5 text-xs font-medium" style={{ color: s.color }}>
              {s.icon} {s.label}
            </span>
          )}
          {pair.errorMessage && pair.status === "error" && (
            <p className="mt-0.5 max-w-[140px] truncate text-[10px] text-[var(--color-danger)]" title={pair.errorMessage}>
              {pair.errorMessage}
            </p>
          )}
        </td>

        {/* Last synced */}
        <td className="py-2.5 px-2 text-xs text-[var(--color-text-muted)] whitespace-nowrap">
          {pair.lastSyncedAt ? formatRelative(pair.lastSyncedAt) : "—"}
        </td>

        {/* Actions */}
        <td className="py-2.5 px-2">
          <div className="flex items-center justify-end gap-0.5">
            <button
              onClick={() => { window.electronAPI.syncNow(pair.pairId); onRefresh(); }}
              className="rounded p-1.5 text-[var(--color-text-muted)] hover:bg-[var(--color-bg-tertiary)]"
              title="Sync now"
            >
              <RefreshCw size={13} />
            </button>
            {pair.status === "paused" ? (
              <button
                onClick={() => { window.electronAPI.resumeSyncPair(pair.pairId); onRefresh(); }}
                className="rounded p-1.5 text-[var(--color-text-muted)] hover:bg-[var(--color-bg-tertiary)]"
                title="Resume"
              >
                <Play size={13} />
              </button>
            ) : (
              <button
                onClick={() => { window.electronAPI.pauseSyncPair(pair.pairId); onRefresh(); }}
                className="rounded p-1.5 text-[var(--color-text-muted)] hover:bg-[var(--color-bg-tertiary)]"
                title="Pause"
              >
                <Pause size={13} />
              </button>
            )}
            <div>
              <button
                ref={(el) => { if (el) (el as any)._menuAnchor = el; }}
                onClick={(e) => {
                  const rect = e.currentTarget.getBoundingClientRect();
                  setMenuPos({ top: rect.bottom + 4, right: window.innerWidth - rect.right });
                  setShowMenu(!showMenu);
                }}
                className="rounded p-1.5 text-[var(--color-text-muted)] hover:bg-[var(--color-bg-tertiary)]"
              >
                <MoreHorizontal size={13} />
              </button>
              {showMenu && (
                <>
                  <div className="fixed inset-0 z-40" onClick={() => setShowMenu(false)} />
                  <div
                    className="fixed z-50 w-40 rounded-lg border bg-[var(--color-bg)] py-1 shadow-lg"
                    style={{ borderColor: "var(--color-border)", top: menuPos.top, right: menuPos.right }}
                  >
                    <button
                      onClick={() => { window.electronAPI.openSyncFolder(pair.pairId); setShowMenu(false); }}
                      className="flex w-full items-center gap-2 px-3 py-1.5 text-sm hover:bg-[var(--color-bg-secondary)]"
                    >
                      <FolderOpen size={13} /> Open folder
                    </button>
                    <div className="my-1 h-px bg-[var(--color-border)]" />
                    <button
                      onClick={async () => {
                        await window.electronAPI.removeSyncPair(pair.pairId);
                        onRefresh();
                        toast.success("Sync pair removed");
                        setShowMenu(false);
                      }}
                      className="flex w-full items-center gap-2 px-3 py-1.5 text-sm text-[var(--color-danger)] hover:bg-[var(--color-bg-secondary)]"
                    >
                      <Trash2 size={13} /> Remove
                    </button>
                  </div>
                </>
              )}
            </div>
          </div>
        </td>
      </tr>
    </>
  );
}

// ── ConflictCard ────────────────────────────────────────────────────

function ConflictCard({ conflict, onResolve }: { conflict: SyncConflict; onResolve: () => void }) {
  const resolve = async (resolution: string) => {
    await window.electronAPI.resolveConflict(conflict.id, resolution);
    onResolve();
    toast.success("Conflict resolved");
  };

  return (
    <div className="rounded-xl border p-4" style={{ borderColor: "var(--color-border)" }}>
      <p className="text-sm font-semibold">{conflict.remoteName}</p>
      <p className="mt-1 text-xs text-[var(--color-text-muted)] font-mono">{conflict.localPath}</p>
      <div className="mt-3 grid grid-cols-2 gap-3 text-xs">
        <div className="rounded-lg bg-[var(--color-bg-secondary)] p-2.5">
          <p className="font-medium">Local</p>
          <p className="text-[var(--color-text-muted)]">{formatBytes(conflict.localSizeBytes)}</p>
          <p className="text-[var(--color-text-muted)]">{formatRelative(conflict.localMtimeMs)}</p>
        </div>
        <div className="rounded-lg bg-[var(--color-bg-secondary)] p-2.5">
          <p className="font-medium">Remote</p>
          <p className="text-[var(--color-text-muted)]">{formatBytes(conflict.remoteSizeBytes)}</p>
          <p className="text-[var(--color-text-muted)]">{formatRelative(conflict.remoteUpdatedAt)}</p>
        </div>
      </div>
      <div className="mt-3 flex gap-2">
        <button onClick={() => resolve("keep-local")} className="flex-1 rounded-lg border px-3 py-1.5 text-xs font-medium hover:bg-[var(--color-bg-secondary)]" style={{ borderColor: "var(--color-border)" }}>
          Keep local
        </button>
        <button onClick={() => resolve("keep-remote")} className="flex-1 rounded-lg border px-3 py-1.5 text-xs font-medium hover:bg-[var(--color-bg-secondary)]" style={{ borderColor: "var(--color-border)" }}>
          Keep remote
        </button>
        <button onClick={() => resolve("keep-both")} className="flex-1 rounded-lg border px-3 py-1.5 text-xs font-medium hover:bg-[var(--color-bg-secondary)]" style={{ borderColor: "var(--color-border)" }}>
          Keep both
        </button>
      </div>
    </div>
  );
}

// ── SyncSettings ────────────────────────────────────────────────────

function SyncSettings() {
  const [pollInterval, setPollInterval] = useState(30);
  const [maxTransfers, setMaxTransfers] = useState(3);

  useEffect(() => {
    window.electronAPI.getSyncConfig().then((c: any) => {
      setPollInterval(Math.round((c.globalPollIntervalMs ?? 30000) / 1000));
      setMaxTransfers(c.maxConcurrentTransfers ?? 3);
    });
  }, []);

  const save = async () => {
    await window.electronAPI.saveSyncConfig({
      globalPollIntervalMs: pollInterval * 1000,
      maxConcurrentTransfers: maxTransfers,
    });
    toast.success("Sync settings saved");
  };

  return (
    <div className="max-w-sm space-y-4">
      <div>
        <label className="mb-1 block text-sm font-medium">Poll interval (seconds)</label>
        <input
          type="number"
          value={pollInterval}
          onChange={(e) => setPollInterval(Number(e.target.value))}
          min={10}
          max={300}
          className="w-full rounded-lg border px-3 py-2 text-sm outline-none focus:border-[var(--color-primary)]"
          style={{ borderColor: "var(--color-border)" }}
        />
        <p className="mt-1 text-xs text-[var(--color-text-muted)]">How often to check for remote changes</p>
      </div>
      <div>
        <label className="mb-1 block text-sm font-medium">Max concurrent transfers</label>
        <input
          type="number"
          value={maxTransfers}
          onChange={(e) => setMaxTransfers(Number(e.target.value))}
          min={1}
          max={10}
          className="w-full rounded-lg border px-3 py-2 text-sm outline-none focus:border-[var(--color-primary)]"
          style={{ borderColor: "var(--color-border)" }}
        />
      </div>
      <button
        onClick={save}
        className="rounded-lg px-4 py-2 text-sm font-medium text-white"
        style={{ background: "var(--color-primary)" }}
      >
        Save settings
      </button>
    </div>
  );
}

// ── AddSyncPairModal (3-step wizard) ────────────────────────────────

const DEFAULT_EXCLUDED = [
  "node_modules", ".git", ".env", ".env.local", ".env.production",
  ".DS_Store", "Thumbs.db", "__pycache__", ".venv", ".svn", ".hg",
  "*.tmp", "*.swp", "*.swo", "*.log", ".Trash", "$RECYCLE.BIN",
  "desktop.ini", "*.crdownload", "*.part",
];

function AddSyncPairModal({ onClose, onAdded }: { onClose: () => void; onAdded: () => void }) {
  const { active } = useWorkspace();
  const workspaceId = active?.id ?? "";
  const [step, setStep] = useState(1);

  // Step 1: folders
  const [remoteFolderId, setRemoteFolderId] = useState<string | null>(null);
  const [remoteFolderName, setRemoteFolderName] = useState("Root");
  const [localPath, setLocalPath] = useState("");

  // Step 2: sync mode
  const [syncMode, setSyncMode] = useState("push-safe");
  const [strategy, setStrategy] = useState<"last-write-wins" | "keep-both">("last-write-wins");

  // Step 3: advanced
  const [excludedPatterns, setExcludedPatterns] = useState<string[]>([...DEFAULT_EXCLUDED]);
  const [newPattern, setNewPattern] = useState("");

  const [loading, setLoading] = useState(false);

  // Fetch workspace default region
  const { data: wsData } = useQuery({
    queryKey: ["workspace-detail-sync", workspaceId],
    queryFn: () => api.get<{ ok: boolean; workspace?: { default_region: string } }>(`/api/workspaces/${workspaceId}`),
    enabled: !!workspaceId,
  });
  const region = wsData?.workspace?.default_region || "auto";

  const { data: foldersData } = useQuery({
    queryKey: ["sync-folder-tree", workspaceId],
    queryFn: () => window.electronAPI.getSyncFolderTree(workspaceId),
    enabled: !!workspaceId,
  });
  const folders = foldersData ?? [];

  const pickFolder = async () => {
    const path = await window.electronAPI.pickLocalFolder();
    if (path) setLocalPath(path);
  };

  const addPattern = () => {
    const p = newPattern.trim();
    if (p && !excludedPatterns.includes(p)) {
      setExcludedPatterns([...excludedPatterns, p]);
    }
    setNewPattern("");
  };

  const removePattern = (pattern: string) => {
    setExcludedPatterns(excludedPatterns.filter((p) => p !== pattern));
  };

  const canProceedStep1 = !!localPath;
  const canProceedStep2 = true; // always valid, has a default
  const canSubmit = !!workspaceId && !!localPath;

  const submit = async () => {
    if (!canSubmit) return;
    setLoading(true);
    try {
      await window.electronAPI.addSyncPair({
        workspaceId,
        workspaceName: active?.name ?? "Workspace",
        remoteFolderId,
        remoteFolderName,
        localPath,
        selectiveFolders: [],
        region,
        pollIntervalMs: 30000,
        syncMode,
        conflictStrategy: strategy,
        enabled: true,
        excludedPatterns,
      });
      onAdded();
      onClose();
      toast.success("Sync folder added");
    } catch (err: any) {
      toast.error(err.message ?? "Failed to add sync pair");
    } finally {
      setLoading(false);
    }
  };

  const steps = [
    { num: 1, label: "Folders" },
    { num: 2, label: "Sync mode" },
    { num: 3, label: "Advanced" },
  ];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30">
      <div className="w-full max-w-lg rounded-xl bg-[var(--color-bg)] shadow-xl" onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="flex items-center justify-between border-b px-6 py-4" style={{ borderColor: "var(--color-border)" }}>
          <h3 className="text-lg font-semibold">Add sync folder</h3>
          <button onClick={onClose} className="rounded p-1 hover:bg-[var(--color-bg-tertiary)]">
            <X size={16} />
          </button>
        </div>

        {/* Step indicator */}
        <div className="flex items-center gap-0 border-b px-6 py-3" style={{ borderColor: "var(--color-border)" }}>
          {steps.map((s, i) => (
            <div key={s.num} className="flex items-center">
              {i > 0 && (
                <div
                  className="mx-2 h-px w-8"
                  style={{ background: step >= s.num ? "var(--color-primary)" : "var(--color-border)" }}
                />
              )}
              <button
                onClick={() => {
                  if (s.num < step) setStep(s.num);
                  if (s.num === 2 && canProceedStep1) setStep(2);
                  if (s.num === 3 && canProceedStep1 && canProceedStep2) setStep(3);
                }}
                className="flex items-center gap-2"
              >
                <span
                  className={`flex h-6 w-6 items-center justify-center rounded-full text-xs font-semibold transition-colors ${
                    step === s.num
                      ? "bg-[var(--color-primary)] text-white"
                      : step > s.num
                        ? "bg-[var(--color-primary)]/20 text-[var(--color-primary)]"
                        : "bg-[var(--color-bg-tertiary)] text-[var(--color-text-muted)]"
                  }`}
                >
                  {step > s.num ? (
                    <CheckCircle2 size={14} />
                  ) : (
                    s.num
                  )}
                </span>
                <span className={`text-xs font-medium ${step === s.num ? "text-[var(--color-text)]" : "text-[var(--color-text-muted)]"}`}>
                  {s.label}
                </span>
              </button>
            </div>
          ))}
        </div>

        {/* Step content */}
        <div className="px-6 py-5 min-h-[320px]">
          {/* ── Step 1: Folders ── */}
          {step === 1 && (
            <div className="space-y-5">
              <div>
                <label className="mb-1.5 block text-sm font-medium">Cloud folder</label>
                <p className="mb-2 text-xs text-[var(--color-text-muted)]">
                  Choose which folder in your workspace to sync, or select root for the entire workspace.
                </p>
                <div
                  className="max-h-40 overflow-y-auto rounded-lg border p-1"
                  style={{ borderColor: "var(--color-border)" }}
                >
                  <button
                    type="button"
                    onClick={() => { setRemoteFolderId(null); setRemoteFolderName("Root"); }}
                    className={`flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-sm transition-colors ${
                      remoteFolderId === null
                        ? "bg-[var(--color-primary)]/10 font-medium text-[var(--color-primary)]"
                        : "hover:bg-[var(--color-bg-secondary)]"
                    }`}
                  >
                    <svg viewBox="0 0 14 14" fill="none" width="14" height="14"><path d="M2 7.5V12a1 1 0 001 1h3V10h2v3h3a1 1 0 001-1V7.5M1 7l6-5 6 5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" /></svg>
                    Root (entire workspace)
                  </button>
                  {folders
                    .filter((f: any) => !f.parent_id)
                    .map((f: any) => (
                      <SyncFolderTreeItem
                        key={f.id}
                        folder={f}
                        allFolders={folders}
                        selectedId={remoteFolderId}
                        onSelect={(id, name) => { setRemoteFolderId(id); setRemoteFolderName(name); }}
                        depth={0}
                      />
                    ))}
                  {folders.length === 0 && (
                    <p className="py-3 text-center text-xs text-[var(--color-text-muted)]">No folders yet — a new one will be created</p>
                  )}
                </div>
              </div>

              <div>
                <label className="mb-1.5 block text-sm font-medium">Local folder</label>
                <p className="mb-2 text-xs text-[var(--color-text-muted)]">
                  Choose a folder on your computer. Its contents will be synced.
                </p>
                <div className="flex gap-2">
                  <div
                    className="flex flex-1 items-center gap-2 rounded-lg border px-3 py-2 text-sm"
                    style={{ borderColor: localPath ? "var(--color-primary)" : "var(--color-border)", background: "var(--color-bg-secondary)" }}
                  >
                    {localPath ? (
                      <>
                        <FolderOpen size={14} className="shrink-0 text-[var(--color-primary)]" />
                        <span className="truncate font-mono text-xs">{localPath}</span>
                      </>
                    ) : (
                      <span className="text-[var(--color-text-muted)]">No folder selected</span>
                    )}
                  </div>
                  <button
                    onClick={pickFolder}
                    className="shrink-0 rounded-lg border px-4 py-2 text-sm font-medium hover:bg-[var(--color-bg-secondary)]"
                    style={{ borderColor: "var(--color-border)" }}
                  >
                    Browse
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* ── Step 2: Sync mode ── */}
          {step === 2 && (
            <div className="space-y-4">
              <div>
                <p className="mb-3 text-xs text-[var(--color-text-muted)]">
                  Choose how files should be synced between your computer and the cloud.
                </p>
              </div>
              <div className="space-y-2">
                {SYNC_MODES.map((m) => (
                  <label
                    key={m.id}
                    className={`flex cursor-pointer items-start gap-3 rounded-lg border p-3 transition-colors ${
                      syncMode === m.id
                        ? "border-[var(--color-primary)] bg-[var(--color-primary)]/5"
                        : "hover:bg-[var(--color-bg-secondary)]"
                    }`}
                    style={{
                      borderColor: syncMode === m.id ? "var(--color-primary)" : "var(--color-border)",
                    }}
                  >
                    <input
                      type="radio"
                      name="syncMode"
                      value={m.id}
                      checked={syncMode === m.id}
                      onChange={() => setSyncMode(m.id)}
                      className="mt-0.5 accent-[var(--color-primary)]"
                    />
                    <div>
                      <p className={`text-sm font-medium ${syncMode === m.id ? "text-[var(--color-primary)]" : ""}`}>{m.label}</p>
                      <p className="text-xs text-[var(--color-text-muted)]">{m.desc}</p>
                    </div>
                  </label>
                ))}
              </div>

              {syncMode === "two-way" && (
                <div>
                  <label className="mb-1.5 block text-sm font-medium">Conflict resolution</label>
                  <div className="flex gap-2">
                    <button
                      onClick={() => setStrategy("last-write-wins")}
                      className={`flex-1 rounded-lg border px-3 py-2 text-xs font-medium transition-colors ${
                        strategy === "last-write-wins"
                          ? "border-[var(--color-primary)] bg-[var(--color-primary)]/5 text-[var(--color-primary)]"
                          : "hover:bg-[var(--color-bg-secondary)]"
                      }`}
                      style={{ borderColor: strategy === "last-write-wins" ? "var(--color-primary)" : "var(--color-border)" }}
                    >
                      Last write wins
                    </button>
                    <button
                      onClick={() => setStrategy("keep-both")}
                      className={`flex-1 rounded-lg border px-3 py-2 text-xs font-medium transition-colors ${
                        strategy === "keep-both"
                          ? "border-[var(--color-primary)] bg-[var(--color-primary)]/5 text-[var(--color-primary)]"
                          : "hover:bg-[var(--color-bg-secondary)]"
                      }`}
                      style={{ borderColor: strategy === "keep-both" ? "var(--color-primary)" : "var(--color-border)" }}
                    >
                      Keep both copies
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* ── Step 3: Advanced (exclude patterns) ── */}
          {step === 3 && (
            <div className="space-y-4">
              <div>
                <label className="mb-1.5 block text-sm font-medium">Excluded files & folders</label>
                <p className="mb-3 text-xs text-[var(--color-text-muted)]">
                  These patterns will be skipped during sync. You can use folder names (node_modules),
                  file names (.env), or wildcards (*.log).
                </p>
              </div>

              {/* Add new pattern */}
              <div className="flex gap-2">
                <input
                  type="text"
                  value={newPattern}
                  onChange={(e) => setNewPattern(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && addPattern()}
                  placeholder="e.g. *.log, dist, .cache"
                  className="flex-1 rounded-lg border px-3 py-2 text-sm outline-none focus:border-[var(--color-primary)]"
                  style={{ borderColor: "var(--color-border)" }}
                />
                <button
                  onClick={addPattern}
                  disabled={!newPattern.trim()}
                  className="shrink-0 rounded-lg px-3 py-2 text-sm font-medium text-white disabled:opacity-50"
                  style={{ background: "var(--color-primary)" }}
                >
                  Add
                </button>
              </div>

              {/* Pattern list */}
              <div className="max-h-48 overflow-y-auto rounded-lg border p-1" style={{ borderColor: "var(--color-border)" }}>
                {excludedPatterns.length === 0 ? (
                  <p className="py-4 text-center text-xs text-[var(--color-text-muted)]">No exclusions — all files will be synced</p>
                ) : (
                  <div className="space-y-0.5">
                    {excludedPatterns.map((p) => (
                      <div
                        key={p}
                        className="flex items-center justify-between rounded-md px-2.5 py-1.5 text-sm hover:bg-[var(--color-bg-secondary)] group"
                      >
                        <span className="font-mono text-xs">{p}</span>
                        <button
                          onClick={() => removePattern(p)}
                          className="rounded p-0.5 text-[var(--color-text-muted)] opacity-0 group-hover:opacity-100 hover:text-[var(--color-danger)]"
                        >
                          <X size={12} />
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <button
                onClick={() => setExcludedPatterns([...DEFAULT_EXCLUDED])}
                className="text-xs text-[var(--color-primary)] hover:underline"
              >
                Reset to defaults
              </button>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between border-t px-6 py-4" style={{ borderColor: "var(--color-border)" }}>
          <button
            onClick={() => step > 1 ? setStep(step - 1) : onClose()}
            className="rounded-lg border px-4 py-2 text-sm"
            style={{ borderColor: "var(--color-border)" }}
          >
            {step === 1 ? "Cancel" : "Back"}
          </button>

          <div className="flex gap-2">
            {step < 3 ? (
              <button
                onClick={() => setStep(step + 1)}
                disabled={step === 1 && !canProceedStep1}
                className="rounded-lg px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
                style={{ background: "var(--color-primary)" }}
              >
                Continue
              </button>
            ) : (
              <button
                onClick={submit}
                disabled={!canSubmit || loading}
                className="rounded-lg px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
                style={{ background: "var(--color-primary)" }}
              >
                {loading ? "Creating..." : "Start syncing"}
              </button>
            )}
          </div>
        </div>
      </div>
      <div className="fixed inset-0 -z-10" onClick={onClose} />
    </div>
  );
}

function SyncFolderTreeItem({
  folder,
  allFolders,
  selectedId,
  onSelect,
  depth,
}: {
  folder: any;
  allFolders: any[];
  selectedId: string | null;
  onSelect: (id: string, name: string) => void;
  depth: number;
}) {
  const [expanded, setExpanded] = useState(depth < 1);
  const children = allFolders.filter((f: any) => f.parent_id === folder.id);
  const hasChildren = children.length > 0;
  const isSelected = selectedId === folder.id;

  return (
    <>
      <div
        className={`flex items-center rounded-md transition-colors ${
          isSelected
            ? "bg-[var(--color-primary)]/10"
            : "hover:bg-[var(--color-bg-secondary)]"
        }`}
        style={{ paddingLeft: `${8 + depth * 16}px` }}
      >
        {/* Expand toggle */}
        <button
          type="button"
          onClick={() => setExpanded(!expanded)}
          className={`flex h-5 w-5 shrink-0 items-center justify-center rounded text-[var(--color-text-muted)] ${hasChildren ? "hover:bg-black/5" : "invisible"}`}
        >
          <svg
            viewBox="0 0 10 10"
            width="10"
            height="10"
            className={`transition-transform ${expanded ? "rotate-90" : ""}`}
          >
            <path d="M3 2l4 3-4 3" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>

        {/* Folder button */}
        <button
          type="button"
          onClick={() => onSelect(folder.id, folder.name)}
          className={`flex flex-1 items-center gap-2 py-1.5 pr-2 text-sm ${
            isSelected ? "font-medium text-[var(--color-primary)]" : ""
          }`}
        >
          <FolderIcon fileCount={folder.file_count ?? 0} size={14} />
          <span className="truncate">{folder.name}</span>
        </button>
      </div>

      {/* Children */}
      {expanded && children.map((child: any) => (
        <SyncFolderTreeItem
          key={child.id}
          folder={child}
          allFolders={allFolders}
          selectedId={selectedId}
          onSelect={onSelect}
          depth={depth + 1}
        />
      ))}
    </>
  );
}
