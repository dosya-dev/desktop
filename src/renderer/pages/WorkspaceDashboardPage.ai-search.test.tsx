// apps/desktop/src/renderer/pages/WorkspaceDashboardPage.ai-search.test.tsx
//
// The account workspace dashboard's AI search card (donut + pool meters) and
// the per-row AI index lines, all from one GET /api/me/ai-search.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const get = vi.fn();
vi.mock("@/lib/api-client", async (orig) => ({
  ...(await orig<typeof import("@/lib/api-client")>()),
  api: { get: (p: string) => get(p), put: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
  apiBase: () => "https://api.test",
}));
vi.mock("@/lib/workspace-context", () => ({
  useWorkspace: () => ({ active: { id: "ws1", name: "Team" }, workspaces: [{ id: "ws1", name: "Team" }], setActive: () => {} }),
}));

const { WorkspaceDashboardPage } = await import("./WorkspaceDashboardPage");

const DASH = {
  ok: true, total: { limit_bytes: 1e10, used_bytes: 3e9, free_bytes: 7e9 },
  sources: [{ kind: "plan", label: "Pro", bytes: 1e10, meta: {} }],
  owned: [
    { id: "ws1", name: "Team", icon_initials: "T", icon_color: "#3b82f6", icon_image_url: null, used_bytes: 2e9, share_pct: 20 },
    { id: "ws2", name: "Photos", icon_initials: "P", icon_color: "#22c55e", icon_image_url: null, used_bytes: 1e9, share_pct: 10 },
    { id: "ws3", name: "Archive", icon_initials: "A", icon_color: "#f97316", icon_image_url: null, used_bytes: 0, share_pct: 0 },
    { id: "ws4", name: "Limited", icon_initials: "L", icon_color: "#f97316", icon_image_url: null, used_bytes: 0, share_pct: 0 },
  ],
  shared: [],
};
const LIMITS = { vectorBudget: 1, imagesMax: 2000, documentsMax: 1000, docChunksMax: 1, backfillUnits: 5000, monthUnits: 1000 };
const POOL = {
  limits: LIMITS as typeof LIMITS | null, backfill_units_remaining: 4000, backfill_units_total: 5000,
  month_units_remaining: 750, month_units_total: 1000, month_reset_at: Date.UTC(2026, 10, 1) / 1000, payer_is_family: false, paused: false,
};
const aiWs = (id: string, name: string, images: number, documents: number, extra: Record<string, unknown> = {}) => ({
  id, name, enabled: true, indexed: images + documents, pending: 0, images, documents, images_max: 2000, documents_max: 1000, paused_reason: null, ...extra,
});
let ai: unknown;

beforeAll(() => { (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true; });
let root: Root | null = null; let container: HTMLDivElement | null = null;
beforeEach(() => {
  ai = {
    ok: true, pool: POOL,
    workspaces: [aiWs("ws1", "Team", 1, 2), aiWs("ws2", "Photos", 30, 0), aiWs("ws3", "Archive", 0, 0, { enabled: false }), aiWs("ws4", "Limited", 5, 5, { paused_reason: "limit" })],
  };
  get.mockReset();
  get.mockImplementation(async (p: string) => {
    if (p === "/api/workspace-dashboard") return DASH;
    if (p === "/api/me/ai-search") return ai;
    throw new Error(`unexpected ${p}`);
  });
});
afterEach(() => { if (root) act(() => root!.unmount()); container?.remove(); root = null; container = null; });

async function mount() {
  container = document.createElement("div"); document.body.appendChild(container);
  root = createRoot(container);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root!.render(<QueryClientProvider client={qc}><MemoryRouter><WorkspaceDashboardPage /></MemoryRouter></QueryClientProvider>);
  });
  for (let i = 0; i < 6; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}
const card = () => container!.querySelector('[data-testid="workspaces-ai-search"]');
const lines = () => [...container!.querySelectorAll('[data-testid="ws-ai-line"]')].map((l) => l.textContent);

describe("Workspace dashboard AI search", () => {
  it("renders the pool card with the donut and meters, and a line per owned workspace, from one request", async () => {
    await mount();
    expect(get.mock.calls.filter(([p]) => p === "/api/me/ai-search")).toHaveLength(1);
    const c = card()!;
    expect(c).not.toBeNull();
    expect(c.querySelector('[data-testid="ai-index-donut"]')).not.toBeNull();
    expect(c.querySelectorAll('[data-testid="ai-donut-slice"]')).toHaveLength(3);
    expect(c.querySelector('[data-testid="ai-donut-total"]')?.textContent).toBe("43");
    expect(c.textContent).toContain("Backfill remaining");
    expect(c.textContent).toContain("4,000 of 5,000");
    expect(c.textContent).toContain("This month");
    expect(c.textContent).toContain("250 of 1,000");
    expect(c.textContent).toMatch(/Resets (October 31|November 1), 2026/);
    expect(c.querySelector('[data-testid="ai-family-pool"]')).toBeNull();
    expect(lines()).toEqual([
      "AI index: 1 image · 2 documentsIndexing",
      "AI index: 30 images · 0 documentsIndexing",
      "AI search off",
      "AI index: 5 images · 5 documentsPaused: limit reached",
    ]);
  });

  it("marks every row paused by dosya and shows the family badge", async () => {
    ai = { ...(ai as object), pool: { ...POOL, paused: true, payer_is_family: true } };
    await mount();
    expect(card()!.textContent).toContain("Paused by dosya");
    expect(card()!.querySelector('[data-testid="ai-family-pool"]')?.textContent).toBe("Family pool");
    const states = [...container!.querySelectorAll('[data-testid="ws-ai-state"]')].map((s) => s.textContent);
    expect(states).toEqual(["Paused by dosya", "Paused by dosya", "Paused by dosya"]);
  });

  it("hides the card and every line when the plan has no AI search", async () => {
    ai = { ...(ai as object), pool: { ...POOL, limits: null } };
    await mount();
    expect(container!.textContent).toContain("Team");
    expect(card()).toBeNull();
    expect(lines()).toEqual([]);
  });

  it("hides the AI parts when the request fails, keeping the storage view", async () => {
    get.mockImplementation(async (p: string) => {
      if (p === "/api/workspace-dashboard") return DASH;
      throw new Error("offline");
    });
    await mount();
    expect(container!.textContent).toContain("Photos");
    expect(card()).toBeNull();
    expect(lines()).toEqual([]);
  });
});
