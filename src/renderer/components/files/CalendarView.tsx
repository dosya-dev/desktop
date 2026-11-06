// Ported from apps/web/src/components/calendar-viewer.tsx - keep in sync with the web copy.
// Links (Join call, maps, Add to Google Calendar) are plain target=_blank
// anchors: the main window's setWindowOpenHandler hands http(s) URLs to the
// system browser. Download event saves a Blob through an <a download>, which
// Electron answers with its own save dialog.
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  Bell, CalendarDays, CalendarPlus, ChevronLeft, ChevronRight, Clock, Download, Loader2, MapPin, Repeat, Search, StickyNote,
  Users, Video, Link as LinkIcon,
} from "lucide-react";
import {
  calendarSpan, dayKey, googleCalendarLink, occurrenceDays, singleEventIcs,
  type IcalCalendar, type IcalEvent, type IcalOccurrence, type IcalPartStat, type IcalPerson,
} from "@dosya-dev/shared/files/ical";
import { colorFor, initials } from "@/lib/file-type";
import { describeRule, formatDateWith, readCalendar, type ParsedCalendar } from "@/lib/calendar-read";
import { formatters, useT } from "@/lib/i18n";
import type { T } from "../../../i18n/translator";

/**
 * A .ics shown as a calendar instead of BEGIN:VEVENT text.
 *
 * Reads with the same parser as the web app and the share page (packages/
 * shared/src/files/ical.ts) so a Takeout calendar looks the same everywhere.
 * Read-only: the agenda opens at today, the month grid shows one month, and
 * the source is one tab away. A file with a single event (an invite, a
 * booking) is one card.
 */

/** Above this the file is not read in the window at all; the oversize card offers the download. */
export const CALENDAR_PREVIEW_MAX = 40 * 1024 * 1024;
const PAGE = 150;
const MAX_HITS = 300;
const DAY_MS = 86_400_000;

// ── Formatting ─────────────────────────────────────────────────────────────

const tzOf = (allDay: boolean) => (allDay ? "UTC" : undefined);
const fmtTime = (ms: number) => formatDateWith(new Date(ms), { hour: "numeric", minute: "2-digit" });
const fmtDay = (ms: number, allDay: boolean) => formatDateWith(new Date(ms), { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: tzOf(allDay) });
const fmtMonth = (y: number, m: number) => formatDateWith(new Date(Date.UTC(y, m - 1, 1)), { month: "long", year: "numeric", timeZone: "UTC" });
const fmtNumber = (n: number) => formatters().formatNumber(n);
const viewerZone = (() => {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined; } catch { return undefined; }
})();
const todayKey = () => dayKey(Date.now(), false, viewerZone);
const keyParts = (k: string) => k.split("-").map(Number) as [number, number, number];

function whenLines(o: IcalOccurrence, tr: T): string {
  if (o.allDay) {
    const last = Math.max(o.start, o.end - DAY_MS);
    return last > o.start ? `${fmtDay(o.start, true)} - ${fmtDay(last, true)}` : `${fmtDay(o.start, true)}, ${tr("common.label.allDay")}`;
  }
  if (o.end <= o.start) return `${fmtDay(o.start, false)}, ${fmtTime(o.start)}`;
  const same = dayKey(o.start, false, viewerZone) === dayKey(o.end - 1, false, viewerZone);
  return same
    ? `${fmtDay(o.start, false)}, ${fmtTime(o.start)} - ${fmtTime(o.end)}`
    : `${fmtDay(o.start, false)}, ${fmtTime(o.start)} - ${fmtDay(o.end, false)}, ${fmtTime(o.end)}`;
}

/** The time where the event was made, when that clock differs from the viewer's. */
function originalZone(o: IcalOccurrence, tr: T): string | null {
  const tz = o.event.start.tz;
  if (o.allDay || !tz || tz === viewerZone) return null;
  const f = (ms: number) => formatDateWith(new Date(ms), { hour: "numeric", minute: "2-digit", timeZone: tz });
  if (f(o.start) === fmtTime(o.start) && dayKey(o.start, false, tz) === dayKey(o.start, false, viewerZone)) return null;
  const time = o.end > o.start ? `${f(o.start)} - ${f(o.end)}` : f(o.start);
  return tr("common.description.timeInZone", { time, zone: tz.replace(/_/g, " ") });
}

function reminderText(min: number, tr: T): string {
  if (min > 0 && min % 1440 === 0) return tr("common.description.reminderDaysBefore", { count: min / 1440 });
  if (min > 0 && min % 60 === 0) return tr("common.description.reminderHoursBefore", { count: min / 60 });
  return tr("common.description.reminderMinutesBefore", { count: Math.max(0, min) });
}

function rsvpLabel(s: IcalPartStat | null, tr: T): string | null {
  switch (s) {
    case "accepted": return tr("common.status.rsvpGoing");
    case "tentative": return tr("common.status.rsvpMaybe");
    case "declined": return tr("common.status.rsvpDeclined");
    case "needs-action": return tr("common.status.rsvpNoReply");
    default: return null;
  }
}
const RSVP_DOT: Record<string, string> = { accepted: "bg-green-500", tentative: "bg-amber-500", declined: "bg-red-500", "needs-action": "bg-[var(--color-text-muted)]" };

