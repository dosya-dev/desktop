// apps/desktop/src/renderer/components/settings/AiSearchSection.test.tsx
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const get = vi.fn();
const put = vi.fn();
vi.mock("@/lib/api-client", async (orig) => ({
  ...(await orig<typeof import("@/lib/api-client")>()),
  api: { get: (p: string) => get(p), put: (p: string, b: unknown) => put(p, b), post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
  apiBase: () => "https://api.test",
}));
const toast = { success: vi.fn(), error: vi.fn() };
vi.mock("sonner", () => ({ toast }));
// The picker virtualises its rows against a scroll element jsdom cannot size;
// render every row instead (as ArchiveViewer.test.tsx does).
vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: (opts: { count: number }) => ({
    getTotalSize: () => opts.count * 36,
    getVirtualItems: () => Array.from({ length: opts.count }, (_, i) => ({ key: i, index: i, start: i * 36 })),
  }),
}));

const { AiSearchSection } = await import("./AiSearchSection");
const { ApiError } = await import("@/lib/api-client");

const LIMITS = { vectorBudget: 1, imagesMax: 100, documentsMax: 100, docChunksMax: 1, backfillUnits: 1, monthUnits: 1 };
function status(limits: typeof LIMITS | null = LIMITS) {
  return { files_total: 0, indexed: 0, pending: 0, partial: 0, unsupported: 0, capped: 0, failed: 0, images: 0, documents: 0, chunks: 0, limits, backfill_units_remaining: 1, month_units_remaining: 1, month_reset_at: null, estimated_finish_at: null, paused: false };
}
const TREE = { ok: true, folders: [
  { id: "d1", name: "Photos", parent_id: null, file_count: 2 },
  { id: "d2", name: "Private", parent_id: null, file_count: 1 },
] };
let settingsResp: Record<string, unknown>;
function answer(settings: Partial<{ enabled: boolean; index_existing: boolean; excluded_folders: string[] }> = {}, opts: { limits?: typeof LIMITS | null; can_edit?: boolean } = {}) {
  settingsResp = {
    ok: true,
    settings: { enabled: false, index_existing: true, excluded_folders: [], ...settings },
    status: status(opts.limits === undefined ? LIMITS : opts.limits),
    can_edit: opts.can_edit ?? true,
  };
}

