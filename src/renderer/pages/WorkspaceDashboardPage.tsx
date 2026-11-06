import { useQuery } from "@tanstack/react-query";
import { ErrorPanel } from "@/components/ErrorPanel";
import { useNavigate } from "react-router-dom";
import { api } from "@/lib/api-client";
import { WorkspaceBadge } from "@/components/WorkspaceBadge";
import { useWorkspace } from "@/lib/workspace-context";
import { formatBytes } from "@/lib/format";
import { storagePercent as usagePercent } from "@/lib/storage-percent";
import {
  storageColor, stackedSegments, roleLabel, WS_SEGMENT_COLORS, SOURCE_DOT,
  type WorkspaceDashboardData, type OwnedWorkspace, type SharedWorkspace,
} from "@/lib/workspace-dashboard";
import { useT } from "@/lib/i18n";
import { richText } from "@/lib/rich-text";
import { fetchAccountAiSearch, type AccountAiWorkspace } from "@/lib/ai-search";
import { AiIndexDonut } from "@/components/workspaces/AiIndexDonut";
import { AiPoolMeters, FamilyPoolBadge } from "@/components/workspaces/AiPoolMeters";
import type { MessageKey } from "../../i18n/keys";

type AiRowState = "indexing" | "limit" | "platform";

const AI_STATE_KEY: Record<AiRowState, MessageKey> = {
  indexing: "billing.status.indexing",
  limit: "settings.status.pausedLimitReached",
  platform: "dashboard.status.pausedByDosya",
};

function aiRowState(ws: AccountAiWorkspace, poolPaused: boolean): AiRowState {
  if (poolPaused || ws.paused_reason === "platform") return "platform";
  return ws.paused_reason === "limit" ? "limit" : "indexing";
}

