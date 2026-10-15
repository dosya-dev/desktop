// apps/desktop/src/renderer/components/family/FamilyUsage.tsx
import { SWATCHES } from "@/lib/palette";
import { formatBytes } from "@/lib/format";
import type { FamilyView } from "@/lib/family-api";

const RING_R = 84;
const RING_C = 2 * Math.PI * RING_R;

/** A family holds at most 16 people and SWATCHES has 7: past the list, people share the last swatch rather than cycling back to someone else's colour. */
function personColor(index: number, dark: boolean): string {
  const sw = SWATCHES[Math.min(index, SWATCHES.length - 1)];
  return dark ? sw.dark : sw.light;
}

/** The ring for the pool with one arc per person, and the same people ranked with bars. Totals only. */
export function FamilyUsage({ view }: { view: FamilyView }) {
  const rows = view.usage ?? [];
  const limit = Math.max(view.pool.limit_bytes, 1);
  const used = view.pool.used_bytes;
  const pct = Math.min(100, Math.round((used / limit) * 100));
  const dark = typeof document !== "undefined" && document.documentElement.classList.contains("dark");
  const arcs = rows.reduce<{ id: string; color: string; len: number; offset: number }[]>((acc, r, i) => {
    const offset = acc.length ? acc[acc.length - 1].offset + acc[acc.length - 1].len : 0;
    acc.push({ id: r.id, color: personColor(i, dark), len: (Math.min(r.used_bytes, limit) / limit) * RING_C, offset });
    return acc;
  }, []);
  return (
    <div className="flex items-center gap-8">
      <div className="relative h-[200px] w-[200px] shrink-0">
        <svg role="img" aria-label={`${pct} percent of the family pool used`} width="200" height="200" viewBox="0 0 200 200">
          <circle cx="100" cy="100" r={RING_R} fill="none" stroke="var(--color-bg-tertiary)" strokeWidth="18" />
          {arcs.filter((a) => a.len > 0).map((a) => (
            <circle key={a.id} cx="100" cy="100" r={RING_R} fill="none" stroke={a.color} strokeWidth="18"
              strokeDasharray={`${Math.max(0, a.len - 2)} ${RING_C}`} strokeDashoffset={-a.offset} transform="rotate(-90 100 100)" />
          ))}
        </svg>
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          <span className="font-mono text-3xl">{pct}%</span>
          <span className="text-xs text-[var(--color-text-muted)]">{view.pool.used_label} used</span>
        </div>
      </div>
      <ol className="flex min-w-0 flex-1 flex-col gap-3" aria-label="Storage used by each person">
        {rows.map((r, i) => (
          <li key={r.id} className="flex flex-col gap-1">
            <div className="flex items-center justify-between gap-3 text-sm">
              <span className="flex min-w-0 items-center gap-2">
                <span aria-hidden="true" className="inline-block h-2.5 w-2.5 shrink-0 rounded-[2px]" style={{ background: personColor(i, dark) }} />
                <span className="truncate">{r.is_you ? "You" : r.name}</span>
                {r.is_payer && <span className="shrink-0 text-[var(--color-text-muted)]">· pays the plan</span>}
              </span>
              <span className="shrink-0 font-mono">{r.used_label}</span>
            </div>
            <div className="h-1.5 rounded-full bg-[var(--color-bg-tertiary)]">
              <div className="h-1.5 rounded-full" style={{ width: `${Math.min(100, (r.used_bytes / limit) * 100)}%`, background: personColor(i, dark) }} />
            </div>
          </li>
        ))}
        <li className="flex items-center justify-between border-t pt-2 text-[13px] text-[var(--color-text-muted)]" style={{ borderColor: "var(--color-border)" }}>
          <span>Free in the pool</span>
          <span className="font-mono">{formatBytes(Math.max(0, limit - used))}</span>
        </li>
      </ol>
    </div>
  );
}
