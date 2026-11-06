import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  FileText,
  Share2,
  HardDrive,
  Upload,
  TrendingUp,
  RefreshCw,
  CheckCircle2,
  Loader2,
  AlertCircle,
  Pause,
  FolderSync,
} from "lucide-react";
import { FileIcon } from "@/components/files/FileIcon";
import { AiSearchCard } from "@/components/dashboard/AiSearchCard";
import { useNavigate } from "react-router-dom";
import { actionLabel } from "@/lib/activity-labels";
import { api } from "@/lib/api-client";
import { useWorkspace } from "@/lib/workspace-context";
import { useSyncPairCardsKey, useSyncStore } from "@/lib/sync-store";
import { syncPairCards } from "@/lib/sync-summary";
import { formatBytes, formatRelative, fileIcon } from "@/lib/format";
import { storagePercent as usagePercent } from "@/lib/storage-percent";
import { intlLocale } from "@/lib/locale-state";
import { useT } from "@/lib/i18n";
import { usePairFolderLabel } from "@/lib/root-pairs";
import { richText } from "@/lib/rich-text";
import type { MessageKey } from "../../i18n/keys";

/**
 * Status words the sync card can name. A status without a key here (the
 * needs-* states) is shown as the engine reports it, as before.
 */
const SYNC_STATUS_LABELS: Record<string, MessageKey> = {
  syncing: "sync.label.syncing",
  error: "common.status.error",
  paused: "common.status.paused",
  idle: "sync.label.idle",
};

interface DashboardData {
  ok: boolean;
  user_name: string;
  stats: {
    total_files: number;
    files_this_week: number;
    shared_externally: number;
    total_bytes: number;
    trash_bytes: number;
    storage_cap_bytes: number;
  };
  storage_breakdown: { name: string; bytes: number; color: string }[];
  recent_files: {
    id: string;
    name: string;
    size_bytes: number;
    extension: string | null;
    created_at: number;
    share_count: number;
  }[];
  activity: {
    id: string;
    action: string;
    entity_type: string;
    metadata: string | null;
    created_at: number;
    user_name: string | null;
    meta: unknown;
  }[];
  team_stats: {
    user_id: string;
    name: string;
    file_count: number;
    total_bytes: number;
  }[];
}