export function WorkspaceDashboardPage() {
  const t = useT();
  const navigate = useNavigate();
  const { workspaces, active, setActive } = useWorkspace();

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ["workspace-dashboard"],
    queryFn: () => api.get<{ ok: boolean } & WorkspaceDashboardData>("/api/workspace-dashboard"),
    staleTime: 60_000,
  });
  // AI search pool + per-workspace index counts (GET /api/me/ai-search), one
  // request for the card and every row. Optional: a failure or a plan without
  // AI search (limits null) hides every AI line.
  const { data: ai } = useQuery({
    queryKey: ["account-ai-search"],
    queryFn: fetchAccountAiSearch,
    staleTime: 60_000,
  });

  const openWorkspace = (id: string) => {
    const ws = workspaces.find((w) => w.id === id);
    if (ws && ws.id !== active?.id) setActive(ws);
    navigate("/dashboard");
  };

  if (isLoading) return <WorkspaceDashboardSkeleton />;
  if (isError || !data?.total) {
    return <ErrorPanel message={t("workspaces.error.couldnTLoadYourWorkspaceDashboard")} onRetry={() => refetch()} />;
  }

  const { total, sources, owned, shared } = data;
  const usage = usagePercent(total.used_bytes, total.limit_bytes);
  const pct = usage.pct;
  const segments = stackedSegments(owned, total.used_bytes);
  const aiPool = ai?.pool.limits ? ai.pool : null;
  const aiById = new Map((aiPool && ai ? ai.workspaces : []).map((w) => [w.id, w]));

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-semibold">{t("workspaces.heading.workspaceDashboard")}</h1>
        <p className="text-sm text-[var(--color-text-secondary)]">{t("workspaces.description.yourStorageAcrossEveryWorkspaceYouOwn")}</p>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[1fr_320px]">
        {/* Left column */}
        <div className="space-y-4">
          {/* Your storage */}
          <Card title={t("workspaces.tooltip.yourStorage")}>
            <div className="mb-3 flex items-end justify-between">
              <p className="text-sm text-[var(--color-text-muted)]">
                {richText(t, "workspaces.label.bytesUsed", {}, {
                  bytes: <span className="text-2xl font-semibold text-[var(--color-text)]">{formatBytes(total.used_bytes)}</span>,
                })}
              </p>
              <p className="text-sm text-[var(--color-text-secondary)]">
                {t("workspaces.description.freebytesFreeOfLimitBytes", {
                  freeBytes: formatBytes(total.free_bytes),
                  limitBytes: formatBytes(total.limit_bytes),
                })}
              </p>
            </div>
            {/* Stacked-by-workspace usage bar */}
            <div className="h-2.5 overflow-hidden rounded-full bg-[var(--color-bg-tertiary)]">
              <div className="flex h-full overflow-hidden" style={{ width: usage.barWidth }}>
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
            <p className="mt-1.5 text-xs text-[var(--color-text-muted)]">{t("workspaces.description.pctOfYourTotalSpaceUsed", { pct: usage.label })}</p>
          </Card>

          {/* Workspaces you own */}
          <Card title={t("workspaces.tooltip.workspacesYouOwn")}>
            {owned.length === 0 ? (
              <p className="py-5 text-center text-xs text-[var(--color-text-muted)]">{t("workspaces.label.youDonTOwnAnyWorkspacesYet")}</p>
            ) : (
              <div>
                {owned.map((ws, i) => {
                  const color = WS_SEGMENT_COLORS[i % WS_SEGMENT_COLORS.length];
                  // Recomputed from bytes, not the server's rounded share_pct:
                  // that integer is 0 for a few MB of 5 GB, which read as "empty".
                  const share = usagePercent(ws.used_bytes, total.limit_bytes);
                  return (
                    <button
                      key={ws.id}
                      type="button"
                      onClick={() => openWorkspace(ws.id)}
                      className="flex w-full items-center gap-3 rounded-md border-b px-1 py-2.5 text-start transition-colors last:border-b-0 hover:bg-[var(--color-bg-secondary)]"
                      style={{ borderColor: "var(--color-border)" }}
                    >
                      <div className="h-2 w-2 shrink-0 rounded-full" style={{ background: color }} />
                      <WsIcon ws={ws} size={32} />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-[13px] font-medium" title={ws.name}>{ws.name}</p>
                        <p className="text-[11px] text-[var(--color-text-muted)]">{t("workspaces.label.bytesUsed", { bytes: formatBytes(ws.used_bytes) })}</p>
                        {aiPool && <AiIndexLine ws={aiById.get(ws.id)} poolPaused={aiPool.paused} />}
                      </div>
                      <div className="w-28 shrink-0">
                        <div className="h-2 rounded-full bg-[var(--color-bg-tertiary)]">
                          <div className="h-2 rounded-full transition-all" style={{ width: share.barWidth, background: color }} />
                        </div>
                      </div>
                      <span className="w-10 shrink-0 text-end text-xs font-semibold">{share.label}%</span>
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
          <Card title={t("workspaces.tooltip.whereYourSpaceComesFrom")}>
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
              <span>{t("workspaces.label.total")}</span><span>{formatBytes(total.limit_bytes)}</span>
            </div>
          </Card>

          {/* AI search: the account's processing pool */}
          {aiPool && ai && (
            <div className="rounded-xl border p-5" style={{ borderColor: "var(--color-border)" }} data-testid="workspaces-ai-search">
              <div className="mb-4 flex items-center justify-between gap-2">
                <h2 className="text-sm font-semibold">{t("settings.label.aiSearch")}</h2>
                <FamilyPoolBadge pool={aiPool} />
              </div>
              <div className="space-y-5">
                <AiIndexDonut workspaces={ai.workspaces} />
                <AiPoolMeters pool={aiPool} />
              </div>
            </div>
          )}

          {/* Shared with you */}
          {shared.length > 0 && (
            <Card title={t("workspaces.tooltip.sharedWithYou")}>
              <p className="mb-2 text-[11px] text-[var(--color-text-muted)]">{t("workspaces.description.theseUseTheOwnerSStorageNotYours")}</p>
              <div>
                {shared.map((ws) => (
                  <button
                    key={ws.id}
                    type="button"
                    onClick={() => openWorkspace(ws.id)}
                    className="flex w-full items-center gap-2.5 rounded-md px-1 py-2 text-start transition-colors hover:bg-[var(--color-bg-secondary)]"
                  >
                    <WsIcon ws={ws} size={28} />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-[13px] font-medium" title={ws.name}>{ws.name}</p>
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

/** One owned workspace's AI index line under its storage line; nothing when the response does not list it. */
function AiIndexLine({ ws, poolPaused }: { ws: AccountAiWorkspace | undefined; poolPaused: boolean }) {
  const t = useT();
  if (!ws) return null;
  if (!ws.enabled) {
    return <p className="text-[11px] text-[var(--color-text-muted)]" data-testid="ws-ai-line">{t("workspaces.status.aiSearchOff")}</p>;
  }
  const state = aiRowState(ws, poolPaused);
  return (
    <p className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[11px] text-[var(--color-text-muted)]" data-testid="ws-ai-line">
      <span>{t("workspaces.label.aiIndexImagesDocuments", { images: ws.images, documents: ws.documents })}</span>
      <span
        data-testid="ws-ai-state"
        className="rounded-full border px-1.5 text-[10px] leading-4"
        style={state === "indexing"
          ? { borderColor: "var(--color-border)" }
          : {
            borderColor: "color-mix(in oklab, var(--color-warning) 60%, transparent)",
            background: "color-mix(in oklab, var(--color-warning) 12%, transparent)",
            color: "var(--color-text)",
          }}
      >{t(AI_STATE_KEY[state])}</span>
    </p>
  );
}

/** Workspace icon chip - authed custom icon, else initials on the workspace colour. */
function WsIcon({ ws, size }: { ws: OwnedWorkspace | SharedWorkspace; size: number }) {
  return (
    <span style={{ width: size, height: size }} className="inline-flex shrink-0">
      <WorkspaceBadge ws={ws} className="h-full w-full rounded-md text-[11px] !font-bold !text-white" />
    </span>
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
