// apps/desktop/src/renderer/pages/SearchPage.content.test.tsx
//
// The Search page's "In file contents" section (AI search): it runs beside
// the name search on its own debounce, shows busy (never empty) on a 429,
// disappears on 402, and never holds the name results up.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes, useLocation, useNavigate, type NavigateFunction } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const get = vi.fn();
vi.mock("@/lib/api-client", async (orig) => ({
  ...(await orig<typeof import("@/lib/api-client")>()),
  api: { get: (p: string) => get(p), put: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
  apiBase: () => "https://api.test",
}));
const wsState = vi.hoisted(() => ({ active: { id: "ws1", name: "Team" } }));
vi.mock("@/lib/workspace-context", () => ({
  useWorkspace: () => ({ active: wsState.active, workspaces: [wsState.active], setActive: () => {} }),
}));

const { SearchPage } = await import("./SearchPage");
const { resetContentSearchState } = await import("@/lib/ai-search");

const NOW = 1_760_000_000;
const nameFile = { id: "f1", name: "report.pdf", size_bytes: 5000, mime_type: "application/pdf", extension: "pdf", region: "eu", folder_id: "d1", uploader_name: "Sam", created_at: NOW };
const hit = {
  ...nameFile, id: "f9", name: "invoice-2024.pdf", folder_id: "d7", uploaded_by: "u1", lock_mode: null,
  score: 0.9, snippet: "Total due on receipt", page: 3, source: "both" as const,
};
let nameFiles: typeof nameFile[] = [nameFile];

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });
let fetchMock: ReturnType<typeof vi.fn>;

