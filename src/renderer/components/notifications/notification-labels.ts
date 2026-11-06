import type { T } from "../../../i18n/translator";

/**
 * The words around a notification, in the chosen language. packages/shared
 * groups and ages the rows (groupByDay, relativeTime) in English for every
 * client; these give the same answers through the catalog. The rows' titles,
 * bodies and action labels are the server's text and stay as sent.
 */

/** groupByDay's "Today" / "Earlier", translated. */
export function dayGroupLabel(t: T, label: string): string {
  return label === "Today" ? t("common.label.today") : t("common.label.earlier");
}

/** relativeTime from packages/shared: "just now", "5m", "3h", "2d". Seconds in. */
export function notificationAge(t: T, createdAt: number, now: number): string {
  const s = Math.max(0, now - createdAt);
  if (s < 60) return t("common.label.justNow");
  if (s < 3600) return t("common.label.minutesM", { minutes: Math.floor(s / 60) });
  if (s < 86400) return t("common.label.hoursH", { hours: Math.floor(s / 3600) });
  return t("common.label.daysD", { days: Math.floor(s / 86400) });
}
