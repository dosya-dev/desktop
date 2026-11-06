// apps/desktop/src/renderer/lib/ai-search.test.ts
//
// Runs on vitest (see vitest.config.ts): ai-search.ts imports "@/lib/...",
// which node:test cannot resolve.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/api-client", () => ({ api: { get: vi.fn(), put: vi.fn() }, apiBase: () => "https://api.test" }));
const report = vi.fn();
vi.mock("@/lib/session-loss", () => ({ isSessionLossResponse: (_p: string, s: number) => s === 401, sessionLoss: { report: () => report() } }));

const {
  CONTENT_DEBOUNCE_MS, MAX_RETRY_WAIT_S, UNAVAILABLE_TTL_MS, debounced, forgetContentAvailability, isAbort,
  pauseReason, resetContentSearchState, searchContent, searchContentWithRetry, fetchWorkspaceAiSearch, updateWorkspaceAiSearch,
} = await import("./ai-search");
const { api } = await import("@/lib/api-client");

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
const okBody = { ok: true, files: [{ id: "f1", name: "a.pdf" }], partial: false };

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  resetContentSearchState();
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  report.mockReset();
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("debounced", () => {
  it("runs once, CONTENT_DEBOUNCE_MS after the last call, with that call's arguments", () => {
    vi.useFakeTimers();
    const fn = vi.fn();
    const d = debounced(fn, CONTENT_DEBOUNCE_MS);
    d("a"); vi.advanceTimersByTime(300); d("ab"); vi.advanceTimersByTime(399);
    expect(fn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith("ab");
    expect(CONTENT_DEBOUNCE_MS).toBe(400);
  });

  it("cancel drops the pending call", () => {
    vi.useFakeTimers();
    const fn = vi.fn();
    const d = debounced(fn, 400);
    d("x"); d.cancel(); vi.advanceTimersByTime(1000);
    expect(fn).not.toHaveBeenCalled();
  });
});

describe("searchContent", () => {
  it("calls GET /api/search/content with cookies and returns the hits", async () => {
    fetchMock.mockResolvedValue(json(okBody));
    const r = await searchContent("ws1", "invoice", { from: 10.7 });
    expect(r).toEqual({ kind: "ok", files: okBody.files, partial: false });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.test/api/search/content?workspace_id=ws1&q=invoice&from=10");
    expect(init.credentials).toBe("include");
  });

  it("shares an identical request while one is in flight", async () => {
    let resolve!: (r: Response) => void;
    fetchMock.mockReturnValue(new Promise<Response>((r) => { resolve = r; }));
    const a = searchContent("ws1", "cat");
    const b = searchContent("ws1", "cat");
    const c = searchContent("ws1", "dog");
    expect(a).toBe(b);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    resolve(json(okBody));
    expect((await a).kind).toBe("ok");
    // Settled: the next identical call asks again.
    fetchMock.mockResolvedValue(json(okBody));
    await searchContent("ws1", "cat");
    expect(fetchMock).toHaveBeenCalledTimes(3);
    void c;
  });

  it("aborts the shared request only when every waiter has aborted", async () => {
    fetchMock.mockImplementation((_u: string, init: RequestInit) => new Promise((_r, reject) => {
      init.signal!.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
    }));
    const c1 = new AbortController(); const c2 = new AbortController();
    const p1 = searchContent("ws1", "q", { signal: c1.signal });
    const p2 = searchContent("ws1", "q", { signal: c2.signal });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const inner = fetchMock.mock.calls[0][1].signal as AbortSignal;
    c1.abort();
    await expect(p1).rejects.toSatisfy(isAbort);
    expect(inner.aborted).toBe(false);
    c2.abort();
    await expect(p2).rejects.toSatisfy(isAbort);
    expect(inner.aborted).toBe(true);
  });

  it("429 comes back as busy with the server's Retry-After", async () => {
    fetchMock.mockResolvedValue(json({ ok: false, error: "rate_limited" }, 429, { "Retry-After": "3" }));
    expect(await searchContent("ws1", "q")).toEqual({ kind: "busy", retryAfterS: 3 });
  });

  it("402 comes back as unavailable and is cached for the workspace", async () => {
    vi.useFakeTimers();
    fetchMock.mockResolvedValue(json({ ok: false, error: "ai_search_not_in_plan" }, 402));
    expect(await searchContent("ws1", "q")).toEqual({ kind: "unavailable" });
    expect(await searchContent("ws1", "other")).toEqual({ kind: "unavailable" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // Another workspace is still asked.
    await searchContent("ws2", "q");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    // After the TTL it asks again.
    vi.advanceTimersByTime(UNAVAILABLE_TTL_MS + 1);
    fetchMock.mockResolvedValue(json(okBody));
    expect((await searchContent("ws1", "q")).kind).toBe("ok");
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("forgetContentAvailability drops the cached unavailable answer", async () => {
    fetchMock.mockResolvedValueOnce(json({ ok: false }, 409)).mockResolvedValue(json(okBody));
    expect((await searchContent("ws1", "q")).kind).toBe("unavailable");
    forgetContentAvailability("ws1");
    expect((await searchContent("ws1", "q")).kind).toBe("ok");
  });

  it("network failures and 5xx are errors, a 401 reports session loss", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    expect(await searchContent("ws1", "q")).toEqual({ kind: "error" });
    fetchMock.mockResolvedValueOnce(json({ ok: false }, 500));
    expect(await searchContent("ws1", "q")).toEqual({ kind: "error" });
    fetchMock.mockResolvedValueOnce(json({ ok: false }, 401));
    expect(await searchContent("ws1", "q")).toEqual({ kind: "error" });
    expect(report).toHaveBeenCalledTimes(1);
  });
});

describe("searchContent has no person filter", () => {
  it("sends only the workspace and the words, never a person", async () => {
    fetchMock.mockImplementation(async () => json(okBody));
    await searchContent("ws1", "beach", { persons: ["p1"] } as never);
    const a = new URL(String(fetchMock.mock.calls[0][0]), "https://x");
    expect(a.searchParams.has("person")).toBe(false);
    expect(a.searchParams.get("q")).toBe("beach");
  });
});

describe("searchContentWithRetry", () => {
  it("on busy, tells the caller, waits Retry-After and tries once more", async () => {
    vi.useFakeTimers();
    fetchMock
      .mockResolvedValueOnce(json({ ok: false }, 429, { "Retry-After": "2" }))
      .mockResolvedValueOnce(json(okBody));
    const onBusy = vi.fn();
    const p = searchContentWithRetry("ws1", "q", { onBusy });
    await vi.advanceTimersByTimeAsync(1999);
    expect(onBusy).toHaveBeenCalledWith(2);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect((await p).kind).toBe("ok");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("caps the wait and returns a second busy as is", async () => {
    vi.useFakeTimers();
    fetchMock.mockResolvedValue(json({ ok: false }, 429, { "Retry-After": "120" }));
    const p = searchContentWithRetry("ws1", "q");
    await vi.advanceTimersByTimeAsync(MAX_RETRY_WAIT_S * 1000);
    expect(await p).toEqual({ kind: "busy", retryAfterS: 120 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("settings helpers", () => {
  it("fetchWorkspaceAiSearch returns null on an unexpected shape and normalises can_edit", async () => {
    vi.mocked(api.get).mockResolvedValueOnce({ ok: true });
    expect(await fetchWorkspaceAiSearch("ws1")).toBeNull();
    vi.mocked(api.get).mockResolvedValueOnce({ ok: true, settings: { enabled: false, index_existing: true, excluded_folders: [] }, status: { limits: null } });
    expect((await fetchWorkspaceAiSearch("ws1"))?.can_edit).toBe(false);
    expect(api.get).toHaveBeenLastCalledWith("/api/workspaces/ws1/ai-search");
  });

  it("updateWorkspaceAiSearch PUTs the patch and returns the settings", async () => {
    const settings = { enabled: true, index_existing: true, excluded_folders: [] };
    vi.mocked(api.put).mockResolvedValueOnce({ ok: true, settings });
    expect(await updateWorkspaceAiSearch("ws1", { enabled: true })).toEqual(settings);
    expect(api.put).toHaveBeenCalledWith("/api/workspaces/ws1/ai-search", { enabled: true });
  });

  it("pauseReason: platform pause first, then plan caps, then the monthly allowance", () => {
    const limits = { vectorBudget: 1, imagesMax: 10, documentsMax: 10, docChunksMax: 1, backfillUnits: 1, monthUnits: 5 };
    const base = { files_total: 0, indexed: 0, pending: 0, partial: 0, unsupported: 0, capped: 0, failed: 0, images: 0, documents: 0, chunks: 0, limits, backfill_units_remaining: 1, month_units_remaining: 1, month_reset_at: null, estimated_finish_at: null, paused: false };
    expect(pauseReason(base)).toBeNull();
    expect(pauseReason({ ...base, paused: true, capped: 1 })).toBe("maintenance");
    expect(pauseReason({ ...base, images: 10 })).toBe("planLimit");
    expect(pauseReason({ ...base, pending: 3, backfill_units_remaining: 0, month_units_remaining: 0 })).toBe("monthlyAllowance");
    expect(pauseReason({ ...base, limits: null, capped: 4 })).toBeNull();
  });
});
