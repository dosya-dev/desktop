// apps/desktop/src/renderer/components/workspaces/AiIndexDonut.tsx
//
// Ported from apps/web/src/components/workspaces/ai-index-donut.tsx - keep the
// two in step.
//
// AI index by workspace: a hollow ring on the account workspace dashboard's AI
// search card, one slice per workspace sized by its indexed items (images +
// documents), with a legend and a hover / focus tooltip. The per-workspace AI
// lines in "Workspaces you own" are its table view. Hand-rolled SVG arcs: one
// path per slice, butt ends, a 2 px gap between neighbours.
//
// Accessibility: the svg is a labelled group ("AI index by workspace: ...")
// and every slice is its own focusable img with a full name, so a screen
// reader announces each slice as it takes focus. Escape closes the tooltip.
//
// Theme: the desktop's dark mode is the `.dark` class on <html> (lib/theme.ts),
// not a media query, so the dark fill is picked with the `[.dark_&]:` variant.
import { useEffect, useMemo, useState, type CSSProperties, type FocusEvent } from "react";
import { useDir, useT } from "@/lib/i18n";
import { intlLocale } from "@/lib/locale-state";
import type { AccountAiWorkspace } from "@/lib/ai-search";
import { RING, buildSlices, donutDirection, formatShare, paintedArc, sliceColor, type DonutSlice } from "./ai-index-donut";

const { size: SIZE, stroke: STROKE, hoverStroke: HOVER_STROKE, r: R, c: C } = RING;
/** The keyboard focus halo: a wider ring-coloured stroke under the focused slice. */
const HALO_STROKE = HOVER_STROKE + 6;

/** Both theme fills as CSS variables; the stroke / background classes pick one per theme. */
function swatchVars(slot: number): CSSProperties {
  const c = sliceColor(slot);
  return { "--slice-l": c.light, "--slice-d": c.dark } as CSSProperties;
}

function isFocusVisible(el: Element): boolean {
  try { return el.matches(":focus-visible"); } catch { return true; }
}

const formatCount = (n: number) => n.toLocaleString(intlLocale("en"));
const formatList = (items: string[], opts: Intl.ListFormatOptions = { type: "unit", style: "short" }) =>
  new Intl.ListFormat(intlLocale("en"), opts).format(items);