beforeAll(() => { (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true; });
let root: Root | null = null; let container: HTMLDivElement | null = null;
beforeEach(() => {
  resetContentSearchState();
  wsState.active = { id: "ws1", name: "Team" };
  nameFiles = [nameFile];
  get.mockReset();
  get.mockImplementation(async (p: string) => {
    if (p.startsWith("/api/search?")) return { ok: true, query: "rec", files: nameFiles, folders: [], shared: [], file_requests: [] };
    throw new Error(`unexpected ${p}`);
  });
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  if (root) act(() => root!.unmount());
  container?.remove(); root = null; container = null;
  vi.unstubAllGlobals();
});

let nav: NavigateFunction | null = null;
function Where() {
  const l = useLocation();
  nav = useNavigate();
  return <div data-testid="where">{l.pathname + l.search}</div>;
}

const tick = async (ms = 0) => { await act(async () => { await new Promise((r) => setTimeout(r, ms)); }); };
async function mount(url = "/search?q=rec") {
  container = document.createElement("div"); document.body.appendChild(container);
  root = createRoot(container);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root!.render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={[url]}>
          <Routes><Route path="*" element={<><SearchPage /><Where /></>} /></Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
  for (let i = 0; i < 4; i++) await tick();
}
const section = () => container!.querySelector("[data-content-results]");
const text = () => container!.textContent ?? "";

describe("Search page content results", () => {
  it("adds the In file contents section after its debounced request, and a hit opens its folder", async () => {
    fetchMock.mockResolvedValue(json({ ok: true, files: [hit], partial: false }));
    await mount();
    // Name results are already there; the content request has not gone out yet.
    expect(text()).toContain("report.pdf");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(section()?.textContent).toContain("Searching file contents");
    await tick(450);
    await tick();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toBe("https://api.test/api/search/content?workspace_id=ws1&q=rec");
    const s = section()!;
    expect(s.textContent).toContain("In file contents");
    expect(s.textContent).toContain("invoice-2024.pdf");
    expect(s.textContent).toContain("Total due on receipt");
    expect(s.textContent).toContain("p. 3");
    await act(async () => { (s.querySelector('[data-testid="content-hit"]') as HTMLButtonElement).click(); });
    expect(container!.querySelector('[data-testid="where"]')?.textContent).toBe("/files?folder=d7");
  });

  it("says No content matches only for a complete empty answer", async () => {
    fetchMock.mockResolvedValue(json({ ok: true, files: [], partial: false }));
    await mount();
    await tick(450); await tick();
    expect(section()?.textContent).toContain("No content matches");
  });

  it("hides the section for a partial empty answer", async () => {
    fetchMock.mockResolvedValue(json({ ok: true, files: [], partial: true }));
    await mount();
    await tick(450); await tick();
    expect(section()).toBeNull();
  });

  it("shows busy on a 429, retries once, and never shows the empty state", async () => {
    fetchMock
      .mockResolvedValueOnce(json({ ok: false, error: "rate_limited" }, 429, { "Retry-After": "1" }))
      .mockResolvedValueOnce(json({ ok: true, files: [hit], partial: false }));
    await mount();
    await tick(450); await tick();
    expect(section()?.textContent).toContain("Content search is busy, retrying");
    expect(text()).not.toContain("No content matches");
    await tick(1050); await tick();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(section()?.textContent).toContain("invoice-2024.pdf");
    expect(text()).not.toContain("No content matches");
  });

  it("hides the section on 402 and leaves the name results alone", async () => {
    fetchMock.mockResolvedValue(json({ ok: false, error: "ai_search_not_in_plan" }, 402));
    await mount();
    await tick(450); await tick();
    expect(section()).toBeNull();
    expect(text()).toContain("report.pdf");
    expect(text()).not.toContain("In file contents");
  });

  it("keeps the No results line away while content may still match, and shows content-only hits", async () => {
    nameFiles = [];
    fetchMock.mockResolvedValue(json({ ok: true, files: [hit], partial: false }));
    await mount();
    expect(text()).not.toContain('No results for "rec"');
    await tick(450); await tick();
    expect(section()?.textContent).toContain("invoice-2024.pdf");
    expect(text()).not.toMatch(/No results for/);
  });

  it("shows No results once content search is out of the way (402) and nothing matched by name", async () => {
    nameFiles = [];
    fetchMock.mockResolvedValue(json({ ok: false }, 402));
    await mount();
    await tick(450); await tick();
    expect(text()).toContain('No results for "rec"');
  });

  describe("stale answers", () => {
    const hitA = { ...hit, id: "fa", name: "alpha-hit.pdf" };
    const hitB = { ...hit, id: "fb", name: "bravo-hit.pdf" };
    /** The first content request stays pending until `release` is called; every later one answers B at once. */
    function holdFirst() {
      let release!: () => void;
      const signals: AbortSignal[] = [];
      fetchMock.mockImplementation((_url: string, init?: { signal?: AbortSignal }) => {
        if (init?.signal) signals.push(init.signal);
        if (signals.length === 1) {
          // Ignores the abort on purpose, like a response already on the wire.
          return new Promise<Response>((resolve) => { release = () => resolve(json({ ok: true, files: [hitA], partial: false })); });
        }
        return Promise.resolve(json({ ok: true, files: [hitB], partial: false }));
      });
      return { signals, release: () => release() };
    }

    it("drops A's late answer after the query changes to B", async () => {
      const held = holdFirst();
      await mount("/search?q=alpha");
      await tick(450); await tick();
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(String(fetchMock.mock.calls[0][0])).toContain("q=alpha");

      await act(async () => { nav!("/search?q=bravo"); });
      // A's request was cancelled through its signal when the query changed.
      expect(held.signals[0].aborted).toBe(true);
      await tick(450); await tick();
      expect(String(fetchMock.mock.calls[1][0])).toContain("q=bravo");
      expect(section()?.textContent).toContain("bravo-hit.pdf");

      held.release();
      await tick(); await tick();
      expect(text()).not.toContain("alpha-hit.pdf");
      expect(section()?.textContent).toContain("bravo-hit.pdf");
    });

    it("drops A's late answer after the workspace changes", async () => {
      const held = holdFirst();
      await mount("/search?q=alpha");
      await tick(450); await tick();
      expect(String(fetchMock.mock.calls[0][0])).toContain("workspace_id=ws1");

      wsState.active = { id: "ws2", name: "Other" };
      // Re-render with the new workspace (same query).
      await act(async () => { nav!("/search?q=alpha", { replace: true, state: { ws: 2 } }); });
      expect(held.signals[0].aborted).toBe(true);
      await tick(450); await tick();
      expect(String(fetchMock.mock.calls[1][0])).toContain("workspace_id=ws2");
      expect(section()?.textContent).toContain("bravo-hit.pdf");

      held.release();
      await tick(); await tick();
      expect(text()).not.toContain("alpha-hit.pdf");
      expect(section()?.textContent).toContain("bravo-hit.pdf");
    });
  });

  it("does not run for a one-character query", async () => {
    await mount("/search?q=r");
    await tick(450);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(section()).toBeNull();
  });
});

describe("Search page result layout", () => {
  afterEach(() => { localStorage.removeItem("dosya_search_view"); });
  const imageHit = { ...hit, id: "f10", name: "IMG_0001.HEIC", mime_type: "image/heic", extension: "heic", snippet: "No text is present in the image.", page: null, source: "vector" as const };

  it("shows no text under an image hit, but keeps the snippet under a document", async () => {
    // The second image has no extension: the indexer went by its MIME type, so the page must too.
    const bareImage = { ...imageHit, id: "f11", name: "scan_0042", extension: null, mime_type: "image/png", snippet: "No text in image." };
    fetchMock.mockResolvedValue(json({ ok: true, files: [hit, imageHit, bareImage], partial: false }));
    await mount();
    await tick(450); await tick();
    const s = section()!;
    expect(s.textContent).toContain("IMG_0001.HEIC");
    expect(s.textContent).toContain("scan_0042");
    expect(s.textContent).not.toContain("No text is present");
    expect(s.textContent).not.toContain("No text in image");
    expect(s.textContent).toContain("Total due on receipt");
  });

  it("starts as a list, switches to tiles on the grid button, and remembers the choice", async () => {
    fetchMock.mockResolvedValue(json({ ok: true, files: [hit], partial: false }));
    await mount();
    await tick(450); await tick();
    expect(container!.querySelectorAll('[data-view="list"]').length).toBe(2);
    expect(container!.querySelector('[data-view="grid"]')).toBeNull();
    const list = container!.querySelector<HTMLButtonElement>('button[aria-label="List view"]')!;
    const grid = container!.querySelector<HTMLButtonElement>('button[aria-label="Grid view"]')!;
    expect(list.getAttribute("aria-pressed")).toBe("true");
    await act(async () => { grid.click(); });
    expect(grid.getAttribute("aria-pressed")).toBe("true");
    expect(container!.querySelectorAll('[data-view="grid"]').length).toBe(2);
    expect(container!.querySelector('[data-testid="file-tile"]')).not.toBeNull();
    expect(localStorage.getItem("dosya_search_view")).toBe("grid");
    // A fresh mount reads the saved choice back. (The name results are enough
    // to prove it: the content search dedupes a repeat of the same query.)
    act(() => root!.unmount()); root = null; container!.remove(); container = null;
    await mount();
    await tick(450); await tick();
    expect(container!.querySelectorAll('[data-view="grid"]').length).toBeGreaterThanOrEqual(1);
    expect(container!.querySelector('[data-view="list"]')).toBeNull();
  });
});
