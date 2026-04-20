import { useEffect, useState } from "react";
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
import { useNavigate } from "react-router-dom";
import { api } from "@/lib/api-client";
import { useWorkspace } from "@/lib/workspace-context";
import { formatBytes, formatRelative, fileIcon } from "@/lib/format";

interface DashboardData {
  ok: boolean;
  user_name: string;
  stats: {
    total_files: number;
    files_this_week: number;
    shared_externally: number;
    total_bytes: number;
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
        <h1 className="text-2xl font-semibold">Dashboard</h1>
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
  const storagePercent = stats.storage_cap_bytes
    ? Math.round((stats.total_bytes / stats.storage_cap_bytes) * 100)
    : 0;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">
            Welcome back{data.user_name ? `, ${data.user_name}` : ""}
          </h1>
          <p className="text-sm text-[var(--color-text-secondary)]">
            Here's what's happening in your workspace
          </p>
        </div>
        <button
          onClick={() => navigate("/upload")}
          className="flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-medium text-white"
          style={{ background: "var(--color-primary)" }}
        >
          <Upload size={16} />
          Upload files
        </button>
      </div>

      {/* Stats Grid */}
      <div className="grid grid-cols-3 gap-4">
        <StatCard
          icon={<FileText size={20} />}
          label="Total files"
          value={stats.total_files.toLocaleString()}
          sub={`${stats.files_this_week} added this week`}
        />
        <StatCard
          icon={<Share2 size={20} />}
          label="Shared externally"
          value={stats.shared_externally.toLocaleString()}
          sub="Active share links"
        />
        <StatCard
          icon={<HardDrive size={20} />}
          label="Storage used"
          value={formatBytes(stats.total_bytes)}
          sub={`${storagePercent}% of ${formatBytes(stats.storage_cap_bytes)}`}
        />
      </div>

      {/* Two-Column Layout */}
      <div className="grid grid-cols-5 gap-4">
        {/* Left Column */}
        <div className="col-span-3 space-y-4">
          {/* Storage Breakdown */}
          {data.storage_breakdown.length > 0 && (
            <Card title="Storage breakdown">
              {/* Total usage summary */}
              <div className="mb-4 flex items-center justify-between">
                <div>
                  <p className="text-lg font-semibold">
                    {formatBytes(stats.total_bytes)}{" "}
                    <span className="text-sm font-normal text-[var(--color-text-muted)]">used</span>
                  </p>
                  <p className="text-xs text-[var(--color-text-muted)]">
                    of {formatBytes(stats.storage_cap_bytes)} total
                  </p>
                </div>
                <div className="text-right">
                  <p className="text-2xl font-bold">{storagePercent}%</p>
                </div>
              </div>
              {/* Overall progress bar */}
              <div className="mb-4 h-2.5 rounded-full bg-[var(--color-bg-tertiary)]">
                <div
                  className="h-2.5 rounded-full transition-all"
                  style={{
                    width: `${Math.max(storagePercent, 1)}%`,
                    background: storagePercent > 90 ? "var(--color-danger)" : "var(--color-primary)",
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
                      <span className="w-20 text-right text-sm text-[var(--color-text-secondary)]">
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
            title="Recent files"
            action={
              <button
                onClick={() => navigate("/files")}
                className="text-xs text-[var(--color-primary)] hover:underline"
              >
                View all
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
                    <span className="flex-1 truncate text-sm">{f.name}</span>
                    <span className="text-xs text-[var(--color-text-muted)]">
                      {formatBytes(f.size_bytes)}
                    </span>
                    <span className="text-xs text-[var(--color-text-muted)]">
                      {formatRelative(f.created_at)}
                    </span>
                  </div>
                ))}
              </div>
            ) : (
              <p className="py-4 text-center text-sm text-[var(--color-text-muted)]">
                No files yet
              </p>
            )}
          </Card>

          {/* Team Usage */}
          {data.team_stats.length > 1 && (
            <Card title="Team usage">
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
                      <span className="w-28 truncate text-sm">{m.name}</span>
                      <div className="flex-1">
                        <div className="h-2 rounded-full bg-[var(--color-bg-tertiary)]">
                          <div
                            className="h-2 rounded-full bg-[var(--color-primary)] transition-all"
                            style={{ width: `${Math.max(pct, 1)}%` }}
                          />
                        </div>
                      </div>
                      <span className="w-20 text-right text-xs text-[var(--color-text-secondary)]">
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
          {/* Activity */}
          <Card
            title="Activity"
            action={
              <button
                onClick={() => navigate("/activity")}
                className="text-xs text-[var(--color-primary)] hover:underline"
              >
                All
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
                          {a.action}
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
                No recent activity
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
  const navigate = useNavigate();
  const [pairs, setPairs] = useState<any[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [globalPaused, setGlobalPaused] = useState(false);

  useEffect(() => {
    window.electronAPI.getSyncStatus?.()
      .then((s: any) => {
        setPairs(s?.pairs ?? []);
        setGlobalPaused(s?.globalPaused ?? false);
        setLoaded(true);
      })
      .catch(() => setLoaded(true));
  }, []);
  const syncing = pairs.filter((p) => p.status === "syncing").length;
  const errors = pairs.filter((p) => p.status === "error").length;
  const paused = globalPaused;

  return (
    <Card
      title="Sync"
      action={
        <button
          onClick={() => navigate("/sync")}
          className="text-xs text-[var(--color-primary)] hover:underline"
        >
          Manage
        </button>
      }
    >
      {pairs.length === 0 ? (
        <div className="flex flex-col items-center py-4">
          <FolderSync size={24} className="mb-2 text-[var(--color-text-muted)]" />
          <p className="text-xs text-[var(--color-text-muted)]">No sync folders configured</p>
          <button
            onClick={() => navigate("/sync")}
            className="mt-2 text-xs font-medium text-[var(--color-primary)] hover:underline"
          >
            Set up sync
          </button>
        </div>
      ) : (
        <div className="space-y-2">
          {pairs.map((p) => {
            const icon =
              p.status === "syncing" ? <Loader2 size={14} className="animate-spin text-blue-500" /> :
              p.status === "error" ? <AlertCircle size={14} className="text-[var(--color-danger)]" /> :
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
                  <p className="truncate text-sm font-medium">{p.remoteFolderName}</p>
                  <p className="truncate text-xs text-[var(--color-text-muted)]">{p.workspaceName}</p>
                </div>
                <span className="text-xs capitalize text-[var(--color-text-muted)]">{p.status}</span>
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
