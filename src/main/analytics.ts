/**
 * Usage analytics for the desktop app, sent only after the person has agreed.
 *
 * The app carries no Google script. Events are queued here, in the main
 * process, and posted in small batches to our own API
 * (POST /api/analytics/collect), which forwards the ones in the shared
 * catalogue to Google Analytics and nothing else. The renderer names events
 * with the shared table (renderer/lib/analytics.ts) and hands them over IPC;
 * main adds the few only it can see (a sync run settling, a download saved).
 *
 * Why main and not the renderer: signing out reloads the renderer, and a
 * window in the tray hears nothing from the sync engine. A queue here
 * survives both.
 *
 * The rules this module keeps:
 *
 *   - Usage data is part of what people accept with the terms at sign-up, so
 *     it is on from the first launch; there is no separate question. The
 *     switch in the settings turns it off, and once it is off nothing is
 *     queued and nothing leaves.
 *   - The id that names this install to Google is random, minted on first
 *     launch and deleted when sharing is turned off. It is not the sync device id
 *     (sync/device-id.ts), and the request carries no cookie.
 *   - Failing is silent: no error surfaces, no batch is retried, and the
 *     timer never keeps the process alive.
 *
 * No Electron import, so `node --test` can load it; main/index.ts supplies
 * the directory, the version and the clock.
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

export type AnalyticsConsent = "granted" | "denied";
export type AnalyticsPlatform = "macos" | "windows" | "linux";
export type EventParams = Record<string, string | number | boolean>;

const FILE = "analytics.json";
const COLLECT_PATH = "/api/analytics/collect";
/** The relay takes 25 events a request; a full queue is sent at once. */
const BATCH_SIZE = 25;
/** Events wait this long for company before a batch goes out. */
const FLUSH_DELAY_MS = 15_000;
/** Activity after this long a silence is a new visit, as on the web. */
const SESSION_GAP_MS = 30 * 60 * 1000;
/** Offline for a while: keep the latest, drop the oldest. */
const QUEUE_LIMIT = 100;
/** A folder that syncs all day is one fact, not a stream of them. */
const SYNC_EVENT_GAP_MS = 15 * 60 * 1000;

const EVENT_NAME = /^[a-z][a-z0-9_]{0,39}$/;
const PARAM_VALUE = /^[A-Za-z0-9_.:/-]{1,64}$/;

export function platformOf(nodePlatform: string): AnalyticsPlatform | null {
  if (nodePlatform === "darwin") return "macos";
  if (nodePlatform === "win32") return "windows";
  if (nodePlatform === "linux") return "linux";
  return null;
}

/**
 * True when a pair that was syncing no longer is: the edge, not the state,
 * for the reason renderer/lib/sync-settled.ts gives. Ported rather than
 * imported because main stops telling a hidden window about sync at all.
 */
export function syncSettled(
  prev: { pairs: Array<{ pairId?: string; status: string }> } | null,
  next: { pairs: Array<{ pairId?: string; status: string }> },
): boolean {
  if (!prev) return false;
  const was = new Set(prev.pairs.filter((p) => p.status === "syncing").map((p, i) => p.pairId ?? String(i)));
  if (was.size === 0) return false;
  return next.pairs.some((p, i) => was.has(p.pairId ?? String(i)) && p.status !== "syncing");
}

export interface AnalyticsDeps {
  /** userData: analytics.json lives here, outside sync/, so a sync reset leaves the answer alone. */
  dir: string;
  apiBase: string;
  platform: AnalyticsPlatform | null;
  version: string;
  /** direct, mas, ms-store or snap. */
  channel: string;
  locale?: () => string | null;
  fetchImpl?: typeof fetch;
  now?: () => number;
  /** False under the test harness, so a spec run never reports usage. Default true. */
  defaultOn?: boolean;
}

type Queued = { name: string; params?: EventParams; at: number };

