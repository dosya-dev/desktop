// apps/desktop/src/renderer/pages/SearchPage.persons.test.tsx
//
// People on the search page (the desktop's counterpart of the web global
// search's People group): typing a name offers the named people whose name
// starts with it, found by this device's engine (engine.findByName, nothing
// sent anywhere); each row says "Go to person" and opens the persona page.
// The server person filter is gone: an old `person=` link is a plain search,
// and content search never sends a person.
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
const wsState = vi.hoisted(() => ({ active: { id: "ws1", name: "Team" } }));
vi.mock("@/lib/workspace-context", () => ({
  useWorkspace: () => ({ active: wsState.active, workspaces: [wsState.active], setActive: () => {} }),
}));
vi.mock("@/lib/personas-device/engine-host", () => import("@/lib/personas-device/__fixtures__/fake-host"));

const { SearchPage } = await import("./SearchPage");
const { resetContentSearchState } = await import("@/lib/ai-search");
const { fakeHost, card } = await import("@/lib/personas-device/__fixtures__/fake-host");
const { setPersonasUser } = await import("@/lib/personas-device/teardown");

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

let permissions: Record<string, boolean> = { access_files: true };
const myPermissions = () => ({ ok: true, user_id: "u1", role_id: "r1", role_name: null, is_builtin: true, root_folder_id: null, root_folder_name: null, permissions });

let fetchMock: ReturnType<typeof vi.fn>;
let root: Root | null = null;
let container: HTMLDivElement | null = null;
let location = "";

function Where() {
  const here = useLocation();
  location = `${here.pathname}${here.search}`;
  return null;
}

beforeAll(() => { (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true; });
beforeEach(() => {
  resetContentSearchState();
  setPersonasUser("u1");
  fakeHost.reset();
  fakeHost.engine.personas = [
    card("p1", "Emma", { photo_count: 412 }),
    card("p2", "Leo", { photo_count: 248 }),
    card("p3", null, { photo_count: 5 }),
  ];
  permissions = { access_files: true };
  wsState.active = { id: "ws1", name: "Team" };
  get.mockReset();
  get.mockImplementation(async (path: string) => {
    if (path.startsWith("/api/me/permissions?")) return myPermissions();
    if (path.startsWith("/api/search?")) return { ok: true, query: "", files: [], folders: [], shared: [], file_requests: [] };
    throw new Error(`unexpected ${path}`);
  });
  fetchMock = vi.fn(async () => json(200, { ok: true, files: [], partial: false }));
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  if (root) act(() => root!.unmount());
  container?.remove(); root = null; container = null;
  vi.unstubAllGlobals();
  setPersonasUser(null);
});

const tick = async (ms = 0) => { await act(async () => { await new Promise((r) => setTimeout(r, ms)); }); };
let qc: QueryClient;
async function mount(url: string) {
  container = document.createElement("div"); document.body.appendChild(container);
  root = createRoot(container);
  qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root!.render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={[url]}>
          <Routes><Route path="*" element={<><SearchPage /><Where /></>} /></Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
  for (let i = 0; i < 6; i++) await tick();
}
const people = () => container!.querySelector("[data-people-suggestions]");
const click = async (el: Element | null | undefined) => { expect(el).toBeTruthy(); await act(async () => { (el as HTMLElement).click(); }); for (let i = 0; i < 6; i++) await tick(); };

describe("SearchPage people", () => {
  it('typing a name offers the matching people from this device, each with "Go to person", and picking one opens the persona page', async () => {
    await mount("/search?q=Em");
    await tick(300);
    await tick();
    expect(fakeHost.engine.findByName).toHaveBeenCalledWith("Em", 5);
    const row = people()!;
    expect(row.textContent).toContain("People");
    const emma = [...row.querySelectorAll("button")].find((b) => b.textContent?.includes("Emma"))!;
    expect(emma.textContent).toContain("Go to person");
    expect(row.textContent).not.toContain("Leo");
    await click(emma);
    expect(location).toBe("/personas/p1");
  });

  it("shows nothing while Personas is off or locked on this device", async () => {
    fakeHost.set({ status: { state: "needs_unlock" } });
    await mount("/search?q=Em");
    await tick(300);
    expect(fakeHost.engine.findByName).not.toHaveBeenCalled();
    expect(people()).toBeNull();
  });

  it("shows nothing when nobody matches", async () => {
    await mount("/search?q=Zed");
    await tick(300);
    expect(people()).toBeNull();
  });

  it("asks nothing about Personas for a role that may not see files", async () => {
    permissions = { access_files: false };
    await mount("/search?q=Em");
    await tick(300);
    await tick();
    expect(fakeHost.engine.findByName).not.toHaveBeenCalled();
    expect(people()).toBeNull();
  });

  it("never sends a person to the server: an old person= link is a plain search", async () => {
    await mount("/search?person=p1&q=beach");
    await tick(500);
    await tick();
    expect(container!.querySelector('[data-testid="search-page"] input')).toBeTruthy();
    const urls = [...get.mock.calls.map(([p]) => String(p)), ...fetchMock.mock.calls.map(([u]) => String(u))];
    expect(urls.some((u) => /[?&]person=/.test(u))).toBe(false);
    expect(urls.some((u) => /personas/.test(u))).toBe(false);
  });
});
