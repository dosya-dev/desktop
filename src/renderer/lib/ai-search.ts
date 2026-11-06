// apps/desktop/src/renderer/lib/ai-search.ts
//
// Ported from apps/web/src/lib/ai-search.ts - keep the two in step.
//
// Client side of AI search: the settings types behind
// GET/PUT /api/workspaces/:id/ai-search, the account pool behind
// GET /api/me/ai-search, and the content search call GET /api/search/content.
//
// Content search is the expensive request (an embedding and an index scan per
// call), so the rate-limit rules live here, not in each caller: callers
// debounce with `debounced(fn, CONTENT_DEBOUNCE_MS)`, an identical request
// while one is in flight shares it, a 429 comes back as `busy` with the
// server's Retry-After (never as an empty answer), and a workspace without AI
// search (402 / 409) comes back as `unavailable` and is not asked again for a
// while.
//
// Desktop differences: requests go through api-client (`api` / `apiBase()`),
// and a 401 on the raw content fetch reports to session-loss.ts, the desktop's
// equivalent of the web's notifyUnauthorized.
import { api, apiBase } from "@/lib/api-client";
import { isSessionLossResponse, sessionLoss } from "@/lib/session-loss";

// ── Settings ───────────────────────────────────────────────

export interface AiLimits {
  vectorBudget: number;
  imagesMax: number;
  documentsMax: number;
  docChunksMax: number;
  backfillUnits: number;
  monthUnits: number;
}

export interface AiSearchSettings { enabled: boolean; index_existing: boolean; excluded_folders: string[] }

export interface AiSearchStatus {
  files_total: number; indexed: number; pending: number; partial: number; unsupported: number; capped: number;
  failed: number; images: number; documents: number; chunks: number;
  /** null = the owner's plan has no AI search. */
  limits: AiLimits | null;
  backfill_units_remaining: number; month_units_remaining: number; month_reset_at: number | null;
  estimated_finish_at: number | null; paused: boolean;
}

export interface AiSearchSettingsResponse { ok: true; settings: AiSearchSettings; status: AiSearchStatus; can_edit: boolean }

export type AiSearchPauseReason = "maintenance" | "planLimit" | "monthlyAllowance";

/**
 * Why indexing is not moving, or null when it is (or has nothing to do).
 * Platform pause first: no upgrade helps with it.
 */
export function pauseReason(status: AiSearchStatus): AiSearchPauseReason | null {
  if (status.paused) return "maintenance";
  const l = status.limits;
  if (!l) return null;
  if (status.capped > 0 || (l.imagesMax > 0 && status.images >= l.imagesMax) || (l.documentsMax > 0 && status.documents >= l.documentsMax)) return "planLimit";
  if (status.pending > 0 && status.backfill_units_remaining <= 0 && status.month_units_remaining <= 0) {
    return l.monthUnits > 0 ? "monthlyAllowance" : "planLimit";
  }
  return null;
}

function isSettingsResponse(v: unknown): v is AiSearchSettingsResponse {
  const r = v as Partial<AiSearchSettingsResponse> | null;
  return !!r && typeof r === "object" && !!r.settings && typeof r.settings.enabled === "boolean" && !!r.status && typeof r.status === "object";
}

export const aiSearchKey = (wsId: string | undefined) => ["ai-search", wsId] as const;

/** GET /api/workspaces/:id/ai-search; null when the answer is not the expected shape. */
export async function fetchWorkspaceAiSearch(wsId: string): Promise<AiSearchSettingsResponse | null> {
  const res = await api.get<unknown>(`/api/workspaces/${wsId}/ai-search`);
  if (!isSettingsResponse(res)) return null;
  return { ...res, can_edit: res.can_edit === true };
}

/**
 * PUT /api/workspaces/:id/ai-search (owner or change_ai_search). Throws the
 * api-client's ApiError on refusal; `data.error` carries the code
 * (ai_search_not_in_plan, ai_search_needs_object_home, rate_limited, ...).
 */
export async function updateWorkspaceAiSearch(wsId: string, patch: Partial<AiSearchSettings>): Promise<AiSearchSettings | null> {
  const res = await api.put<{ ok?: boolean; settings?: AiSearchSettings }>(`/api/workspaces/${wsId}/ai-search`, patch);
  return res?.settings ?? null;
}

