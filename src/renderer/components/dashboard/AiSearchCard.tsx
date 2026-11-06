// apps/desktop/src/renderer/components/dashboard/AiSearchCard.tsx
//
// Ported from apps/web/src/components/dashboard/ai-search-card.tsx - keep the
// two in step.
//
// The workspace dashboard's AI search card: this workspace's indexing status.
// Settings > AI search holds only the controls.
//
// GET /api/workspaces/:id/ai-search (any member), through the same query key
// as the Settings tab, so a toggle there shows here without a reload. Hidden
// while loading, on failure, and when the owner's plan has no AI search
// (`status.limits` null).
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { aiSearchKey, fetchWorkspaceAiSearch, pauseReason } from "@/lib/ai-search";
import { intlLocale } from "@/lib/locale-state";
import { useT } from "@/lib/i18n";

const SETTINGS_LINK = "/settings?tab=ai-search";

const formatCount = (n: number) => n.toLocaleString(intlLocale("en"));

export function AiSearchCard({ wsId }: { wsId: string }) {
  const t = useT();
  const navigate = useNavigate();
  // Keyed by workspace, so a switch never shows the previous workspace's numbers.
  const { data } = useQuery({
    queryKey: aiSearchKey(wsId),
    queryFn: () => fetchWorkspaceAiSearch(wsId),
    enabled: !!wsId,
  });

  if (!data || !data.status.limits) return null;
  const { settings, status, can_edit: canEdit } = data;
  const limits = status.limits!;
  const reason = settings.enabled ? pauseReason(status) : null;

  return (
    <div className="rounded-xl border p-5" style={{ borderColor: "var(--color-border)" }} data-testid="dashboard-ai-search">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-sm font-semibold">{t("settings.label.aiSearch")}</h2>
        {settings.enabled && (
          <button
            type="button"
            onClick={() => navigate(SETTINGS_LINK)}
            className="text-xs text-[var(--color-primary)] hover:underline"
          >{t("dashboard.action.manage")}</button>
        )}
      </div>
      {!settings.enabled ? (
        <div className="space-y-3">
          <p className="text-xs text-[var(--color-text-muted)]">{t("dashboard.description.searchInsideDocumentsAndPhotosNotJustFileNames")}</p>
          {canEdit && (
            <button
              type="button"
              onClick={() => navigate(SETTINGS_LINK)}
              className="inline-flex h-7 items-center rounded-lg border px-2.5 text-xs font-medium hover:bg-[var(--color-bg-secondary)]"
              style={{ borderColor: "var(--color-border)" }}
            >{t("dashboard.action.turnOn")}</button>
          )}
        </div>
      ) : (
        <div className="space-y-4">
          {reason && (
            <p
              role="status"
              className="rounded-lg border px-3 py-2 text-xs"
              style={{
                borderColor: "color-mix(in oklab, var(--color-warning) 50%, transparent)",
                background: "color-mix(in oklab, var(--color-warning) 10%, transparent)",
              }}
            >
              {reason === "maintenance" ? t("dashboard.status.pausedByDosya") : t("settings.status.pausedLimitReached")}
            </p>
          )}
          <dl className="grid grid-cols-2 gap-3">
            <div>
              <dt className="text-[11px] text-[var(--color-text-muted)]">{t("settings.label.indexed")}</dt>
              <dd className="text-lg font-semibold tracking-tight tabular-nums">{formatCount(status.indexed)}</dd>
            </div>
            <div>
              <dt className="text-[11px] text-[var(--color-text-muted)]">{t("settings.label.waiting")}</dt>
              <dd className="text-lg font-semibold tracking-tight tabular-nums">{formatCount(status.pending)}</dd>
            </div>
          </dl>
          <div className="space-y-3">
            <Budget label={t("common.label.images")} used={status.images} max={limits.imagesMax} />
            <Budget label={t("common.label.documents")} used={status.documents} max={limits.documentsMax} />
          </div>
        </div>
      )}
    </div>
  );
}

function Budget({ label, used, max }: { label: string; used: number; max: number }) {
  const t = useT();
  const pct = max > 0 ? Math.min(100, Math.round((used / max) * 100)) : 0;
  return (
    <div>
      <div className="mb-1 flex items-center justify-between text-xs">
        <span className="text-[var(--color-text-secondary)]">{label}</span>
        <span className="text-[11px] tabular-nums text-[var(--color-text-muted)]">{t("settings.label.countOfMax", { count: formatCount(used), max: formatCount(max) })}</span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-[var(--color-bg-tertiary)]" role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={max} aria-valuenow={Math.min(used, max)}>
        <div
          className="h-full rounded-full"
          style={{ width: `${pct}%`, background: pct >= 100 ? "var(--color-warning)" : "var(--color-primary)" }}
        />
      </div>
    </div>
  );
}
