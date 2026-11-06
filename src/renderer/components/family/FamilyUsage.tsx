// apps/desktop/src/renderer/components/family/FamilyUsage.tsx
import { formatBytes } from "@/lib/format";
import { storagePercent as usagePercent } from "@/lib/storage-percent";
import type { FamilyView } from "@/lib/family-api";
import { useT } from "@/lib/i18n";
import { personColor, tint, type PoolSegment } from "./family-colors";
import { formatGigabytes, gigabyteFigure } from "./family-format";

const RING_R = 84;
const RING_C = 2 * Math.PI * RING_R;

/** One person in the pool: payer or active member, with one colour everywhere (avatar, bar, ring, legend). */
export type FamilyPerson = {
  key: string; name: string; isYou: boolean; isPayer: boolean; colorIndex: number;
  used: number; usedLabel: string; reserved: number | null;
};

/** Used storage and reserved-but-unused space, per person, as shares of the pool. */
export function poolSegments(people: FamilyPerson[], dark: boolean, heldTint: number): PoolSegment[] {
  return people.flatMap((p) => {
    const color = personColor(p.colorIndex, dark);
    const held = p.reserved ? Math.max(0, p.reserved - p.used) : 0;
    return [
      { key: `${p.key}:used`, bytes: p.used, color },
      ...(held > 0 ? [{ key: `${p.key}:held`, bytes: held, color: tint(color, heldTint) }] : []),
    ];
  });
}

/**
 * The Usage view: a ring for the pool with one arc per person (and a faded
 * arc for reserved space they have not used), and the same people ranked with
 * bars. Both are shares of the WHOLE pool. Totals only, never files.
 */
export function FamilyUsage({ view, people, dark }: { view: FamilyView; people: FamilyPerson[]; dark: boolean }) {
  const t = useT();
  const limit = Math.max(view.pool.limit_bytes, 1);
  const used = view.pool.used_bytes;
  const pct = usagePercent(used, view.pool.limit_bytes).label;
  const reservedTotal = view.pool.reserved_bytes ?? 0;
  const held = view.pool.held_bytes ?? 0;
  const free = view.pool.free_bytes ?? Math.max(0, limit - used);
  const width = (bytes: number) => `${Math.min(100, (Math.max(0, bytes) / limit) * 100)}%`;
  const segments = poolSegments(people, dark, 32);
  const lens = segments.map((s) => (Math.min(Math.max(s.bytes, 0), limit) / limit) * RING_C);
  const arcs = segments.map((s, i) => ({ key: s.key, color: s.color, len: lens[i], offset: lens.slice(0, i).reduce((a, l) => a + l, 0) }));
  const firstReserved = people.find((p) => p.reserved);
  return (
    <div className="flex flex-col gap-5">
      <div className="relative mx-auto h-[200px] w-[200px] shrink-0">
        <svg role="img" aria-label={t("family.accessibility.pctPercentOfTheFamilyPoolUsed", { pct })} width="200" height="200" viewBox="0 0 200 200">
          <circle cx="100" cy="100" r={RING_R} fill="none" stroke="var(--color-bg-tertiary)" strokeWidth="18" />
          {arcs.filter((a) => a.len > 0).map((a) => (
            <circle key={a.key} cx="100" cy="100" r={RING_R} fill="none" stroke={a.color} strokeWidth="18"
              strokeDasharray={`${Math.max(0, a.len - 2)} ${RING_C}`} strokeDashoffset={-a.offset} transform="rotate(-90 100 100)" />
          ))}
        </svg>
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-0.5 px-8 text-center">
          <span className="text-3xl font-semibold leading-none tracking-tight">{view.pool.used_label}</span>
          <span className="mt-1 text-xs text-[var(--color-text-muted)]">{t("family.label.ofLimitPct", { limitLabel: view.pool.limit_label, pct })}</span>
          {reservedTotal > 0 && <span className="text-xs text-[var(--color-text-muted)]">{t("family.label.sizeReserved", { size: formatGigabytes(reservedTotal) })}</span>}
        </div>
      </div>
      <ol data-slot="family-legend" className="flex min-w-0 flex-col gap-3" aria-label={t("family.accessibility.storageUsedByEachPerson")}>
        {people.map((p) => {
          const color = personColor(p.colorIndex, dark);
          const heldBytes = p.reserved ? Math.max(0, p.reserved - p.used) : 0;
          return (
            <li key={p.key} className="flex flex-col gap-1.5">
              <div className="flex items-center justify-between gap-3 text-sm">
                <span className="flex min-w-0 items-center gap-2">
                  <span aria-hidden="true" className="inline-block h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: color }} />
                  <span className="truncate">{p.isYou ? t("family.label.you") : p.name}</span>
                  {p.isPayer && <span className="shrink-0 text-xs text-[var(--color-text-muted)]">{t("family.label.paysThePlan")}</span>}
                  {p.reserved ? <span className="shrink-0 text-xs text-[var(--color-text-muted)]">{t("family.label.reservedTag")}</span> : null}
                </span>
                <span className="shrink-0 font-mono text-[13px]">
                  {p.reserved ? t("family.label.usedOfReserved", { used: gigabyteFigure(p.used), reserved: formatGigabytes(p.reserved) }) : p.usedLabel}
                </span>
              </div>
              <div className="flex h-1.5 overflow-hidden rounded-full bg-[var(--color-bg-tertiary)]">
                <span className="h-full" style={{ width: width(p.used), background: color }} />
                {heldBytes > 0 && <span className="h-full" style={{ width: width(heldBytes), background: tint(color, 32) }} />}
              </div>
            </li>
          );
        })}
        {reservedTotal > 0 ? (
          <>
            <li className="flex items-center justify-between gap-3 border-t pt-2.5 text-[13px] text-[var(--color-text-muted)]" style={{ borderColor: "var(--color-border)" }}>
              <span className="flex items-center gap-2">
                <span aria-hidden="true" className="inline-block h-2.5 w-2.5 rounded-full bg-[var(--color-bg-tertiary)] ring-1 ring-[var(--color-border)]" />
                {t("family.label.freeToShare")}
              </span>
              <span className="font-mono">{formatGigabytes(free)}</span>
            </li>
            <li className="flex items-center justify-between gap-3 text-[13px] text-[var(--color-text-muted)]">
              <span className="flex items-center gap-2">
                <span aria-hidden="true" className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: tint(personColor(firstReserved?.colorIndex ?? 1, dark), 32) }} />
                {t("family.label.heldForReservations")}
              </span>
              <span className="font-mono">{formatGigabytes(held)}</span>
            </li>
          </>
        ) : (
          <li className="flex items-center justify-between border-t pt-2.5 text-[13px] text-[var(--color-text-muted)]" style={{ borderColor: "var(--color-border)" }}>
            <span>{t("family.label.freeInThePool")}</span>
            <span className="font-mono">{formatBytes(free)}</span>
          </li>
        )}
      </ol>
    </div>
  );
}