// ── Account pool ───────────────────────────────────────────

export interface AccountAiPool {
  /** null = the plan has no AI search. */
  limits: AiLimits | null;
  backfill_units_remaining: number; backfill_units_total: number;
  month_units_remaining: number; month_units_total: number;
  /** Unix seconds, or null before the first monthly reset. */
  month_reset_at: number | null;
  /** The pool is a family payer's, shared with the family. */
  payer_is_family: boolean;
  /** Platform-wide pause (KV ai:paused). */
  paused: boolean;
}

export interface AccountAiWorkspace {
  id: string; name: string; enabled: boolean;
  indexed: number; pending: number; images: number; documents: number;
  images_max: number; documents_max: number;
  paused_reason: null | "limit" | "platform";
}

export interface AccountAiSearch { pool: AccountAiPool; workspaces: AccountAiWorkspace[] }

/** GET /api/me/ai-search: the caller's AI processing pool and owned workspaces. Null on an unexpected shape. */
export async function fetchAccountAiSearch(): Promise<AccountAiSearch | null> {
  const res = await api.get<Partial<AccountAiSearch> & { ok?: boolean }>("/api/me/ai-search");
  if (!res?.ok || !res.pool || typeof res.pool !== "object" || !Array.isArray(res.workspaces)) return null;
  return { pool: res.pool, workspaces: res.workspaces };
}

// ── Content search ─────────────────────────────────────────

/** The name-search file row plus what the content index adds. */
export interface ContentHit {
  id: string; name: string; size_bytes: number; mime_type: string; extension: string; region: string;
  folder_id: string | null; uploaded_by: string; created_at: number; lock_mode: string | null; uploader_name: string | null;
  score: number; snippet: string; page: number | null;
  source: "vector" | "keyword" | "both";
}

export type ContentSearchResult =
  | { kind: "ok"; files: ContentHit[]; partial: boolean }
  /** 429: the limiter or the index admission said no. Retry after `retryAfterS`. */
  | { kind: "busy"; retryAfterS: number }
  /** 402 / 409: no AI search in this workspace. Hide content results silently. */
  | { kind: "unavailable" }
  /** Anything else (network, 5xx). Also hidden: never shown as "no matches". */
  | { kind: "error" };

export interface ContentSearchOptions {
  signal?: AbortSignal;
  /** Capture-time bounds, unix seconds. */
  from?: number;
  to?: number;
}

export const CONTENT_DEBOUNCE_MS = 400;
/** How long a workspace without AI search is not asked again. */
export const UNAVAILABLE_TTL_MS = 5 * 60_000;
/** Longest wait honoured before the one retry after a 429. */
export const MAX_RETRY_WAIT_S = 10;

/** `fn` runs `ms` after the last call, with that call's arguments. */
export function debounced<A extends unknown[]>(fn: (...args: A) => void, ms: number): ((...args: A) => void) & { cancel(): void } {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const call = (...args: A) => {
    clearTimeout(timer);
    timer = setTimeout(() => { timer = undefined; fn(...args); }, ms);
  };
  call.cancel = () => { clearTimeout(timer); timer = undefined; };
  return call;
}

interface Flight { promise: Promise<ContentSearchResult>; ctrl: AbortController; waiters: number; pinned: boolean }
const inFlight = new Map<string, Flight>();
const unavailableUntil = new Map<string, number>();

/** Forget a cached "no AI search here", e.g. after the owner switches it on. */
export function forgetContentAvailability(wsId: string): void { unavailableUntil.delete(wsId); }

/** Test seam: drop every shared request and cached answer. */
export function resetContentSearchState(): void { inFlight.clear(); unavailableUntil.clear(); }

function abortError(): Error {
  return typeof DOMException !== "undefined" ? new DOMException("Aborted", "AbortError") : Object.assign(new Error("Aborted"), { name: "AbortError" });
}