export class Analytics {
  private consentState: AnalyticsConsent = "denied";
  private clientId: string | null = null;
  private sessionId: string | null = null;
  private lastActivityAt = 0;
  private queue: Queued[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private focusedSince: number | null = null;
  private engagedMs = 0;
  private lastSyncEventAt = 0;
  private lastScreen: string | null = null;
  private readonly deps: AnalyticsDeps;
  private readonly now: () => number;
  private readonly fetchImpl: typeof fetch;

  // Fields assigned by hand, not parameter properties: node --test strips
  // types and cannot run syntax that needs transforming.
  constructor(deps: AnalyticsDeps) {
    this.deps = deps;
    this.now = deps.now ?? (() => Date.now());
    this.fetchImpl = deps.fetchImpl ?? ((...args) => fetch(...args));
  }

  /**
   * Reads the stored choice: on unless it was turned off. Never rejects. A
   * file that exists but cannot be read may hold a "no", so it sends nothing
   * for this run and is left as it is.
   */
  async load(): Promise<void> {
    let text: string | null = null;
    try {
      text = await readFile(join(this.deps.dir, FILE), "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") return;
    }
    let raw: { consent?: unknown; clientId?: unknown } = {};
    if (text !== null) {
      try {
        raw = JSON.parse(text) as typeof raw;
      } catch {
        return;
      }
    }
    if (raw === null || typeof raw !== "object" || raw.consent === false) return;
    if (raw.consent !== true && this.deps.defaultOn === false) return;
    const kept = typeof raw.clientId === "string" && /^[0-9]{1,12}\.[0-9]{1,12}$/.test(raw.clientId) ? raw.clientId : null;
    this.clientId = kept ?? this.mintClientId();
    this.consentState = "granted";
    if (!kept || raw.consent !== true) await this.save();
    this.track("app_open");
  }

  consent(): AnalyticsConsent {
    return this.consentState;
  }

  /** The settings switch. */
  async setConsent(on: boolean): Promise<AnalyticsConsent> {
    if (on) {
      const already = this.consentState === "granted";
      if (!this.clientId) this.clientId = this.mintClientId();
      this.consentState = "granted";
      if (!already) this.track("app_open");
    } else {
      // Withdrawn: what was waiting is dropped, not sent, and the id goes
      // with it, so agreeing again later starts as someone new.
      this.consentState = "denied";
      this.clientId = null;
      this.sessionId = null;
      this.queue = [];
      this.engagedMs = 0;
      this.lastScreen = null;
      if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    }
    await this.save();
    return this.consentState;
  }

  /**
   * One event. The catalogue is enforced by the renderer before it gets here
   * and by the relay after; this is the shape check in between, so a
   * compromised renderer cannot push arbitrary text into the queue.
   */
  track(name: unknown, params?: unknown): void {
    if (this.consentState !== "granted" || !this.clientId) return;
    if (typeof name !== "string" || !EVENT_NAME.test(name)) return;
    const clean: EventParams = {};
    if (params && typeof params === "object" && !Array.isArray(params)) {
      for (const [key, value] of Object.entries(params as Record<string, unknown>).slice(0, 8)) {
        if (!EVENT_NAME.test(key)) continue;
        if (typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))) clean[key] = value;
        else if (typeof value === "string" && PARAM_VALUE.test(value)) clean[key] = value;
      }
    }
    const at = this.now();
    if (name === "page_view") {
      // The same screen twice in a row (a reload, a restored route) is one view.
      const screen = typeof clean.screen === "string" ? clean.screen : null;
      if (!screen || screen === this.lastScreen) return;
      this.lastScreen = screen;
    }
    if (!this.sessionId || at - this.lastActivityAt >= SESSION_GAP_MS) {
      this.sessionId = String(Math.floor(at / 1000));
    }
    this.lastActivityAt = at;
    this.queue.push(Object.keys(clean).length ? { name, params: clean, at } : { name, at });
    if (this.queue.length > QUEUE_LIMIT) this.queue = this.queue.slice(this.queue.length - QUEUE_LIMIT);
    if (this.queue.length >= BATCH_SIZE) void this.flush();
    else if (!this.timer) {
      this.timer = setTimeout(() => { this.timer = null; void this.flush(); }, FLUSH_DELAY_MS);
      this.timer.unref?.();
    }
  }

  /** A sync run just finished. Counted at most once per quarter hour. */
  syncSettled(result: "ok" | "error" = "ok"): void {
    const at = this.now();
    if (this.lastSyncEventAt && at - this.lastSyncEventAt < SYNC_EVENT_GAP_MS) return;
    if (this.consentState !== "granted") return;
    this.lastSyncEventAt = at;
    this.track("sync_complete", { result });
  }

  /** A window of the app took or lost focus: time in front is what counts as engagement. */
  setFocused(focused: boolean): void {
    const at = this.now();
    if (focused) {
      if (this.focusedSince === null) this.focusedSince = at;
    } else if (this.focusedSince !== null) {
      this.engagedMs += Math.max(0, at - this.focusedSince);
      this.focusedSince = null;
      void this.flush();
    }
  }

  /** Sends what is waiting. Resolves when the attempt is over; never rejects. */
  async flush(): Promise<void> {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    const { platform, version, channel, apiBase } = this.deps;
    if (this.consentState !== "granted" || !this.clientId || !this.sessionId || !platform || this.queue.length === 0) return;
    const events = this.queue.slice(0, BATCH_SIZE);
    this.queue = this.queue.slice(events.length);
    const at = this.now();
    if (this.focusedSince !== null) {
      this.engagedMs += Math.max(0, at - this.focusedSince);
      this.focusedSince = at;
    }
    const body: Record<string, unknown> = {
      consent: true,
      client_id: this.clientId,
      session_id: this.sessionId,
      platform,
      app_version: version,
      channel,
      engagement_ms: this.engagedMs,
      events,
    };
    this.engagedMs = 0;
    const locale = this.deps.locale?.();
    if (locale) body.locale = locale;
    try {
      await this.fetchImpl(`${apiBase}${COLLECT_PATH}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Dosya-Client": `desktop/${version}` },
        body: JSON.stringify(body),
      });
    } catch {
      /* offline: this batch is gone, by design */
    }
    if (this.queue.length > 0) void this.flush();
  }

  /** Two runs of digits, the shape Google's own tag mints for a browser. */
  private mintClientId(): string {
    const random = Math.floor(Math.random() * 2_147_483_647) + 1;
    return `${random}.${Math.floor(this.now() / 1000)}`;
  }

  private async save(): Promise<void> {
    const data = this.consentState === "granted"
      ? { consent: true, clientId: this.clientId }
      : { consent: false };
    try {
      await mkdir(this.deps.dir, { recursive: true });
      // Temp + rename, so a crash mid-write cannot leave half an answer.
      const tmp = join(this.deps.dir, `${FILE}.tmp`);
      await writeFile(tmp, JSON.stringify(data), "utf8");
      await rename(tmp, join(this.deps.dir, FILE));
    } catch {
      /* the answer holds for this run; asked again next launch */
    }
  }
}

let instance: Analytics | null = null;

/** The process's one Analytics, set by main/index.ts at startup; null before that and in tests. */
export function setAnalytics(a: Analytics | null): void {
  instance = a;
}

export function getAnalytics(): Analytics | null {
  return instance;
}