export function AiIndexDonut({ workspaces }: { workspaces: AccountAiWorkspace[] }) {
  const t = useT();
  const dir = useDir();
  const { sweep, arcFlag } = donutDirection(dir);
  const { slices, total } = useMemo(() => buildSlices(workspaces), [workspaces]);
  const [active, setActive] = useState<string | null>(null);
  const [focusRing, setFocusRing] = useState<string | null>(null);

  // Escape closes the tooltip whether it came from focus or from the pointer.
  useEffect(() => {
    if (active === null) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setActive(null); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [active]);

  const labelOf = (s: DonutSlice) => s.name ?? t("workspaces.label.otherWorkspaces");
  const lines = (s: DonutSlice) => ({
    images: t("workspaces.label.imagesCount", { count: s.images }),
    documents: t("workspaces.label.documentsCount", { count: s.documents }),
    share: t("workspaces.label.shareOfTheAiIndex", { pct: formatShare(s.share) }),
  });
  const sliceName = (s: DonutSlice) => { const l = lines(s); return formatList([labelOf(s), l.images, l.documents, l.share]); };

  const point = (a: number) => ({ x: C + sweep * R * Math.sin(a), y: C - R * Math.cos(a) });
  const arcPath = (s: DonutSlice) => {
    const { from, to } = paintedArc(s, slices.length);
    const p0 = point(from);
    const p1 = point(to);
    const large = to - from > Math.PI ? 1 : 0;
    return `M ${p0.x.toFixed(3)} ${p0.y.toFixed(3)} A ${R} ${R} 0 ${large} ${arcFlag} ${p1.x.toFixed(3)} ${p1.y.toFixed(3)}`;
  };

  const summary = formatList(slices.map((s) => formatList([labelOf(s), formatShare(s.share)], { type: "unit", style: "narrow" })));
  const tipSlice = slices.find((s) => s.key === active) ?? null;
  const haloSlice = slices.find((s) => s.key === focusRing) ?? null;

  return (
    <div className="flex items-center gap-4" data-testid="ai-index-donut">
      <div className="relative shrink-0" style={{ width: SIZE, height: SIZE }}>
        {total === 0 ? (
          <svg role="img" aria-label={t("workspaces.status.nothingIndexedYet")} width={SIZE} height={SIZE} viewBox={`0 0 ${SIZE} ${SIZE}`} className="block">
            <circle cx={C} cy={C} r={R} fill="none" strokeWidth={STROKE} className="stroke-[var(--color-bg-tertiary)]" data-testid="ai-donut-empty-ring" />
          </svg>
        ) : (
          <svg role="group" aria-label={t("workspaces.accessibility.aiIndexByWorkspace", { summary })} width={SIZE} height={SIZE} viewBox={`0 0 ${SIZE} ${SIZE}`} className="block overflow-visible">
            {haloSlice && (slices.length === 1
              ? <circle cx={C} cy={C} r={R} fill="none" strokeWidth={HALO_STROKE} className="stroke-(--ring)" data-testid="ai-donut-focus-ring" />
              : <path d={arcPath(haloSlice)} fill="none" strokeWidth={HALO_STROKE} className="stroke-(--ring)" data-testid="ai-donut-focus-ring" />)}
            {slices.map((s) => {
              const common = {
                role: "img",
                "aria-label": sliceName(s),
                tabIndex: 0,
                fill: "none",
                strokeWidth: active === s.key ? HOVER_STROKE : STROKE,
                className: "stroke-(--slice-l) [.dark_&]:stroke-(--slice-d) outline-none transition-[stroke-width] duration-150",
                style: swatchVars(s.slot),
                "data-testid": "ai-donut-slice",
                "data-key": s.key,
                "data-share": s.share.toFixed(4),
                "data-sweep": (s.a1 - s.a0).toFixed(6),
                onMouseEnter: () => setActive(s.key),
                onMouseLeave: () => setActive((k) => (k === s.key ? null : k)),
                onFocus: (e: FocusEvent<SVGElement>) => { setActive(s.key); if (isFocusVisible(e.currentTarget)) setFocusRing(s.key); },
                onBlur: () => { setActive((k) => (k === s.key ? null : k)); setFocusRing((k) => (k === s.key ? null : k)); },
              };
              if (slices.length === 1) return <circle key={s.key} {...common} cx={C} cy={C} r={R} />;
              return <path key={s.key} {...common} d={arcPath(s)} />;
            })}
          </svg>
        )}
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center px-6 text-center">
          {total > 0 ? (
            <>
              <span className="font-mono text-2xl font-semibold leading-none tabular-nums" data-testid="ai-donut-total">{formatCount(total)}</span>
              <span className="mt-1 text-[11px] text-[var(--color-text-muted)]">{t("workspaces.label.indexedCaption")}</span>
            </>
          ) : (
            <span className="text-[11px] text-[var(--color-text-muted)]" data-testid="ai-donut-empty">{t("workspaces.status.nothingIndexedYet")}</span>
          )}
        </div>
        {tipSlice && (
          // Always under the ring, from its inline-start edge: never over the card header, and at
          // 220 px never wider than the card's content box.
          <div
            role="tooltip"
            data-testid="ai-donut-tooltip"
            className="pointer-events-none absolute z-20 w-max max-w-[220px] rounded-lg border bg-[var(--color-bg)] px-3 py-2 text-xs shadow-sm"
            style={{ insetInlineStart: 0, top: SIZE + 6, borderColor: "var(--color-border)" }}
          >
            <p className="mb-1 flex min-w-0 items-center gap-1.5 font-medium">
              <span aria-hidden="true" className="size-2 shrink-0 rounded-[2px] bg-(--slice-l) [.dark_&]:bg-(--slice-d)" style={swatchVars(tipSlice.slot)} />
              <span className="min-w-0 truncate" data-testid="ai-donut-tooltip-name">{labelOf(tipSlice)}</span>
            </p>
            <p className="text-[var(--color-text-muted)]">{lines(tipSlice).images}</p>
            <p className="text-[var(--color-text-muted)]">{lines(tipSlice).documents}</p>
            <p className="mt-1 font-mono font-medium text-[var(--color-text)]">{lines(tipSlice).share}</p>
          </div>
        )}
      </div>
      {total > 0 && (
        <ul className="flex min-w-0 flex-1 flex-col gap-1.5" data-testid="ai-donut-legend">
          {slices.map((s) => (
            <li
              key={s.key}
              data-testid="ai-donut-legend-row"
              className={`flex items-center gap-2 rounded-md px-1 py-0.5 text-xs transition-colors ${active === s.key ? "bg-[var(--color-bg-secondary)]" : ""}`}
              onMouseEnter={() => setActive(s.key)}
              onMouseLeave={() => setActive((k) => (k === s.key ? null : k))}
            >
              <span aria-hidden="true" className="size-2 shrink-0 rounded-full bg-(--slice-l) [.dark_&]:bg-(--slice-d)" style={swatchVars(s.slot)} />
              <span className="min-w-0 flex-1 truncate" title={labelOf(s)}>{labelOf(s)}</span>
              <span className="shrink-0 font-mono tabular-nums text-[var(--color-text-muted)]">{formatCount(s.value)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
