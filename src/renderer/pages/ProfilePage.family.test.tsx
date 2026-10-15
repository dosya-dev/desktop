// apps/desktop/src/renderer/pages/ProfilePage.family.test.tsx
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const getFamily = vi.fn();
vi.mock("@/lib/family-api", async (orig) => ({ ...(await orig<typeof import("@/lib/family-api")>()), getFamily: () => getFamily() }));
vi.mock("@/components/family/FamilySection", () => ({ FamilySection: ({ showWebLink }: { showWebLink: boolean }) => <div data-testid="family-section" data-weblink={String(showWebLink)} /> }));
const distribution = { value: "direct" as "direct" | "mas" };
vi.mock("../lib/use-distribution", () => ({ useDistribution: () => distribution.value }));
vi.mock("@/lib/auth-context", () => ({ useAuth: () => ({ user: { id: "u1", name: "Me", email: "me@x.test" }, refreshUser: vi.fn() }) }));
vi.mock("@/lib/api-client", async (orig) => ({ ...(await orig<typeof import("@/lib/api-client")>()), api: { get: vi.fn(async () => ({ ok: true, sessions: [], keys: [] })), post: vi.fn(), put: vi.fn(), patch: vi.fn(), delete: vi.fn() }, apiBase: () => "https://api.test" }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const { ProfilePage } = await import("./ProfilePage");

beforeAll(() => { (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true; });
let qc: QueryClient;
let root: Root | null = null; let container: HTMLDivElement | null = null;
beforeEach(() => { (window as unknown as { electronAPI: unknown }).electronAPI = new Proxy({ getApiBase: async () => "https://api.test" }, { get: (o, k) => (k in o ? (o as Record<string | symbol, unknown>)[k] : async () => null) }); getFamily.mockReset(); distribution.value = "direct"; });
afterEach(() => { if (root) act(() => root!.unmount()); container?.remove(); root = null; container = null; });

const pool = { used_bytes: 1, limit_bytes: 2, used_label: "1 GB", limit_label: "2 GB" };
async function mount() {
  container = document.createElement("div"); document.body.appendChild(container);
  root = createRoot(container);
  qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => { root!.render(<QueryClientProvider client={qc}><MemoryRouter><ProfilePage /></MemoryRouter></QueryClientProvider>); });
  for (let i = 0; i < 6; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}
const familyTab = () => [...document.body.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Family");

describe("Profile Family tab", () => {
  it("is hidden for a free user with no family", async () => {
    getFamily.mockResolvedValue({ ok: true, role: "none", limit: 5, eligible: false, ineligible_reason: "free_plan", pool, plan: { id: "free", name: "Free" }, payer: null, members: [] });
    await mount();
    expect(familyTab()).toBeUndefined();
  });

  it("shows for a payer and opens the section with the web link allowed on the direct build", async () => {
    getFamily.mockResolvedValue({ ok: true, role: "payer", limit: 5, eligible: true, ineligible_reason: null, pool, plan: { id: "pro", name: "Pro" }, payer: null, members: [] });
    await mount();
    await act(async () => { familyTab()!.click(); });
    expect(document.body.querySelector('[data-testid="family-section"]')?.getAttribute("data-weblink")).toBe("true");
  });

  it("shows on the Mac App Store build for a member, with the web link disallowed", async () => {
    distribution.value = "mas";
    getFamily.mockResolvedValue({ ok: true, role: "member", limit: 5, eligible: false, ineligible_reason: "is_member", pool, plan: { id: "pro", name: "Pro" }, payer: { name: "A" }, members: null });
    await mount();
    await act(async () => { familyTab()!.click(); });
    expect(document.body.querySelector('[data-testid="family-section"]')?.getAttribute("data-weblink")).toBe("false");
  });

  it("falls back to Identity when the Family tab disappears while it is open", async () => {
    getFamily.mockResolvedValue({ ok: true, role: "payer", limit: 5, eligible: true, ineligible_reason: null, pool, plan: { id: "pro", name: "Pro" }, payer: null, members: [] });
    await mount();
    await act(async () => { familyTab()!.click(); });
    expect(document.body.querySelector('[data-testid="family-section"]')).not.toBeNull();
    expect([...document.body.querySelectorAll("h2")].some((h) => h.textContent === "Identity")).toBe(false);

    getFamily.mockResolvedValue({ ok: true, role: "none", limit: 5, eligible: false, ineligible_reason: "free_plan", pool, plan: { id: "free", name: "Free" }, payer: null, members: [] });
    await act(async () => { await qc.invalidateQueries({ queryKey: ["family"] }); });
    for (let i = 0; i < 6; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });

    expect(document.body.querySelector('[data-testid="family-section"]')).toBeNull();
    expect(familyTab()).toBeUndefined();
    expect([...document.body.querySelectorAll("h2")].some((h) => h.textContent === "Identity")).toBe(true);
  });
});