export function DashboardPage() {
  const t = useT();
  const { active } = useWorkspace();
  const navigate = useNavigate();

  const { data, isLoading } = useQuery({
    queryKey: ["dashboard", active?.id],
    queryFn: () =>
      api.get<DashboardData>(
        `/api/dashboard?workspace_id=${active?.id}`,
      ),
    enabled: !!active,
  });

  if (isLoading || !data) {
    return (
      <div className="space-y-6">
        <h1 className="text-2xl font-semibold">{t("common.label.dashboard")}</h1>
        <div className="grid grid-cols-3 gap-4">
          {[1, 2, 3].map((i) => (
            <div
              key={i}
              className="h-28 animate-pulse rounded-xl bg-[var(--color-bg-tertiary)]"
            />
          ))}
        </div>
        <div className="grid grid-cols-2 gap-4">
          {[1, 2].map((i) => (
            <div
              key={i}
              className="h-64 animate-pulse rounded-xl bg-[var(--color-bg-tertiary)]"
            />
          ))}
        </div>
      </div>
    );
  }

  const { stats } = data;
  const storage = usagePercent(stats.total_bytes, stats.storage_cap_bytes);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">
            {data.user_name
              ? t("dashboard.heading.welcomeBackUserName", { userName: data.user_name })
              : t("common.heading.welcomeBack")}
          </h1>
          <p className="text-sm text-[var(--color-text-secondary)]">
            {t("dashboard.description.hereSWhatSHappeningInYourWorkspace")}
          </p>
        </div>
        <button
          onClick={() => navigate("/upload")}
          className="flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-medium text-[var(--color-primary-fg)]"
          style={{ background: "var(--color-primary)" }}
        >
          <Upload size={16} />
          {t("common.action.uploadFiles")}
        </button>
      </div>

      {/* Stats Grid */}
      <div className="grid grid-cols-3 gap-4">
        <StatCard
          icon={<FileText size={20} />}
          label={t("dashboard.label.totalFiles")}
          value={stats.total_files.toLocaleString(intlLocale())}
          sub={t("dashboard.description.countAddedThisWeek", { count: stats.files_this_week })}
        />
        <StatCard
          icon={<Share2 size={20} />}
          label={t("dashboard.label.sharedExternally")}
          value={stats.shared_externally.toLocaleString(intlLocale())}
          sub={t("dashboard.label.activeShareLinks")}
        />
        <StatCard
          icon={<HardDrive size={20} />}
          label={t("dashboard.label.storageUsed")}
          value={formatBytes(stats.total_bytes)}
          sub={t("dashboard.description.percentOfTotalStorage", { percent: storage.label, total: formatBytes(stats.storage_cap_bytes) })}
        />
      </div>

      {/* Two-Column Layout */}
      <div className="grid grid-cols-5 gap-4">
        {/* Left Column */}
        <div className="col-span-3 space-y-4">
          {/* Storage Breakdown */}
          {data.storage_breakdown.length > 0 && (
            <Card title={t("dashboard.tooltip.storageBreakdown")}>
              {/* Total usage summary */}
              <div className="mb-4 flex items-center justify-between">
                <div>
                  {/* One message; the amount keeps its large type wherever the
                      translation puts it. */}
                  <p className="text-sm font-normal text-[var(--color-text-muted)]">
                    {richText(t, "dashboard.description.totalbytesUsed", {}, {
                      totalBytes: (
                        <span className="text-lg font-semibold text-[var(--color-text)]">
                          {formatBytes(stats.total_bytes)}
                        </span>
                      ),
                    })}
                  </p>
                  <p className="text-xs text-[var(--color-text-muted)]">
                    {stats.trash_bytes > 0
                      ? t("dashboard.description.ofStorageCapBytesTotalTrashBytesInTrash", {
                          storageCapBytes: formatBytes(stats.storage_cap_bytes),
                          trashBytes: formatBytes(stats.trash_bytes),
                        })
                      : t("dashboard.description.ofStorageCapBytesTotal", {
                          storageCapBytes: formatBytes(stats.storage_cap_bytes),
                        })}
                  </p>
                </div>
                <div className="text-end">
                  <p className="text-2xl font-bold">{storage.label}%</p>
                </div>
              </div>
              {/* Overall progress bar */}
              <div className="mb-4 h-2.5 rounded-full bg-[var(--color-bg-tertiary)]">
                <div
                  className="h-2.5 rounded-full transition-all"
                  style={{
                    width: storage.barWidth,
                    background: storage.pct > 90 ? "var(--color-danger)" : "var(--color-primary)",
                  }}
                />
              </div>
              {/* Category bars */}
              <div className="space-y-2.5">
                {data.storage_breakdown.map((cat) => {
                  const maxBytes = Math.max(
                    ...data.storage_breakdown.map((b) => b.bytes),
                    1,
                  );
                  const barPct = Math.round((cat.bytes / maxBytes) * 100);
                  return (
                    <div key={cat.name} className="flex items-center gap-3">
                      <div
                        className="h-3 w-3 shrink-0 rounded-full"
                        style={{ background: cat.color }}
                      />
                      <span className="w-24 text-sm">{cat.name}</span>
                      <div className="flex-1">
                        <div className="h-2 rounded-full bg-[var(--color-bg-tertiary)]">
                          <div
                            className="h-2 rounded-full transition-all"
                            style={{
                              width: `${Math.max(barPct, 1)}%`,
                              background: cat.color,
                            }}
                          />
                        </div>
                      </div>
                      <span className="w-20 text-end text-sm text-[var(--color-text-secondary)]">
                        {formatBytes(cat.bytes)}
                      </span>
                    </div>
                  );
                })}
              </div>
            </Card>
          )}

          {/* Recent Files */}
          <Card
            title={t("dashboard.tooltip.recentFiles")}
            action={
              <button
                onClick={() => navigate("/files")}
                className="text-xs text-[var(--color-primary)] hover:underline"
              >
                {t("common.action.viewAll")}
              </button>
            }
          >
            {data.recent_files.length > 0 ? (
              <div className="space-y-1">
                {data.recent_files.map((f) => (
                  <div
                    key={f.id}
                    className="flex items-center gap-3 rounded-lg px-3 py-2 hover:bg-[var(--color-bg-secondary)] transition-colors cursor-pointer"
                  >
                    <FileIcon name={f.name} size={16} className="shrink-0" />
                    <span className="min-w-0 flex-1 truncate text-sm" title={f.name}>{f.name}</span>
                    <span className="shrink-0 text-xs text-[var(--color-text-muted)]">
                      {formatBytes(f.size_bytes)}
                    </span>
                    <span className="shrink-0 text-xs text-[var(--color-text-muted)]">
                      {formatRelative(f.created_at)}
                    </span>
                  </div>
                ))}
              </div>
            ) : (
              <p className="py-4 text-center text-sm text-[var(--color-text-muted)]">
                {t("dashboard.empty.noFilesYet")}
              </p>
            )}
          </Card>

          {/* Team Usage */}
          {data.team_stats.length > 1 && (
            <Card title={t("dashboard.tooltip.teamUsage")}>
              <div className="space-y-3">
                {data.team_stats.map((m) => {
                  const pct = stats.total_bytes
                    ? Math.round((m.total_bytes / stats.total_bytes) * 100)
                    : 0;
                  return (
                    <div key={m.user_id} className="flex items-center gap-3">
                      <div className="flex h-7 w-7 items-center justify-center rounded-full bg-[var(--color-bg-tertiary)] text-xs font-medium">
                        {m.name.charAt(0).toUpperCase()}
                      </div>
                      <span className="w-28 truncate text-sm" title={m.name}>{m.name}</span>
                      <div className="flex-1">
                        <div className="h-2 rounded-full bg-[var(--color-bg-tertiary)]">
                          <div
                            className="h-2 rounded-full bg-[var(--color-primary)] transition-all"
                            style={{ width: `${Math.max(pct, 1)}%` }}
                          />
                        </div>
                      </div>
                      <span className="w-20 text-end text-xs text-[var(--color-text-secondary)]">
                        {formatBytes(m.total_bytes)}
                      </span>
                    </div>
                  );
                })}
              </div>
            </Card>
          )}
        </div>

        {/* Right Column */}
        <div className="col-span-2 space-y-4">
          {/* AI search: this workspace's indexing status, beside Storage
              breakdown. Renders nothing when the owner's plan has no AI search. */}
          {active && <AiSearchCard wsId={active.id} />}

          {/* Activity */}
          <Card
            title={t("sync.label.activity")}
            action={
              <button
                onClick={() => navigate("/activity")}
                className="text-xs text-[var(--color-primary)] hover:underline"
              >
                {t("dashboard.action.all")}
              </button>
            }
          >
            {data.activity.length > 0 ? (
              <div className="space-y-1">
                {data.activity.slice(0, 8).map((a) => (
                  <div
                    key={a.id}
                    className="flex items-start gap-3 rounded-lg px-3 py-2"
                  >
                    <div className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-[var(--color-primary)]" />
                    <div className="flex-1 min-w-0">
                      <p className="text-sm">
                        <span className="font-medium">{a.user_name}</span>{" "}
                        <span className="text-[var(--color-text-secondary)]">
                          {actionLabel(a.action)}
                        </span>
                      </p>
                      <p className="text-xs text-[var(--color-text-muted)]">
                        {formatRelative(a.created_at)}
                      </p>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <p className="py-4 text-center text-sm text-[var(--color-text-muted)]">
                {t("common.label.noRecentActivity")}
              </p>
            )}
          </Card>

          {/* Sync Status */}
          <SyncCard />
        </div>
      </div>
    </div>
  );
}

function SyncCard() {
  const t = useT();
  const navigate = useNavigate();
  // Subscribes to a primitive key, NOT the pairs array. `status.pairs` is a
  // new array identity on every 2 Hz status tick (it is structured-cloned
  // over IPC), so `useSyncPairs()` re-rendered this card twice a second even
  // though the four fields it shows - icon, folder name, workspace name,
  // status word - carry nothing that advances per tick (DSK-002). The
  // sidebar's fix did not reach here; a 64-minute soak did, with act 2 still
  // at ~59 commits per 30 s sample.
  //
  // Read off the store inside the memo rather than through a subscribing
  // hook: by the time a render triggered by this key runs, the store already
  // holds the matching pairs, and subscribing to the array here would put
  // back exactly the per-tick re-render the key exists to remove.
  const pairCardsKey = useSyncPairCardsKey();
  const pairs = useMemo(
    () => syncPairCards(useSyncStore.getState().status?.pairs ?? []),
    [pairCardsKey],
  );
  // "Root" on a workspace-root pair in the chosen language; other names as stored.
  const folderName = usePairFolderLabel(pairs);

  return (
    <Card
      title={t("common.label.sync")}
      action={
        <button
          onClick={() => navigate("/sync")}
          className="text-xs text-[var(--color-primary)] hover:underline"
        >
          {t("dashboard.action.manage")}
        </button>
      }
    >
      {pairs.length === 0 ? (
        <div className="flex flex-col items-center py-4">
          <FolderSync size={24} className="mb-2 text-[var(--color-text-muted)]" />
          <p className="text-xs text-[var(--color-text-muted)]">{t("dashboard.label.noSyncFoldersConfigured")}</p>
          <button
            onClick={() => navigate("/sync")}
            className="mt-2 text-xs font-medium text-[var(--color-primary)] hover:underline"
          >
            {t("dashboard.action.setUpSync")}
          </button>
        </div>
      ) : (
        <div className="space-y-2">
          {pairs.map((p) => {
            const icon =
              p.status === "syncing" ? <Loader2 size={14} className="animate-spin text-blue-500" /> :
              p.status === "error" ? <AlertCircle size={14} className="text-[var(--color-danger)]" /> :
              p.status === "needs-permission" ? <AlertCircle size={14} className="text-[var(--color-warning)]" /> :
              p.status === "paused" ? <Pause size={14} className="text-[var(--color-text-muted)]" /> :
              <CheckCircle2 size={14} className="text-[var(--color-primary)]" />;

            return (
              <div
                key={p.pairId}
                onClick={() => navigate("/sync")}
                className="flex items-center gap-2.5 rounded-lg px-3 py-2 cursor-pointer hover:bg-[var(--color-bg-secondary)] transition-colors"
              >
                {icon}
                <div className="flex-1 min-w-0">
                  <p className="truncate text-sm font-medium">{folderName(p)}</p>
                  <p className="truncate text-xs text-[var(--color-text-muted)]">{p.workspaceName}</p>
                </div>
                {/* A translated word keeps its own casing; only the raw status is
                    capitalized for display. */}
                {SYNC_STATUS_LABELS[p.status] ? (
                  <span className="text-xs text-[var(--color-text-muted)]">{t(SYNC_STATUS_LABELS[p.status])}</span>
                ) : (
                  <span className="text-xs capitalize text-[var(--color-text-muted)]">{p.status}</span>
                )}
              </div>
            );
          })}
        </div>
      )}
    </Card>
  );
}

function StatCard({
  icon,
  label,
  value,
  sub,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  sub: string;
}) {
  return (
    <div
      className="rounded-xl border p-5"
      style={{ borderColor: "var(--color-border)" }}
    >
      <div className="mb-3 text-[var(--color-text-muted)]">{icon}</div>
      <p className="text-2xl font-semibold">{value}</p>
      <p className="text-sm text-[var(--color-text-secondary)]">{label}</p>
      <p className="mt-1 text-xs text-[var(--color-text-muted)]">{sub}</p>
    </div>
  );
}

function Card({
  title,
  action,
  children,
}: {
  title: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div
      className="rounded-xl border p-5"
      style={{ borderColor: "var(--color-border)" }}
    >
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-sm font-semibold">{title}</h2>
        {action}
      </div>
      {children}
    </div>
  );
}
