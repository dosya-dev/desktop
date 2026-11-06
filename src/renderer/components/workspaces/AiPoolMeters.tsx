// apps/desktop/src/renderer/components/workspaces/AiPoolMeters.tsx
//
// Ported from apps/web/src/components/billing/ai-processing-card.tsx
// (AiPoolMeters + FamilyPoolBadge) - keep the two in step. The desktop has no
// Billing page of its own, so only the workspace dashboard renders these.
import { useT } from "@/lib/i18n";
import { intlLocale } from "@/lib/locale-state";
import type { AccountAiPool } from "@/lib/ai-search";

const formatCount = (n: number) => n.toLocaleString(intlLocale("en"));

/** "Family pool" badge when the units shown are the family payer's. */
export function FamilyPoolBadge({ pool }: { pool: AccountAiPool }) {
  const t = useT();
  if (!pool.payer_is_family) return null;
  return (
    <span
      data-testid="ai-family-pool"
      className="rounded-full border px-2 py-0.5 text-[10px] text-[var(--color-text-muted)]"
      style={{ borderColor: "var(--color-border)" }}
    >{t("billing.label.familyPool")}</span>
  );
}

/** The account pool: the platform pause, backfill remaining, and this month used with the reset date. */
export function AiPoolMeters({ pool }: { pool: AccountAiPool }) {
  const t = useT();
  return (
    <div className="space-y-4">
      {pool.paused && (
        <p role="status" className="text-xs font-medium text-[var(--color-warning)]">{t("dashboard.status.pausedByDosya")}</p>
      )}
      <dl className="space-y-4">
        <Meter label={t("billing.label.backfillRemaining")} used={pool.backfill_units_remaining} max={pool.backfill_units_total} />
        {pool.month_units_total > 0 && (
          <div>
            <Meter label={t("billing.label.thisMonth")} used={pool.month_units_total - pool.month_units_remaining} max={pool.month_units_total} />
            {pool.month_reset_at && (
              <p className="mt-1 text-xs text-[var(--color-text-muted)]">
                {t("billing.label.resetsDate", {
                  date: new Date(pool.month_reset_at * 1000).toLocaleDateString(intlLocale("en-US"), { month: "long", day: "numeric", year: "numeric" }),
                })}
              </p>
            )}
          </div>
        )}
      </dl>
    </div>
  );
}

function Meter({ label, used, max }: { label: string; used: number; max: number }) {
  const t = useT();
  const pct = max > 0 ? Math.min(100, Math.round((used / max) * 100)) : 0;
  return (
    <div>
      <div className="flex items-baseline justify-between gap-3">
        <dt className="text-xs font-medium">{label}</dt>
        <dd className="font-mono text-xs tabular-nums text-[var(--color-text-muted)]">{t("settings.label.countOfMax", { count: formatCount(used), max: formatCount(max) })}</dd>
      </div>
      <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-[var(--color-bg-tertiary)]" role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={max} aria-valuenow={Math.min(used, max)}>
        <div className="h-full rounded-full bg-[var(--color-primary)]" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}
