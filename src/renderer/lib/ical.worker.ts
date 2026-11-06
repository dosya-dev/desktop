// Ported from apps/web/src/lib/ical.worker.ts - keep in sync with the web copy.
/// <reference lib="webworker" />

import { expandCalendar, parseIcal } from "@dosya-dev/shared/files/ical";

/**
 * Reads a .ics off the main thread. A Google Takeout calendar can be tens of
 * megabytes with years of repeating events, and expanding it can take a few
 * seconds; the viewer keeps its spinner moving meanwhile. Occurrences point at
 * their events, and structured clone keeps that sharing intact on the way back.
 */
self.onmessage = (e: MessageEvent<{ text: string; now: number }>) => {
  try {
    const cal = parseIcal(e.data.text);
    const occ = expandCalendar(cal, e.data.now);
    self.postMessage({ ok: true, cal, occ });
  } catch {
    self.postMessage({ ok: false });
  }
};
