// apps/desktop/src/renderer/components/dashboard/AiSearchCard.test.tsx
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const get = vi.fn();
vi.mock("@/lib/api-client", async (orig) => ({
  ...(await orig<typeof import("@/lib/api-client")>()),
  api: { get: (p: string) => get(p), put: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
  apiBase: () => "https://api.test",
}));

const { AiSearchCard } = await import("./AiSearchCard");

const LIMITS = { vectorBudget: 22000, imagesMax: 2000, documentsMax: 1000, docChunksMax: 20000, backfillUnits: 5000, monthUnits: 1000 };
const STATUS = {
  files_total: 40, indexed: 1234, pending: 6, partial: 2, unsupported: 1, capped: 0, failed: 1, images: 120, documents: 1000, chunks: 300,
  limits: LIMITS as typeof LIMITS | null, backfill_units_remaining: 100, month_units_remaining: 100, month_reset_at: null,
  estimated_finish_at: null, paused: false,
};
const OFF = { ok: true, settings: { enabled: false, index_existing: true, excluded_folders: [] as string[] }, status: STATUS, can_edit: true };
const ON = { ...OFF, settings: { ...OFF.settings, enabled: true } };
let response: unknown = OFF;

beforeAll(() => { (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true; });
let root: Root | null = null; let container: HTMLDivElement | null = null;
beforeEach(() => {
  response = OFF;
  get.mockReset();
  get.mockImplementation(async (p: string) => {
    if (p === "/api/workspaces/ws1/ai-search") return response;
    throw new Error(`unexpected ${p}`);
  });
});
afterEach(() => { if (root) act(() => root!.unmount()); container?.remove(); root = null; container = null; });

function Where() { const l = useLocation(); return <div data-testid="where">{l.pathname + l.search}</div>; }

async function mount() {
  container = document.createElement("div"); document.body.appendChild(container);
  root = createRoot(container);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root!.render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={["/dashboard"]}>
          <Routes><Route path="*" element={<><AiSearchCard wsId="ws1" /><Where /></>} /></Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
  for (let i = 0; i < 6; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}
const card = () => container!.querySelector('[data-testid="dashboard-ai-search"]');
const button = (label: string) => [...container!.querySelectorAll("button")].find((b) => b.textContent === label);

describe("Dashboard AI search card", () => {
  it("offers Turn on to an editor while AI search is off, and it opens Settings > AI search", async () => {
    await mount();
    expect(card()?.textContent).toContain("Search inside documents and photos, not just file names.");
    expect(button("Manage")).toBeUndefined();
    await act(async () => { button("Turn on")!.click(); });
    expect(container!.querySelector('[data-testid="where"]')?.textContent).toBe("/settings?tab=ai-search");
  });

  it("hides Turn on from a member who cannot change it", async () => {
    response = { ...OFF, can_edit: false };
    await mount();
    expect(card()).not.toBeNull();
    expect(button("Turn on")).toBeUndefined();
  });

  it("shows counts and the image / document bars while on", async () => {
    response = ON;
    await mount();
    const text = card()!.textContent!;
    expect(text).toContain("Indexed");
    expect(text).toContain("1,234");
    expect(text).toContain("Waiting");
    expect(text).toContain("120 of 2,000");
    expect(text).toContain("1,000 of 1,000");
    const bars = [...card()!.querySelectorAll('[role="progressbar"]')];
    expect(bars.map((b) => [b.getAttribute("aria-label"), b.getAttribute("aria-valuenow"), b.getAttribute("aria-valuemax")])).toEqual([
      ["Images", "120", "2000"], ["Documents", "1000", "1000"],
    ]);
    expect(button("Manage")).toBeDefined();
    // The document budget is full, so indexing reports the plan limit.
    expect(card()!.querySelector('[role="status"]')?.textContent).toBe("Paused: limit reached");
  });

  it("names a platform pause before a plan limit", async () => {
    response = { ...ON, status: { ...STATUS, paused: true } };
    await mount();
    expect(card()!.querySelector('[role="status"]')?.textContent).toBe("Paused by dosya");
  });

  it("renders nothing when the plan has no AI search", async () => {
    response = { ...ON, status: { ...STATUS, limits: null } };
    await mount();
    expect(card()).toBeNull();
  });

  it("renders nothing when the request fails", async () => {
    get.mockImplementation(async () => { throw new Error("offline"); });
    await mount();
    expect(card()).toBeNull();
  });
});