beforeAll(() => { (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true; });
let root: Root | null = null; let container: HTMLDivElement | null = null;
beforeEach(() => {
  get.mockReset(); put.mockReset(); toast.success.mockReset(); toast.error.mockReset();
  get.mockImplementation(async (p: string) => (p.startsWith("/api/folders/tree") ? TREE : settingsResp));
  // The fake server keeps what was PUT, so the refetch after a save sees it.
  put.mockImplementation(async (_p: string, body: Record<string, unknown>) => {
    settingsResp = { ...settingsResp, settings: { ...(settingsResp.settings as object), ...body } };
    return { ok: true, settings: settingsResp.settings };
  });
});
afterEach(() => { if (root) act(() => root!.unmount()); container?.remove(); root = null; container = null; });

const flush = async () => { for (let i = 0; i < 6; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
async function mount() {
  container = document.createElement("div"); document.body.appendChild(container);
  root = createRoot(container);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => { root!.render(<QueryClientProvider client={qc}><MemoryRouter><AiSearchSection wsId="ws1" /></MemoryRouter></QueryClientProvider>); });
  await flush();
}
const text = () => document.body.textContent ?? "";
const sw = () => document.body.querySelector<HTMLButtonElement>('[role="switch"]')!;
const checkbox = () => document.body.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
const button = (label: string) => [...document.body.querySelectorAll("button")].find((b) => b.textContent?.trim() === label);
const click = async (el: Element) => { await act(async () => { (el as HTMLElement).click(); }); await flush(); };

describe("AiSearchSection", () => {
  it("renders the off state with the copy and no dashboard link", async () => {
    answer();
    await mount();
    expect(get).toHaveBeenCalledWith("/api/workspaces/ws1/ai-search");
    expect(text()).toContain("Finds files by what they are about");
    expect(text()).toContain("Search inside files and photos");
    expect(text()).toContain("Also index existing files");
    expect(text()).toContain("Exclude folders");
    expect(sw().getAttribute("aria-checked")).toBe("false");
    expect(sw().disabled).toBe(false);
    expect(checkbox().checked).toBe(true);
    expect(text()).not.toContain("See indexing status on the dashboard");
    // No excluded folders: the tree is not fetched.
    expect(get.mock.calls.some(([p]) => p.startsWith("/api/folders/tree"))).toBe(false);
  });

  it("disables the switch with the paid-plans text and See plans when limits are null", async () => {
    answer({}, { limits: null });
    await mount();
    expect(sw().disabled).toBe(true);
    expect(text()).toContain("AI search is available on paid plans");
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    await click(button("See plans")!);
    expect(open).toHaveBeenCalledWith("https://app.dosya.dev/billing", "_blank");
    open.mockRestore();
  });

  it("keeps the switch usable to turn OFF after a downgrade", async () => {
    answer({ enabled: true }, { limits: null });
    await mount();
    expect(sw().disabled).toBe(false);
  });

  it("toggling the switch PUTs { enabled: true } and shows the dashboard link", async () => {
    answer();
    await mount();
    await click(sw());
    expect(put).toHaveBeenCalledWith("/api/workspaces/ws1/ai-search", { enabled: true });
    expect(toast.success).toHaveBeenCalledWith("Settings updated");
    expect(sw().getAttribute("aria-checked")).toBe("true");
    const link = [...document.body.querySelectorAll("a")].find((a) => a.textContent === "See indexing status on the dashboard");
    expect(link?.getAttribute("href")).toBe("/dashboard");
  });

  it("explains a plan refusal in the error toast", async () => {
    answer();
    put.mockRejectedValueOnce(new ApiError("ai_search_not_in_plan", 402, { ok: false, error: "ai_search_not_in_plan" }));
    await mount();
    await click(sw());
    expect(toast.error).toHaveBeenCalledWith("Failed to save", { description: "AI search is available on paid plans" });
  });

  it("can_edit false shows the permission text and disables every control", async () => {
    answer({ excluded_folders: ["d1"] }, { can_edit: false });
    await mount();
    expect(text()).toContain("You don't have permission to change AI search");
    expect(sw().disabled).toBe(true);
    expect(checkbox().disabled).toBe(true);
    expect(button("Add folder")!.disabled).toBe(true);
    expect(document.body.querySelector<HTMLButtonElement>('button[aria-label="Remove"]')!.disabled).toBe(true);
  });

  it("the checkbox PUTs index_existing", async () => {
    answer();
    await mount();
    await click(checkbox());
    expect(put).toHaveBeenCalledWith("/api/workspaces/ws1/ai-search", { index_existing: false });
  });

  it("names excluded folders and removing one PUTs the shorter list", async () => {
    answer({ excluded_folders: ["d1", "gone"] });
    await mount();
    expect(text()).toContain("Photos");
    expect(text()).toContain("Unknown folder");
    const remove = document.body.querySelectorAll<HTMLButtonElement>('button[aria-label="Remove"]');
    await click(remove[0]);
    expect(put).toHaveBeenCalledWith("/api/workspaces/ws1/ai-search", { excluded_folders: ["gone"] });
  });

  it("Add folder picks a folder in the picker and PUTs the longer list, without offering excluded ones", async () => {
    answer({ excluded_folders: ["d1"] });
    await mount();
    await click(button("Add folder")!);
    // Picker title + confirm share the copy; the excluded folder is not listed.
    const rowNames = [...document.body.querySelectorAll(".fixed button span")].map((s) => s.textContent);
    expect(rowNames).toContain("Private");
    expect(rowNames).not.toContain("Photos");
    const row = [...document.body.querySelectorAll(".fixed button")].find((b) => b.textContent === "Private")!;
    await click(row);
    const confirm = [...document.body.querySelectorAll(".fixed button")].filter((b) => b.textContent === "Add folder").pop()!;
    await click(confirm);
    expect(put).toHaveBeenCalledWith("/api/workspaces/ws1/ai-search", { excluded_folders: ["d1", "d2"] });
  });
});
