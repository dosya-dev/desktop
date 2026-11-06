// apps/desktop/src/renderer/components/layout/Sidebar.personas.test.tsx
//
// The Personas row of the Files group: after Images and before Shared files,
// shown to every signed-in member whose role may see files (Personas runs on
// each member's own devices and is free on every plan, so nothing is asked of
// a server), lit on /personas, its settings and its persona pages, with no
// New badge. Mirrors the Personas cases of
// apps/web/src/components/files-sidebar.test.tsx.
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
const WS1 = { id: "ws_1", name: "Family photos", slug: "family", icon_initials: "FP", icon_color: "#0e7490", icon_image_url: null, owner_id: "u1" };
const WS2 = { ...WS1, id: "ws_2", name: "Work", slug: "work", icon_initials: "W" };
const wsState = vi.hoisted(() => ({ active: null as unknown as { id: string; name: string } }));
vi.mock("@/lib/workspace-context", () => ({
  useWorkspace: () => ({ workspaces: [WS1, WS2], active: wsState.active, setActive: () => {}, isLoading: false, isError: false, refetch: () => {} }),
}));
vi.mock("@/lib/auth-context", () => ({
  useAuth: () => ({ user: { id: "u1", name: "Alex Walker", email: "alex@example.com", avatar_url: null }, logout: () => {} }),
}));
const perms = vi.hoisted(() => ({ value: { access_files: true } as Record<string, boolean> | undefined }));
vi.mock("@/lib/use-permissions", () => ({
  usePermissions: () => ({
    permissions: perms.value,
    can: (p: string) => (perms.value ? perms.value[p] ?? false : true),
    userId: "u1", roleId: "r1", roleName: null, rootFolderId: null, rootFolderName: null,
  }),
}));
vi.mock("@/lib/use-narrow-window", () => ({ useNarrowWindow: () => false }));
vi.mock("@/lib/support-chat/store", () => ({ useSupportChat: (sel: (s: { unread: number }) => unknown) => sel({ unread: 0 }) }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const { Sidebar } = await import("./Sidebar");
const { setPersonasUser } = await import("@/lib/personas-device/teardown");

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  // The sliding active pill re-measures on resize; jsdom has no ResizeObserver.
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    getPlatform: async () => "darwin",
    getApiBase: async () => "https://api.test",
  };
});

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeEach(() => {
  localStorage.clear();
  // The Files tree is shut on first run; the rows under test live inside it.
  localStorage.setItem("dosya_sidebar_files_open", "1");
  setPersonasUser("u1");
  wsState.active = WS1;
  perms.value = { access_files: true };
  get.mockReset();
  get.mockImplementation(async (p: string) => {
    if (p.startsWith("/api/dashboard")) return { ok: true, stats: { total_bytes: 0, storage_cap_bytes: 1 } };
    throw new Error(`unexpected ${p}`);
  });
});
afterEach(() => {
  if (root) act(() => root!.unmount());
  container?.remove();
  root = null; container = null;
  setPersonasUser(null);
});

const flush = async () => { for (let i = 0; i < 6; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };

function tree(path: string, qc: QueryClient) {
  return (
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[path]}>
        <Sidebar />
      </MemoryRouter>
    </QueryClientProvider>
  );
}

let qc: QueryClient;
let path = "/files";
async function mount(at = "/files") {
  path = at;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => { root!.render(tree(path, qc)); });
  await flush();
}
/** Re-render the same tree (a context change, such as a workspace switch). */
async function rerender() {
  await act(async () => { root!.render(tree(path, qc)); });
  await flush();
}

const rows = () => [...container!.querySelectorAll<HTMLButtonElement>('nav button[data-testid^="nav-files-"]')].filter((b) => b.dataset.testid !== "nav-files-toggle");
const rowLabels = () => rows().map((b) => b.querySelector("span.truncate")?.textContent?.trim());
const personasRow = () => container!.querySelector<HTMLButtonElement>('[data-testid="nav-files-personas"]');
const isActive = (b: HTMLButtonElement | null) => b?.hasAttribute("data-active") ?? false;
const personasAsked = () => get.mock.calls.some(([p]) => String(p).includes("personas"));

describe("Sidebar Personas row", () => {
  it("shows the row for every signed-in member who may see files, asking no server", async () => {
    await mount();
    expect(rowLabels()).toContain("Personas");
    expect(personasAsked()).toBe(false);
  });

  it("shows no row for a role without access_files", async () => {
    perms.value = { access_files: false };
    await mount("/file-requests");
    expect(rowLabels()).not.toContain("Personas");
  });

  it("shows no row while the permissions have not answered", async () => {
    perms.value = undefined;
    await mount();
    expect(rowLabels()).not.toContain("Personas");
  });

  it("renders Personas between Images and Shared files", async () => {
    await mount();
    const labels = rowLabels();
    const at = labels.indexOf("Personas");
    expect(at).toBeGreaterThan(0);
    expect(labels[at - 1]).toBe("Images");
    expect(labels[at + 1]).toBe("Shared files");
  });

  it("is active on /personas, its settings and a persona page, and nowhere else", async () => {
    for (const at of ["/personas", "/personas/settings", "/personas/p1"]) {
      await mount(at);
      expect(isActive(personasRow()), at).toBe(true);
      await act(async () => root!.unmount());
      container!.remove();
    }
    await mount("/files");
    expect(isActive(personasRow())).toBe(false);
  });

  it("wears no New badge", async () => {
    await mount();
    expect(personasRow()!.textContent?.trim()).toBe("Personas");
  });

  it("stays through a workspace switch without asking anything", async () => {
    await mount();
    wsState.active = WS2;
    await rerender();
    expect(rowLabels()).toContain("Personas");
    expect(personasAsked()).toBe(false);
  });
});