const isCancelled = (ev: IcalEvent) => ev.status === "cancelled";
/** The organizer is usually on the guest list too; list them once. */
const sameAs = (p: IcalPerson, o: IcalPerson | null) =>
  !!o && ((!!p.email && p.email.toLowerCase() === o.email?.toLowerCase()) || (!p.email && !!p.name && p.name === o.name));
const safeHttp = (u: string | null) => {
  if (!u) return null;
  try { const url = new URL(u); return url.protocol === "https:" || url.protocol === "http:" ? url.href : null; } catch { return null; }
};

/** A stable colour per calendar, so a file of one calendar keeps one accent. */
const dotColor = (name: string) => colorFor(name || "calendar");

const BTN = "border border-[var(--color-border)] hover:bg-[var(--color-bg-secondary)]";
const PRIMARY = "bg-[var(--color-primary)] text-[var(--color-primary-fg)] hover:opacity-90";
const TODAY_PILL = "bg-[var(--color-text)] text-[var(--color-bg)]";

// ── Index helpers ──────────────────────────────────────────────────────────

/** First occurrence that has not ended before the viewer's day `key` begins. */
function firstOnOrAfter(occ: IcalOccurrence[], key: string): number {
  const [y, m, d] = keyParts(key);
  const floor = Date.UTC(y, m - 1, d) - 63 * DAY_MS;
  let lo = 0, hi = occ.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (occ[mid].start < floor) lo = mid + 1; else hi = mid; }
  for (let i = lo; i < occ.length; i++) {
    const o = occ[i];
    if (dayKey(Math.max(o.start, o.end - 1), o.allDay, viewerZone) >= key) return i;
  }
  return occ.length;
}

function matches(o: IcalOccurrence, q: string): boolean {
  const ev = o.event;
  return ev.summary.toLowerCase().includes(q) || (ev.location?.toLowerCase().includes(q) ?? false) || (ev.description?.toLowerCase().includes(q) ?? false);
}

// ── Component ──────────────────────────────────────────────────────────────

interface Props {
  file: { name: string; size_bytes: number };
  rawUrl: string;
  /** The text viewer, for the source tab and for a file that turns out not to be a calendar. */
  source: ReactNode;
  oversize: ReactNode;
}

export function CalendarView({ file, rawUrl, source, oversize }: Props) {
  const tr = useT();
  const toobig = file.size_bytes > CALENDAR_PREVIEW_MAX;
  const [loaded, setLoaded] = useState<{ url: string; text: string; parsed: ParsedCalendar } | { url: string; failed: true } | null>(null);

  useEffect(() => {
    if (toobig) return;
    let cancelled = false;
    fetch(rawUrl, { credentials: "include" })
      .then((r) => (r.ok ? r.text() : Promise.reject()))
      .then(async (text) => {
        const parsed = await readCalendar(text);
        if (!cancelled) setLoaded({ url: rawUrl, text, parsed });
      })
      .catch(() => { if (!cancelled) setLoaded({ url: rawUrl, failed: true }); });
    return () => { cancelled = true; };
  }, [rawUrl, toobig]);

  if (toobig) return <>{oversize}</>;
  if (!loaded || loaded.url !== rawUrl) {
    return (
      <div className="flex h-full w-full flex-col items-center justify-center gap-2 text-sm text-[var(--color-text-muted)]">
        <Loader2 size={24} className="animate-spin" />
        {tr("common.status.loadingCalendar")}
      </div>
    );
  }
  // Not a calendar after all (or unreadable): the text viewer shows what it is.
  if ("failed" in loaded || loaded.parsed.occ.length === 0) return <>{source}</>;

  const { cal, occ } = loaded.parsed;
  if (cal.events.length === 1 && !cal.events[0].rule) {
    return <SingleEvent occ={occ[0]} cal={cal} text={loaded.text} fileName={file.name} source={source} />;
  }
  return <CalendarBrowser key={rawUrl} cal={cal} occ={occ} text={loaded.text} fileName={file.name} source={source} />;
}

type View = "agenda" | "month" | "details" | "source";

function ViewTabs({ view, setView, views }: { view: View; setView: (v: View) => void; views: View[] }) {
  const tr = useT();
  const label = (v: View) => (v === "agenda" ? tr("common.label.agenda") : v === "month" ? tr("common.label.month") : v === "details" ? tr("common.action.details") : tr("common.label.sourceLowercase"));
  return (
    <div role="tablist" aria-label={tr("common.accessibility.calendarView")} className="ms-auto flex shrink-0 gap-0.5 rounded-lg bg-[var(--color-bg-secondary)] p-0.5">
      {views.map((v) => (
        <button
          key={v}
          role="tab"
          aria-selected={view === v}
          className={`h-6 rounded-md px-2.5 text-xs font-medium capitalize transition-colors ${view === v ? "bg-[var(--color-bg)] text-[var(--color-text)] shadow-sm" : "text-[var(--color-text-muted)] hover:text-[var(--color-text)]"}`}
          onClick={() => setView(v)}
        >
          {label(v)}
        </button>
      ))}
    </div>
  );
}

