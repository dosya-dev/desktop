// apps/desktop/src/renderer/pages/SettingsPage.personas.test.tsx
//
// Workspace Settings has no Personas tab: Personas settings are each member's
// own (on their own devices) and live on /personas/settings, reached from
// People. Mirrors apps/web/src/pages/settings.personas-gate.test.tsx.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const get = vi.fn();
vi.mock("@/lib/api-client", async (orig) => ({
  ...(await orig<typeof import("@/lib/api-client")>()),
  api: { get: (p: string) => get(p), put: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
  apiRequest: vi.fn(),
  apiBase: () => "https://api.test",
}));
vi.mock("@/lib/workspace-context", () => ({
  useWorkspace: () => ({ active: { id: "ws1", name: "Family photos" }, workspaces: [{ id: "ws1", name: "Family photos" }], setActive: () => {}, isLoading: false, isError: false, refetch: () => {} }),
}));
vi.mock("@/lib/use-permissions", () => ({
  usePermissions: () => ({ can: () => true, permissions: { access_files: true }, userId: "u1", roleId: null, roleName: null, rootFolderId: null, rootFolderName: null }),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const { SettingsPage } = await import("./SettingsPage");

const WORKSPACE = {
  ok: true,
  workspace: { id: "ws1", name: "Family photos", slug: "family", icon_initials: "FP", icon_color: "#0e7490", icon_image_url: null },
  // A non-zero file size limit: the page seeds its form from it during render
  // (`maxFileSize === 0` means "not yet"), as the real API answers.
  settings: { max_file_size_gb: 5, max_total_storage_gb: 100, max_storage_per_member_gb: 10, max_concurrent_uploads: 4, allowed_extensions: null, blocked_extensions: null, require_2fa: 0, disable_share_links: 0, force_share_password: 0, share_max_expiry_days: null },
};
const AI = { ok: true, settings: { enabled: false, index_existing: true, excluded_folders: [] }, status: { limits: null }, can_edit: true };

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  // The General tab's icon uploader asks the main process for the API base.
  (window as unknown as { electronAPI: unknown }).electronAPI = { getApiBase: () => Promise.resolve("https://api.test") };
});
let root: Root | null = null; let container: HTMLDivElement | null = null;
let scrolled: Element[] = [];
beforeEach(() => {
  scrolled = [];
  // jsdom has no layout: record which element asked to be scrolled into view.
  Element.prototype.scrollIntoView = function (this: Element) { scrolled.push(this); };
  get.mockReset();
  get.mockImplementation((p: string) => {
    if (p === "/api/workspaces/ws1") return Promise.resolve(WORKSPACE);
    if (p === "/api/workspaces/ws1/ai-search") return Promise.resolve(AI);
    return Promise.reject(new Error(`unexpected ${p}`));
  });
  localStorage.clear();
});
afterEach(() => { if (root) act(() => root!.unmount()); container?.remove(); root = null; container = null; });

const flush = async () => { for (let i = 0; i < 6; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
async function mount(path = "/settings") {
  container = document.createElement("div"); document.body.appendChild(container);
  root = createRoot(container);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root!.render(<QueryClientProvider client={qc}><MemoryRouter initialEntries={[path]}><SettingsPage /></MemoryRouter></QueryClientProvider>);
  });
  await flush();
}
const tabs = () => [...container!.querySelectorAll<HTMLButtonElement>('[data-testid="settings-tabs"] button')].map((b) => b.textContent?.trim());
const tabButton = (label: string) => [...container!.querySelectorAll<HTMLButtonElement>('[data-testid="settings-tabs"] button')].find((b) => b.textContent?.trim() === label);
const click = async (el: Element | null | undefined) => { expect(el).toBeTruthy(); await act(async () => { (el as HTMLElement).click(); }); await flush(); };

describe("Settings: no Personas tab", () => {
  it("lists no Personas tab and asks nothing about Personas", async () => {
    await mount();
    expect(tabs()).toContain("AI search");
    expect(tabs()).not.toContain("Personas");
    expect(container!.querySelector("#personas")).toBeNull();
    expect(get.mock.calls.filter(([p]) => String(p).includes("personas"))).toEqual([]);
  });

  it("an old /settings#personas or ?tab=personas link lands on General", async () => {
    await mount("/settings#personas");
    expect(container!.querySelector("#personas")).toBeNull();
    expect(scrolled).toEqual([]);
    act(() => root!.unmount()); container!.remove(); root = null;
    await mount("/settings?tab=personas");
    expect(tabButton("General")).toBeTruthy();
    expect(container!.querySelector("#personas")).toBeNull();
  });
});
