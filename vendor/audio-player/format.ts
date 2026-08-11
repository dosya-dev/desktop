/** Time and name formatting shared by every audio surface. */

function safeSeconds(s: number): number {
  return Number.isFinite(s) && s > 0 ? Math.round(s) : 0;
}

/** "4:03". Minutes keep counting past 60 - a seek readout must never wrap. */
export function mmss(seconds: number): string {
  const s = safeSeconds(seconds);
  return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0");
}

/** "1:01:01" when there are hours, "0:59" when there are not. */
export function hms(seconds: number): string {
  const s = safeSeconds(seconds);
  const h = Math.floor(s / 3600);
  if (!h) return mmss(s);
  return h + ":" + String(Math.floor(s / 60) % 60).padStart(2, "0") + ":" + String(s % 60).padStart(2, "0");
}

/** Filename without its final extension - the title fallback for an untagged file. */
export function stripExt(name: string): string {
  return name.replace(/\.[^.]+$/, "");
}