function CalendarBrowser({ cal, occ, text, fileName, source }: { cal: IcalCalendar; occ: IcalOccurrence[]; text: string; fileName: string; source: ReactNode }) {
  const tr = useT();
  const name = cal.name || fileName.replace(/\.(ics|ical|icalendar)$/i, "");
  const color = dotColor(name);
  const eventCount = useMemo(() => cal.events.filter((e) => !e.recurrenceId).length, [cal]);
  const repeating = useMemo(() => cal.events.filter((e) => e.rule).length, [cal]);
  const startIdx = useMemo(() => firstOnOrAfter(occ, todayKey()), [occ]);

  const [view, setView] = useState<View>("agenda");
  const [selected, setSelected] = useState<number | null>(null);
  const [query, setQuery] = useState("");
  const [q, setQ] = useState("");
  const pastOnly = startIdx >= occ.length;
  const [win, setWin] = useState(() => (pastOnly ? { lo: Math.max(0, occ.length - PAGE), hi: occ.length } : { lo: startIdx, hi: Math.min(occ.length, startIdx + PAGE) }));
  const [ym, setYm] = useState<[number, number]>(() => {
    const k = pastOnly ? dayKey(occ[occ.length - 1].start, occ[occ.length - 1].allDay, viewerZone) : todayKey();
    const [y, m] = keyParts(k);
    return [y, m];
  });
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const id = setTimeout(() => setQ(query.trim().toLowerCase()), 150);
    return () => clearTimeout(id);
  }, [query]);

  const years = useMemo(() => {
    const counts = new Map<number, number>();
    for (const ev of cal.events) if (!ev.recurrenceId) counts.set(ev.start.y, (counts.get(ev.start.y) ?? 0) + 1);
    return [...counts.entries()].sort((a, b) => a[0] - b[0]);
  }, [cal]);

  const span = useMemo(() => {
    const { first, last } = calendarSpan(cal);
    const f = (ms: number) => formatDateWith(new Date(ms), { month: "short", year: "numeric", timeZone: "UTC" });
    const a = f(first);
    const b = f(last);
    return a === b ? a : `${a} - ${b}`;
  }, [cal]);

  const hits = useMemo(() => {
    if (!q) return null;
    const out: number[] = [];
    let total = 0;
    for (let i = 0; i < occ.length; i++) if (matches(occ[i], q)) { total++; if (out.length < MAX_HITS) out.push(i); }
    return { out, total };
  }, [occ, q]);

  const jumpTo = (key: string) => {
    const i = firstOnOrAfter(occ, key);
    const lo = Math.min(i, Math.max(0, occ.length - PAGE));
    setWin({ lo, hi: Math.min(occ.length, lo + PAGE) });
    setQuery("");
    setQ("");
    setView("agenda");
    requestAnimationFrame(() => listRef.current?.scrollTo?.({ top: 0 }));
  };

  const goToday = () => {
    const [y, m] = keyParts(todayKey());
    setYm([y, m]);
    if (view === "month") return;
    jumpTo(todayKey());
  };

  const sel = selected !== null ? occ[selected] : null;
  const indices = hits ? hits.out : Array.from({ length: win.hi - win.lo }, (_, k) => win.lo + k);

  return (
    <div className="relative flex h-full w-full flex-col self-stretch overflow-hidden rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)]">
      <div className="flex min-w-0 items-center gap-3 border-b border-[var(--color-border)] px-4 py-2">
        <span className="shrink-0 font-mono text-xs uppercase text-[var(--color-text-muted)]">{tr("common.label.calendar")}</span>
        <span className="min-w-0 truncate text-sm font-semibold">{name}</span>
        <span className="shrink-0 text-xs tabular-nums text-[var(--color-text-muted)] max-sm:hidden">{tr("common.description.eventCount", { count: eventCount })}</span>
        <ViewTabs view={view} setView={setView} views={["agenda", "month", "source"]} />
      </div>

      {view === "source" ? (
        <div className="flex min-h-0 flex-1">{source}</div>
      ) : (
        <div className="flex min-h-0 flex-1">
          <aside className="hidden w-56 shrink-0 flex-col gap-5 overflow-y-auto border-e border-[var(--color-border)] p-4 xl:flex">
            <div className="flex items-start gap-2.5">
              <span className="flex size-8 shrink-0 items-center justify-center rounded-lg text-white" style={{ background: color }}><CalendarDays size={16} /></span>
              <span className="min-w-0 break-words text-sm font-semibold">{name}</span>
            </div>
            <dl className="grid gap-1.5 text-xs">
              {repeating > 0 && <Stat label={tr("common.label.repeating")} value={fmtNumber(repeating)} />}
              <Stat label={tr("common.label.dateRange")} value={span} />
              {(cal.timeZone || viewerZone) && <Stat label={tr("common.label.timeZone")} value={(viewerZone ?? cal.timeZone ?? "").replace(/_/g, " ")} />}
            </dl>
            <MiniMonth occ={occ} onPick={jumpTo} />
            {years.length > 1 && (
              <div className="grid gap-1.5">
                <span className="font-mono text-[10px] uppercase tracking-wider text-[var(--color-text-muted)]">{tr("common.label.jumpToYear")}</span>
                <div className="flex flex-wrap gap-1">
                  {years.map(([y, n]) => (
                    <button key={y} onClick={() => jumpTo(`${y}-01-01`)} className={`h-6 rounded-md px-1.5 text-[11px] font-medium tabular-nums ${BTN}`}>
                      {y}<span className="ms-1 text-[var(--color-text-muted)]">{fmtNumber(n)}</span>
                    </button>
                  ))}
                </div>
              </div>
            )}
          </aside>

          <div className={`flex min-w-0 flex-1 flex-col ${sel ? "max-lg:hidden" : ""}`}>
            <div className="flex flex-wrap items-center gap-2 border-b border-[var(--color-border)] px-3 py-2">
              <button onClick={goToday} className={`h-7 rounded-md px-2.5 text-xs font-medium ${BTN}`}>{tr("common.label.today")}</button>
              {view === "month" && (
                <div className="flex items-center gap-1">
                  <button aria-label={tr("common.accessibility.previousMonth")} onClick={() => setYm(([y, m]) => (m === 1 ? [y - 1, 12] : [y, m - 1]))} className={`flex size-7 items-center justify-center rounded-md ${BTN}`}><ChevronLeft size={14} className="rtl:-scale-x-100" /></button>
                  <button aria-label={tr("common.accessibility.nextMonth")} onClick={() => setYm(([y, m]) => (m === 12 ? [y + 1, 1] : [y, m + 1]))} className={`flex size-7 items-center justify-center rounded-md ${BTN}`}><ChevronRight size={14} className="rtl:-scale-x-100" /></button>
                  <span className="ms-1 text-sm font-semibold">{fmtMonth(ym[0], ym[1])}</span>
                </div>
              )}
              <label className="relative ms-auto min-w-36 max-w-64 flex-1">
                <Search size={14} className="absolute inset-s-2.5 top-1/2 -translate-y-1/2 text-[var(--color-text-muted)]" />
                <input
                  type="search"
                  value={query}
                  onChange={(e) => { setQuery(e.target.value); if (view === "month" && e.target.value) setView("agenda"); }}
                  placeholder={tr("common.placeholder.searchEvents")}
                  aria-label={tr("common.placeholder.searchEvents")}
                  className="h-7 w-full rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] ps-8 pe-2 text-xs outline-none focus:border-[var(--color-primary)]"
                />
              </label>
            </div>
            <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto">
              {view === "month" ? (
                <MonthGrid occ={occ} y={ym[0]} m={ym[1]} selected={selected} onPick={setSelected} color={color} />
              ) : (
                <>
                  {!hits && win.lo > 0 && (
                    <div className="flex items-center justify-between gap-3 border-b border-[var(--color-border)] px-4 py-2 text-xs text-[var(--color-text-muted)]">
                      <span className="tabular-nums">{tr("common.description.eventCount", { count: win.lo })}</span>
                      <button className="font-medium text-[var(--color-text)] underline underline-offset-2" onClick={() => setWin((w) => ({ ...w, lo: Math.max(0, w.lo - PAGE) }))}>{tr("common.action.showEarlierEvents")}</button>
                    </div>
                  )}
                  {indices.length === 0 ? (
                    <p className="py-10 text-center text-sm text-[var(--color-text-muted)]">{tr("common.empty.noEventsMatchQuery", { query: query.trim() })}</p>
                  ) : (
                    <Agenda occ={occ} indices={indices} selected={selected} onPick={setSelected} color={color} />
                  )}
                  {hits && hits.total > hits.out.length && (
                    <p className="px-4 py-3 text-center text-xs text-[var(--color-text-muted)]">{tr("common.description.searchResultsCapped", { shown: hits.out.length, total: hits.total })}</p>
                  )}
                  {!hits && win.hi < occ.length && (
                    <div className="flex justify-center py-4">
                      <button className={`h-8 rounded-md px-3 text-xs font-medium ${BTN}`} onClick={() => setWin((w) => ({ ...w, hi: Math.min(occ.length, w.hi + PAGE) }))}>{tr("common.action.showMoreEvents")}</button>
                    </div>
                  )}
                </>
              )}
            </div>
          </div>

          <aside className={`${sel ? "flex" : "flex max-lg:hidden"} min-h-0 w-full shrink-0 flex-col border-[var(--color-border)] lg:w-80 lg:border-s`}>
            {sel ? (
              <EventDetail o={sel} text={text} calName={name} color={color} onBack={() => setSelected(null)} />
            ) : (
              <p className="m-auto px-6 text-center text-sm text-[var(--color-text-muted)]">{tr("common.empty.selectAnEvent")}</p>
            )}
          </aside>
        </div>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-2">
      <dt className="shrink-0 text-[var(--color-text-muted)]">{label}</dt>
      <dd className="min-w-0 break-words text-end font-medium tabular-nums">{value}</dd>
    </div>
  );
}

function Agenda({ occ, indices, selected, onPick, color }: { occ: IcalOccurrence[]; indices: number[]; selected: number | null; onPick: (i: number) => void; color: string }) {
  const tr = useT();
  const today = todayKey();
  const groups: { month: string; days: { key: string; items: number[] }[] }[] = [];
  for (const i of indices) {
    const o = occ[i];
    const key = dayKey(o.start, o.allDay, viewerZone);
    const month = key.slice(0, 7);
    let g = groups[groups.length - 1];
    if (!g || g.month !== month) { g = { month, days: [] }; groups.push(g); }
    let d = g.days[g.days.length - 1];
    if (!d || d.key !== key) { d = { key, items: [] }; g.days.push(d); }
    d.items.push(i);
  }
  return (
    <div className="pb-2">
      {groups.map((g) => {
        const [gy, gm] = keyParts(`${g.month}-01`);
        return (
          <section key={g.month}>
            <h3 className="sticky top-0 z-[1] bg-[var(--color-bg)]/95 px-4 pt-3 pb-1.5 font-mono text-[10px] font-bold uppercase tracking-widest text-[var(--color-text-muted)] backdrop-blur">{fmtMonth(gy, gm)}</h3>
            {g.days.map((d) => {
              const [y, m, day] = keyParts(d.key);
              const ms = Date.UTC(y, m - 1, day);
              const isToday = d.key === today;
              return (
                <div key={d.key} className="grid grid-cols-[52px_minmax(0,1fr)] gap-1 px-3 pb-1.5">
                  <div className="ps-1 pt-2 leading-tight">
                    <span className={`block text-lg font-semibold tabular-nums ${isToday ? `inline-block rounded-md px-1.5 ${TODAY_PILL}` : ""}`}>{formatDateWith(new Date(ms), { day: "numeric", timeZone: "UTC" })}</span>
                    <span className="block text-[11px] uppercase tracking-wide text-[var(--color-text-muted)]">{formatDateWith(new Date(ms), { weekday: "short", timeZone: "UTC" })}</span>
                  </div>
                  <div className="grid min-w-0 gap-0.5">
                    {d.items.map((i) => {
                      const o = occ[i];
                      const ev = o.event;
                      return (
                        <button
                          key={o.key + i}
                          onClick={() => onPick(i)}
                          aria-pressed={selected === i}
                          className={`grid grid-cols-[84px_minmax(0,1fr)_auto] items-center gap-2.5 rounded-lg px-2.5 py-2 text-start transition-colors max-sm:grid-cols-[76px_minmax(0,1fr)] ${selected === i ? "bg-[var(--color-bg-tertiary)]" : "hover:bg-[var(--color-bg-secondary)]"}`}
                        >
                          <span className="flex items-center gap-2 whitespace-nowrap text-xs tabular-nums text-[var(--color-text-muted)]">
                            <span className="size-2 shrink-0 rounded-[3px]" style={{ background: color }} />
                            {o.allDay ? <span className="whitespace-nowrap rounded bg-[var(--color-bg-secondary)] px-1.5 text-[11px] font-medium text-[var(--color-text)]">{tr("common.label.allDay")}</span> : fmtTime(o.start)}
                          </span>
                          <span className="min-w-0 truncate text-[13px] font-medium">
                            <span className={isCancelled(ev) ? "text-[var(--color-text-muted)] line-through" : ""}>{ev.summary || tr("common.label.untitledEvent")}</span>
                            {ev.location && <span className="ms-1.5 text-xs font-normal text-[var(--color-text-muted)]">{ev.location}</span>}
                          </span>
                          <span className="flex gap-1.5 text-[var(--color-text-muted)] max-sm:hidden">
                            {o.recurring && <Repeat size={14} />}
                            {ev.attendees.length > 0 && <Users size={14} />}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </section>
        );
      })}
    </div>
  );
}

function monthBuckets(occ: IcalOccurrence[], first: number, cells: number, lead: number): Map<string, number[]> {
  const startKey = new Date(first - lead * DAY_MS).toISOString().slice(0, 10);
  const endKey = new Date(first + (cells - lead) * DAY_MS).toISOString().slice(0, 10);
  const buckets = new Map<string, number[]>();
  const from = first - (lead + 63) * DAY_MS;
  let lo = 0, hi = occ.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (occ[mid].start < from) lo = mid + 1; else hi = mid; }
  for (let i = lo; i < occ.length; i++) {
    const o = occ[i];
    if (o.start > first + (cells + 1) * DAY_MS) break;
    for (const k of occurrenceDays(o, viewerZone)) {
      if (k < startKey || k >= endKey) continue;
      let b = buckets.get(k);
      if (!b) { b = []; buckets.set(k, b); }
      b.push(i);
    }
  }
  for (const b of buckets.values()) b.sort((a, c) => Number(occ[c].allDay) - Number(occ[a].allDay) || occ[a].start - occ[c].start);
  return buckets;
}

/** Monday-first weeks, like the share page's grid. */
function monthShape(y: number, m: number) {
  const first = Date.UTC(y, m - 1, 1);
  const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const lead = (new Date(first).getUTCDay() + 6) % 7;
  const cells = Math.ceil((lead + days) / 7) * 7;
  return { first, days, lead, cells };
}

function MonthGrid({ occ, y, m, selected, onPick, color }: { occ: IcalOccurrence[]; y: number; m: number; selected: number | null; onPick: (i: number) => void; color: string }) {
  const tr = useT();
  const { first, days, lead, cells } = monthShape(y, m);
  const buckets = useMemo(() => monthBuckets(occ, first, cells, lead), [occ, first, cells, lead]);
  const today = todayKey();
  return (
    <div>
      <div className="grid grid-cols-7 border-b border-[var(--color-border)]">
        {Array.from({ length: 7 }, (_, k) => (
          <div key={k} className="truncate px-2 py-2 font-mono text-[10px] font-bold uppercase tracking-wider text-[var(--color-text-muted)]">
            {formatDateWith(new Date(Date.UTC(2024, 0, 1 + k)), { weekday: "short", timeZone: "UTC" })}
          </div>
        ))}
      </div>
      <div className="grid auto-rows-[minmax(96px,auto)] grid-cols-7 max-sm:auto-rows-[minmax(64px,auto)]">
        {Array.from({ length: cells }, (_, c) => {
          const ms = first + (c - lead) * DAY_MS;
          const key = new Date(ms).toISOString().slice(0, 10);
          const inMonth = c >= lead && c < lead + days;
          const list = buckets.get(key) ?? [];
          return (
            <div key={key} className="flex min-w-0 flex-col gap-0.5 border-e border-b border-[var(--color-border)] p-1.5 [&:nth-child(7n)]:border-e-0">
              <span className={`self-start text-xs font-medium tabular-nums ${key === today ? `rounded-md px-1.5 ${TODAY_PILL}` : inMonth ? "" : "text-[var(--color-text-muted)]/50"}`}>
                {formatDateWith(new Date(ms), { day: "numeric", timeZone: "UTC" })}
              </span>
              {list.slice(0, 3).map((i) => {
                const o = occ[i];
                return (
                  <button
                    key={i}
                    onClick={() => onPick(i)}
                    className={`w-full truncate rounded px-1 py-0.5 text-start text-[11px] ${selected === i ? "ring-1 ring-[var(--color-text-muted)]" : ""} ${o.allDay ? "" : "flex items-center gap-1"} ${isCancelled(o.event) ? "text-[var(--color-text-muted)] line-through" : ""}`}
                    style={o.allDay ? { background: `color-mix(in srgb, ${color} 16%, transparent)` } : undefined}
                  >
                    {!o.allDay && <span className="size-1.5 shrink-0 rounded-sm" style={{ background: color }} />}
                    {!o.allDay && <span className="tabular-nums text-[var(--color-text-muted)] max-sm:hidden">{fmtTime(o.start)}</span>}
                    <span className="truncate">{o.event.summary || tr("common.label.untitledEvent")}</span>
                  </button>
                );
              })}
              {list.length > 3 && (
                <button onClick={() => onPick(list[3])} className="px-1 text-start text-[11px] text-[var(--color-text-muted)] hover:text-[var(--color-text)]">
                  {tr("common.label.activelengthMore", { activeLength: list.length - 3 })}
                </button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function MiniMonth({ occ, onPick }: { occ: IcalOccurrence[]; onPick: (key: string) => void }) {
  const tr = useT();
  const [ym, setYm] = useState<[number, number]>(() => { const [y, m] = keyParts(todayKey()); return [y, m]; });
  const { first, days, lead, cells } = monthShape(ym[0], ym[1]);
  const buckets = useMemo(() => monthBuckets(occ, first, cells, lead), [occ, first, cells, lead]);
  const today = todayKey();
  return (
    <div className="grid gap-1.5">
      <div className="flex items-center justify-between text-xs font-semibold">
        <span>{fmtMonth(ym[0], ym[1])}</span>
        <span className="flex gap-0.5">
          <button aria-label={tr("common.accessibility.previousMonth")} onClick={() => setYm(([y, m]) => (m === 1 ? [y - 1, 12] : [y, m - 1]))} className={`flex size-5 items-center justify-center rounded ${BTN}`}><ChevronLeft size={12} className="rtl:-scale-x-100" /></button>
          <button aria-label={tr("common.accessibility.nextMonth")} onClick={() => setYm(([y, m]) => (m === 12 ? [y + 1, 1] : [y, m + 1]))} className={`flex size-5 items-center justify-center rounded ${BTN}`}><ChevronRight size={12} className="rtl:-scale-x-100" /></button>
        </span>
      </div>
      <div className="grid grid-cols-7 gap-0.5 text-center text-[11px] tabular-nums">
        {Array.from({ length: 7 }, (_, k) => (
          <span key={k} className="py-0.5 text-[10px] text-[var(--color-text-muted)]">{formatDateWith(new Date(Date.UTC(2024, 0, 1 + k)), { weekday: "narrow", timeZone: "UTC" })}</span>
        ))}
        {Array.from({ length: cells }, (_, c) => {
          const ms = first + (c - lead) * DAY_MS;
          const key = new Date(ms).toISOString().slice(0, 10);
          const inMonth = c >= lead && c < lead + days;
          const has = buckets.has(key);
          return (
            <button
              key={key}
              onClick={() => onPick(key)}
              className={`relative rounded-md py-1 ${key === today ? `font-semibold ${TODAY_PILL}` : inMonth ? "hover:bg-[var(--color-bg-secondary)]" : "text-[var(--color-text-muted)]/45 hover:bg-[var(--color-bg-secondary)]"}`}
            >
              {formatDateWith(new Date(ms), { day: "numeric", timeZone: "UTC" })}
              {has && <span className={`absolute bottom-0.5 left-1/2 size-[3px] -translate-x-1/2 rounded-full ${key === today ? "bg-[var(--color-bg)]" : "bg-[var(--color-text-muted)]"}`} />}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function downloadEvent(text: string, ev: IcalEvent) {
  const blob = new Blob([singleEventIcs(text, ev)], { type: "text/calendar" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${(ev.summary || "event").replace(/[\\/:*?"<>|]+/g, " ").trim().slice(0, 80) || "event"}.ics`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const LINK = "break-words underline decoration-[var(--color-border)] underline-offset-[3px]";

function DetailRows({ o }: { o: IcalOccurrence }) {
  const tr = useT();
  const ev = o.event;
  const orig = originalZone(o, tr);
  const call = safeHttp(ev.conference);
  const link = safeHttp(ev.url);
  const people = ev.attendees;
  const going = people.filter((p) => p.status === "accepted").length;
  return (
    <div className="grid gap-0.5 p-2">
      <Row icon={<Clock size={16} />}>
        <span>{whenLines(o, tr)}</span>
        {orig && <span className="block text-xs text-[var(--color-text-muted)]">{orig}</span>}
      </Row>
      {call && (
        <Row icon={<Video size={16} />}>
          <a href={call} target="_blank" rel="noreferrer" className={`inline-flex h-7 items-center gap-1.5 rounded-md px-2.5 text-xs font-semibold ${PRIMARY}`}>{tr("common.action.joinCall")}</a>
          <span className="mt-1 block break-all text-xs text-[var(--color-text-muted)]">{call.replace(/^https:\/\//, "")}</span>
        </Row>
      )}
      {ev.rule && <Row icon={<Repeat size={16} />}>{describeRule(ev.rule, ev.start, tr)}</Row>}
      {!ev.rule && o.recurring && ev.recurrenceId && <Row icon={<Repeat size={16} />}>{tr("common.description.repeatChangedOccurrence")}</Row>}
      {ev.location && (
        <Row icon={<MapPin size={16} />}>
          <a href={`https://maps.google.com/?q=${encodeURIComponent(ev.location)}`} target="_blank" rel="noreferrer" className={LINK}>{ev.location}</a>
        </Row>
      )}
      {(people.length > 0 || ev.organizer) && (
        <Row icon={<Users size={16} />}>
          {people.length > 0 && (
            <span>
              {tr("common.description.guestCount", { count: people.length })}
              {going > 0 && <span className="text-[var(--color-text-muted)]"> · {tr("common.description.guestsGoing", { count: going })}</span>}
            </span>
          )}
          <div className="mt-2 grid gap-1.5">
            {ev.organizer && (ev.organizer.name || ev.organizer.email) && <Person name={ev.organizer.name ?? ev.organizer.email!} sub={tr("common.label.organizer")} status={null} />}
            {people.filter((p) => !sameAs(p, ev.organizer)).slice(0, 60).map((p, i) => (
              <Person key={i} name={p.name ?? p.email ?? "?"} sub={rsvpLabel(p.status, tr)} status={p.status} email={p.name ? p.email : null} />
            ))}
            {people.length > 60 && <span className="text-xs text-[var(--color-text-muted)]">{tr("common.label.activelengthMore", { activeLength: people.length - 60 })}</span>}
          </div>
        </Row>
      )}
      {ev.alarms.length > 0 && <Row icon={<Bell size={16} />}>{ev.alarms.map((a) => reminderText(a, tr)).join(", ")}</Row>}
      {ev.description && (
        <Row icon={<StickyNote size={16} />}>
          <p className="m-0 whitespace-pre-wrap break-words rounded-lg bg-[var(--color-bg-secondary)] p-2.5 text-xs leading-relaxed">{ev.description}</p>
        </Row>
      )}
      {link && link !== call && (
        <Row icon={<LinkIcon size={16} />}>
          <a href={link} target="_blank" rel="noreferrer" className={`${LINK} break-all`}>{link}</a>
        </Row>
      )}
    </div>
  );
}

function Row({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[20px_minmax(0,1fr)] gap-2.5 px-2 py-2 text-[13px] leading-snug">
      <span className="mt-0.5 text-[var(--color-text-muted)]">{icon}</span>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

function Person({ name, sub, status, email }: { name: string; sub: string | null; status: IcalPartStat | null; email?: string | null }) {
  return (
    <div className="flex min-w-0 items-center gap-2 text-xs">
      <span className="relative flex size-6 shrink-0 items-center justify-center rounded-full text-[10px] font-semibold text-white" style={{ background: colorFor(name) }}>
        {initials(name)}
        {status && RSVP_DOT[status] && <span className={`absolute -end-0.5 -bottom-0.5 size-2.5 rounded-full ring-2 ring-[var(--color-bg)] ${RSVP_DOT[status]}`} />}
      </span>
      <span className="min-w-0 truncate" title={email ?? undefined}>{name}</span>
      {sub && <span className="ms-auto shrink-0 text-[11px] text-[var(--color-text-muted)]">{sub}</span>}
    </div>
  );
}

function EventDetail({ o, text, calName, color, onBack }: { o: IcalOccurrence; text: string; calName: string; color: string; onBack: () => void }) {
  const tr = useT();
  const ev = o.event;
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="grid gap-2 border-b border-[var(--color-border)] px-4 pt-4 pb-3">
          <button onClick={onBack} className="inline-flex items-center gap-1 self-start text-xs font-medium text-[var(--color-text-muted)] hover:text-[var(--color-text)] lg:hidden">
            <ChevronLeft size={14} className="rtl:-scale-x-100" /> {tr("common.back")}
          </button>
          <span className="flex min-w-0 items-center gap-2 text-xs text-[var(--color-text-muted)]">
            <span className="size-2 shrink-0 rounded-[3px]" style={{ background: color }} />
            <span className="truncate">{calName}</span>
            {isCancelled(ev) && <span className="font-semibold text-[var(--color-danger)]">{tr("common.status.eventCancelled")}</span>}
          </span>
          <h2 className={`m-0 break-words text-lg font-semibold leading-snug ${isCancelled(ev) ? "line-through" : ""}`}>{ev.summary || tr("common.label.untitledEvent")}</h2>
        </div>
        <DetailRows o={o} />
      </div>
      <div className="flex flex-wrap gap-2 border-t border-[var(--color-border)] px-4 py-3">
        <button onClick={() => downloadEvent(text, ev)} className={`inline-flex h-8 items-center gap-1.5 rounded-md px-3 text-xs font-medium ${BTN}`}><Download size={14} />{tr("common.action.downloadEvent")}</button>
        <a href={googleCalendarLink(o)} target="_blank" rel="noreferrer" className={`inline-flex h-8 items-center gap-1.5 rounded-md px-3 text-xs font-medium ${BTN}`}><CalendarPlus size={14} />{tr("common.action.addToGoogleCalendar")}</a>
      </div>
    </div>
  );
}

function SingleEvent({ occ: o, cal, text, fileName, source }: { occ: IcalOccurrence; cal: IcalCalendar; text: string; fileName: string; source: ReactNode }) {
  const tr = useT();
  const [view, setView] = useState<View>("details");
  const ev = o.event;
  const dead = isCancelled(ev) || cal.method === "CANCEL";
  const [now] = useState(() => Date.now());
  const state = dead ? tr("common.status.eventCancelled") : o.end < now && o.end > o.start ? tr("common.status.eventEnded") : o.start <= now && o.end >= now ? tr("common.status.eventNow") : null;
  const color = dotColor(cal.name || fileName);
  return (
    <div className="relative flex h-full w-full flex-col self-stretch overflow-hidden rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)]">
      <div className="flex min-w-0 items-center gap-3 border-b border-[var(--color-border)] px-4 py-2">
        <span className="shrink-0 font-mono text-xs uppercase text-[var(--color-text-muted)]">{tr("common.label.calendar")}</span>
        <span className="min-w-0 truncate text-sm font-semibold">{fileName}</span>
        <ViewTabs view={view} setView={setView} views={["details", "source"]} />
      </div>
      {view === "source" ? (
        <div className="flex min-h-0 flex-1">{source}</div>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto p-4 sm:p-8">
          <article className="mx-auto max-w-md overflow-hidden rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg)]">
            <header className="grid grid-cols-[92px_minmax(0,1fr)] border-b border-dashed border-[var(--color-border)]">
              <div className="flex flex-col items-center justify-center px-1.5 py-4 text-white" style={{ background: color }}>
                <span className="font-mono text-[11px] font-bold uppercase tracking-[0.14em]">{formatDateWith(new Date(o.start), { month: "short", timeZone: tzOf(o.allDay) })}</span>
                <span className="text-4xl font-bold leading-none tabular-nums">{formatDateWith(new Date(o.start), { day: "numeric", timeZone: tzOf(o.allDay) })}</span>
                <span className="text-xs opacity-90">{formatDateWith(new Date(o.start), { weekday: "long", timeZone: tzOf(o.allDay) })}</span>
              </div>
              <div className="grid min-w-0 content-center gap-1.5 px-4 py-4">
                {state && <span className={`justify-self-start rounded-full px-2 py-0.5 text-xs font-medium ${dead ? "bg-[var(--color-danger)]/10 text-[var(--color-danger)]" : "bg-[var(--color-bg-secondary)]"}`}>{state}</span>}
                <h2 className={`m-0 break-words text-lg font-semibold leading-snug ${dead ? "line-through" : ""}`}>{ev.summary || tr("common.label.untitledEvent")}</h2>
              </div>
            </header>
            <DetailRows o={o} />
            <div className="flex flex-wrap gap-2 border-t border-[var(--color-border)] px-4 py-3">
              <a href={googleCalendarLink(o)} target="_blank" rel="noreferrer" className={`inline-flex h-8 items-center gap-1.5 rounded-md px-3 text-xs font-semibold ${PRIMARY}`}><CalendarPlus size={14} />{tr("common.action.addToGoogleCalendar")}</a>
              <button onClick={() => downloadEvent(text, ev)} className={`inline-flex h-8 items-center gap-1.5 rounded-md px-3 text-xs font-medium ${BTN}`}><Download size={14} />{tr("common.action.downloadEvent")}</button>
            </div>
          </article>
        </div>
      )}
    </div>
  );
}
