// Ported from apps/web/src/lib/calendar-read.ts - keep in sync with the web copy.
import { expandCalendar, parseIcal, type IcalCalendar, type IcalEvent, type IcalOccurrence, type IcalRule } from "@dosya-dev/shared/files/ical";
import { intlLocale } from "./locale-state";
import type { T } from "../../i18n/translator";

/**
 * Reading a .ics for the calendar viewer, and saying its repeats in the UI
 * language. Kept out of the component file so it stays components-only.
 */

export type ParsedCalendar = { cal: IcalCalendar; occ: IcalOccurrence[] };

/** Files above this are read in a worker, so the spinner keeps moving. */
const WORKER_MIN = 512 * 1024;

/** Intl date formatting in the UI language (English keeps the OS locale). */
export const formatDateWith = (d: Date, opts: Intl.DateTimeFormatOptions): string =>
  new Intl.DateTimeFormat(intlLocale(), opts).format(d);

/** Parse and expand, in a worker when the file is big and workers exist. */
export function readCalendar(text: string, now = Date.now()): Promise<ParsedCalendar> {
  const inline = (): ParsedCalendar => {
    const cal = parseIcal(text);
    return { cal, occ: expandCalendar(cal, now) };
  };
  if (text.length < WORKER_MIN || typeof Worker === "undefined") return Promise.resolve(inline());
  return new Promise((resolve) => {
    let w: Worker;
    try {
      w = new Worker(new URL("./ical.worker.ts", import.meta.url), { type: "module" });
    } catch {
      resolve(inline());
      return;
    }
    const done = (r: ParsedCalendar) => { w.terminate(); resolve(r); };
    w.onmessage = (e: MessageEvent<{ ok: boolean } & Partial<ParsedCalendar>>) => (e.data.ok && e.data.cal && e.data.occ ? done({ cal: e.data.cal, occ: e.data.occ }) : done(inline()));
    w.onerror = () => done(inline());
    w.postMessage({ text, now });
  });
}

/** The select keys of repeatMonthlyNth; anything else (last) takes the other branch. */
const ORDINAL_KEYS = ["first", "second", "third", "fourth", "fifth"];

const WEEKDAY_INDEX: Record<string, number> = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };
/** A weekday name in the UI language: 2024-01-07 was a Sunday. */
const weekdayName = (wd: string) => formatDateWith(new Date(Date.UTC(2024, 0, 7 + WEEKDAY_INDEX[wd])), { weekday: "long", timeZone: "UTC" });

const listOf = (items: string[]) => {
  try {
    return new Intl.ListFormat(intlLocale(), { type: "conjunction", style: "long" }).format(items);
  } catch {
    return items.join(", ");
  }
};

/** A repeat rule as one sentence ("Every weekday, until 18 December 2026"), or "Repeats" for shapes too odd to say. */
export function describeRule(rule: IcalRule, start: IcalEvent["start"], tr: T): string {
  if (rule.unsupported) return tr("common.description.repeatCustom");
  const interval = rule.interval;
  const every = rule.byDay.filter((b) => b.n === 0).map((b) => b.wd);
  let base: string | null = null;
  if (rule.freq === "DAILY" && !rule.byDay.length && !rule.byMonthDay.length && !rule.byMonth.length) {
    base = tr("common.description.repeatDaily", { interval });
  } else if (rule.freq === "WEEKLY" && !rule.byMonth.length) {
    if (interval === 1 && every.length === 5 && (["MO", "TU", "WE", "TH", "FR"] as const).every((d) => every.includes(d))) base = tr("common.description.repeatWeekdays");
    else {
      const days = every.length ? every : [Object.keys(WEEKDAY_INDEX)[new Date(Date.UTC(start.y, start.mo - 1, start.d)).getUTCDay()]];
      base = tr("common.description.repeatWeekly", { interval, days: listOf(days.map(weekdayName)) });
    }
  } else if (rule.freq === "MONTHLY" && !rule.byMonth.length && !rule.bySetPos.length) {
    const nth = rule.byDay.length === 1 && rule.byDay[0].n !== 0 ? rule.byDay[0] : null;
    if (nth && !rule.byMonthDay.length && nth.n >= -1 && nth.n <= 5) {
      base = tr("common.description.repeatMonthlyNth", { interval, position: nth.n === -1 ? "last" : ORDINAL_KEYS[nth.n - 1], weekday: weekdayName(nth.wd) });
    } else if (!rule.byDay.length && rule.byMonthDay.length <= 1) {
      const day = rule.byMonthDay[0] ?? start.d;
      base = day === -1 ? tr("common.description.repeatMonthlyLastDay", { interval }) : day > 0 ? tr("common.description.repeatMonthlyDay", { interval, day }) : null;
    }
  } else if (rule.freq === "YEARLY" && !rule.byDay.length && rule.byMonth.length <= 1 && rule.byMonthDay.length <= 1) {
    const mo = rule.byMonth[0] ?? start.mo;
    const d = rule.byMonthDay[0] ?? start.d;
    if (d > 0) base = tr("common.description.repeatYearly", { interval, date: formatDateWith(new Date(Date.UTC(2024, mo - 1, d)), { day: "numeric", month: "long", timeZone: "UTC" }) });
  }
  if (!base) return tr("common.description.repeatCustom");
  if (rule.until) {
    return tr("common.description.repeatUntil", { rule: base, date: formatDateWith(new Date(Date.UTC(rule.until.y, rule.until.mo - 1, rule.until.d)), { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" }) });
  }
  if (rule.count) return tr("common.description.repeatTimes", { rule: base, count: rule.count });
  return base;
}