async function request(wsId: string, q: string, opts: ContentSearchOptions, signal: AbortSignal): Promise<ContentSearchResult> {
  const params = new URLSearchParams({ workspace_id: wsId, q });
  if (opts.from != null) params.set("from", String(Math.floor(opts.from)));
  if (opts.to != null) params.set("to", String(Math.floor(opts.to)));
  const path = `/api/search/content?${params.toString()}`;
  let res: Response;
  try {
    res = await fetch(`${apiBase()}${path}`, { credentials: "include", signal });
  } catch (err) {
    if ((err as { name?: string })?.name === "AbortError") throw err;
    return { kind: "error" };
  }
  if (res.status === 429) {
    const header = Number(res.headers.get("Retry-After"));
    return { kind: "busy", retryAfterS: Number.isFinite(header) && header > 0 ? header : 1 };
  }
  if (res.status === 402 || res.status === 409) {
    unavailableUntil.set(wsId, Date.now() + UNAVAILABLE_TTL_MS);
    return { kind: "unavailable" };
  }
  if (isSessionLossResponse(path, res.status)) sessionLoss.report();
  if (!res.ok) return { kind: "error" };
  try {
    const body = (await res.json()) as { ok?: boolean; files?: ContentHit[]; partial?: boolean };
    if (!body?.ok || !Array.isArray(body.files)) return { kind: "error" };
    return { kind: "ok", files: body.files, partial: !!body.partial };
  } catch (err) {
    if ((err as { name?: string })?.name === "AbortError") throw err;
    return { kind: "error" };
  }
}

/**
 * One content search. An identical request (same workspace, query and
 * bounds) while one is pending shares it: without a signal the caller gets
 * the very same promise. With a signal the caller's promise rejects with an
 * AbortError when that signal aborts; the shared request itself is cancelled
 * only once every waiter has aborted.
 */
export function searchContent(wsId: string, q: string, opts: ContentSearchOptions = {}): Promise<ContentSearchResult> {
  // A remembered "no Smart Search here" does not stop a person search.
  const until = unavailableUntil.get(wsId);
  if (until !== undefined) {
    if (Date.now() < until) return Promise.resolve({ kind: "unavailable" });
    unavailableUntil.delete(wsId);
  }
  if (opts.signal?.aborted) return Promise.reject(abortError());

  const key = `${wsId}|${q}|${opts.from ?? ""}|${opts.to ?? ""}`;
  let flight = inFlight.get(key);
  if (!flight) {
    const ctrl = new AbortController();
    const f: Flight = { ctrl, waiters: 0, pinned: false, promise: null as unknown as Promise<ContentSearchResult> };
    f.promise = request(wsId, q, opts, ctrl.signal).finally(() => { if (inFlight.get(key) === f) inFlight.delete(key); });
    // A shared request nobody waits on any more still settles; keep it from
    // surfacing as an unhandled rejection.
    f.promise.catch(() => {});
    inFlight.set(key, f);
    flight = f;
  }

  const signal = opts.signal;
  if (!signal) { flight.pinned = true; return flight.promise; }

  const f = flight;
  f.waiters++;
  return new Promise<ContentSearchResult>((resolve, reject) => {
    const onAbort = () => {
      f.waiters--;
      if (f.waiters === 0 && !f.pinned) {
        f.ctrl.abort();
        if (inFlight.get(key) === f) inFlight.delete(key);
      }
      reject(abortError());
    };
    signal.addEventListener("abort", onAbort, { once: true });
    f.promise.then(
      (v) => { signal.removeEventListener("abort", onAbort); resolve(v); },
      (e) => { signal.removeEventListener("abort", onAbort); reject(e); },
    );
  });
}

function wait(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(abortError()); return; }
    const timer = setTimeout(() => { signal?.removeEventListener("abort", onAbort); resolve(); }, ms);
    const onAbort = () => { clearTimeout(timer); reject(abortError()); };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * searchContent with the UI's 429 rule: on `busy`, tell the caller (so it can
 * show "busy, retrying"), wait the server's Retry-After (capped), try once
 * more. A second `busy` is returned as is.
 */
export async function searchContentWithRetry(
  wsId: string, q: string, opts: ContentSearchOptions & { onBusy?: (retryAfterS: number) => void } = {},
): Promise<ContentSearchResult> {
  const { onBusy, ...rest } = opts;
  const first = await searchContent(wsId, q, rest);
  if (first.kind !== "busy") return first;
  onBusy?.(first.retryAfterS);
  await wait(Math.min(first.retryAfterS, MAX_RETRY_WAIT_S) * 1000, rest.signal);
  return searchContent(wsId, q, rest);
}

/** True for the rejection a cancelled search produces. */
export function isAbort(err: unknown): boolean {
  return (err as { name?: string } | null)?.name === "AbortError";
}
