import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { api, apiBase } from "@/lib/api-client";
import { useWorkspace } from "@/lib/workspace-context";
import { formatBytes } from "@/lib/format";
import {
  storageColor, stackedSegments, roleLabel, WS_SEGMENT_COLORS, SOURCE_DOT,
  type WorkspaceDashboardData, type OwnedWorkspace, type SharedWorkspace,
} from "@/lib/workspace-dashboard";

export function WorkspaceDashboardPage() {
  const navigate = useNavigate();
  const { workspaces, active, setActive } = useWorkspace();

  const { data, isLoading, isError } = useQuery({
    queryKey: ["workspace-dashboard"],
    queryFn: () => api.get<{ ok: boolean } & WorkspaceDashboardData>("/api/workspace-dashboard"),
    staleTime: 60_000,
  });

  const openWorkspace = (id: string) => {
    const ws = workspaces.find((w) => w.id === id);
    if (ws && ws.id !== active?.id) setActive(ws);
    navigate("/dashboard");
  };

  if (isLoading) return <WorkspaceDashboardSkeleton />;
  if (isError || !data) {
    return (
      <div className="py-10 text-center text-sm text-[var(--color-text-secondary)]">
        Failed to load your workspace dashboard.
      </div>
    );
  }

  const { total, sources, owned, shared } = data;
  const pct = total.limit_bytes > 0 ? Math.min(100, Math.round((total.used_bytes / total.limit_bytes) * 100)) : 0;
  const segments = stackedSegments(owned, total.used_bytes);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-semibold">Workspace dashboard</h1>
        <p className="text-sm text-[var(--color-text-secondary)]">Your storage across every workspace you own</p>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[1fr_320px]">
        {/* Left column */}
        <div className="space-y-4">
          {/* Your storage */}
          <Card title="Your storage">
            <div className="mb-3 flex items-end justify-between">
              <p className="text-2xl font-semibold">
                {formatBytes(total.used_bytes)} <span className="text-sm font-normal text-[var(--color-text-muted)]">used</span>
              </p>
              <p className="text-sm text-[var(--color-text-secondary)]">
                {formatBytes(total.free_bytes)} free of {formatBytes(total.limit_bytes)}
              </p>
            </div>
            {/* Stacked-by-workspace usage bar */}
            <div className="h-2.5 overflow-hidden rounded-full bg-[var(--color-bg-tertiary)]">
              <div className="flex h-full overflow-hidden" style={{ width: `${pct}%` }}>
                {segments.length === 0 ? (
                  <div className="h-full w-full" style={{ background: storageColor(pct) }} />
                ) : segments.map((seg) => {
                  const ownedIdx = owned.findIndex((w) => w.id === seg.id);
                  const color = WS_SEGMENT_COLORS[ownedIdx % WS_SEGMENT_COLORS.length];
                  return (
                    <div
                      key={seg.id}
                      className="h-full"
                      style={{ width: `${seg.widthPct}%`, background: color }}
                      title={`${seg.name}: ${formatBytes(owned.find((w) => w.id === seg.id)?.used_bytes ?? 0)}`}
                    />
                  );
                })}
              </div>
            </div>
            <p className="mt-1.5 text-xs text-[var(--color-text-muted)]">{pct}% of your total space used</p>
          </Card>

          {/* Workspaces you own */}
          <Card title="Workspaces you own">
            {owned.length === 0 ? (
              <p className="py-5 text-center text-xs text-[var(--color-text-muted)]">You don't own any workspaces yet.</p>
            ) : (
              <div>
                {owned.map((ws, i) => {
                  const color = WS_SEGMENT_COLORS[i % WS_SEGMENT_COLORS.length];
                  return (
                    <button
                      key={ws.id}
                      type="button"
                      onClick={() => openWorkspace(ws.id)}
                      className="flex w-full items-center gap-3 rounded-md border-b px-1 py-2.5 text-left transition-colors last:border-b-0 hover:bg-[var(--color-bg-secondary)]"
                      style={{ borderColor: "var(--color-border)" }}
                    >
                      <div className="h-2 w-2 shrink-0 rounded-full" style={{ background: color }} />
                      <WsIcon ws={ws} size={32} />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-[13px] font-medium">{ws.name}</p>
                        <p className="text-[11px] text-[var(--color-text-muted)]">{formatBytes(ws.used_bytes)} used</p>
                      </div>
                      <div className="w-28 shrink-0">
                        <div className="h-2 rounded-full bg-[var(--color-bg-tertiary)]">
                          <div className="h-2 rounded-full transition-all" style={{ width: `${Math.max(Math.min(ws.share_pct, 100), 1)}%`, background: color }} />
                        </div>
                      </div>
                      <span className="w-10 shrink-0 text-right text-xs font-semibold">{ws.share_pct}%</span>
                    </button>
                  );
                })}
              </div>
            )}
          </Card>
        </div>

        {/* Right column */}
        <div className="space-y-4">
          {/* Where your space comes from */}
          <Card title="Where your space comes from">
            <div className="space-y-2">
              {sources.map((src, i) => (
                <div key={`${src.kind}-${i}`} className="flex items-center gap-2">
                  <div className="h-2 w-2 shrink-0 rounded-full" style={{ background: SOURCE_DOT[src.kind] ?? "#6b7280" }} />
                  <span className="flex-1 truncate text-xs">{src.label}</span>
                  <span className="text-[11px] font-medium text-[var(--color-text-muted)]">{formatBytes(src.bytes)}</span>
                </div>
              ))}
            </div>
            <div className="mt-3 flex justify-between border-t pt-2 text-xs font-semibold" style={{ borderColor: "var(--color-border)" }}>
              <span>Total</span><span>{formatBytes(total.limit_bytes)}</span>
            </div>
          </Card>

          {/* Shared with you */}
          {shared.length > 0 && (
            <Card title="Shared with you">
              <p className="mb-2 text-[11px] text-[var(--color-text-muted)]">These use the owner's storage, not yours.</p>
              <div>
                {shared.map((ws) => (
                  <button
                    key={ws.id}
                    type="button"
                    onClick={() => openWorkspace(ws.id)}
                    className="flex w-full items-center gap-2.5 rounded-md px-1 py-2 text-left transition-colors hover:bg-[var(--color-bg-secondary)]"
                  >
                    <WsIcon ws={ws} size={28} />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-[13px] font-medium">{ws.name}</p>
                      <p className="truncate text-[11px] text-[var(--color-text-muted)]">{ws.owner_name}</p>
                    </div>
                    <span className="rounded-full border px-2 py-0.5 text-[10px] text-[var(--color-text-secondary)]" style={{ borderColor: "var(--color-border)" }}>
                      {roleLabel(ws.role_id)}
                    </span>
                  </button>
                ))}
              </div>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}

/** Workspace icon chip - authed custom icon, else initials on the workspace colour. */
function WsIcon({ ws, size }: { ws: OwnedWorkspace | SharedWorkspace; size: number }) {
  return (
    <div
      className="flex shrink-0 items-center justify-center overflow-hidden rounded-md text-[11px] font-bold text-white"
      style={{ width: size, height: size, background: ws.icon_image_url ? "var(--color-bg-tertiary)" : ws.icon_color }}
    >
      {ws.icon_image_url
        ? <img src={`${apiBase()}/api/workspaces/${ws.id}/icon`} alt="" className="h-full w-full object-cover" />
        : ws.icon_initials}
    </div>
  );
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border p-5" style={{ borderColor: "var(--color-border)" }}>
      <h2 className="mb-4 text-sm font-semibold">{title}</h2>
      {children}
    </div>
  );
}

function WorkspaceDashboardSkeleton() {
  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <div className="h-7 w-56 animate-pulse rounded bg-[var(--color-bg-tertiary)]" />
        <div className="h-4 w-72 animate-pulse rounded bg-[var(--color-bg-tertiary)]" />
      </div>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[1fr_320px]">
        <div className="space-y-4">
          <div className="h-28 animate-pulse rounded-xl bg-[var(--color-bg-tertiary)]" />
          <div className="h-48 animate-pulse rounded-xl bg-[var(--color-bg-tertiary)]" />
        </div>
        <div className="space-y-4">
          <div className="h-40 animate-pulse rounded-xl bg-[var(--color-bg-tertiary)]" />
        </div>
      </div>
    </div>
  );
}
