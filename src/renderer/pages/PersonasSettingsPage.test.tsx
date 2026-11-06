// apps/desktop/src/renderer/pages/PersonasSettingsPage.test.tsx
//
// Mirrors apps/web/src/pages/personas/settings-page.test.tsx: this user's
// Personas settings live on their own page beside People, not in workspace
// Settings.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { readFileSync } from "node:fs";
import path from "node:path";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("@/lib/api-client", async (orig) => ({
  ...(await orig<typeof import("@/lib/api-client")>()),
  api: { get: vi.fn(async () => ({ ok: true, folders: [] })), put: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
  apiBase: () => "https://api.test",
}));
vi.mock("@/lib/workspace-context", () => ({
  useWorkspace: () => ({ active: { id: "ws1", name: "Family photos" }, workspaces: [], setActive: () => {}, isLoading: false, isError: false, refetch: () => {} }),
}));
vi.mock("@/lib/personas-device/engine-host", () => import("@/lib/personas-device/__fixtures__/fake-host"));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const { fakeHost } = await import("@/lib/personas-device/__fixtures__/fake-host");
const { PersonasSettingsPage } = await import("./PersonasSettingsPage");

beforeAll(() => { (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true; });

let root: Root | null = null;
let container: HTMLDivElement | null = null;
beforeEach(() => fakeHost.reset());
afterEach(() => {
  if (root) act(() => root!.unmount());
  container?.remove();
  root = null; container = null;
});

describe("/personas/settings", () => {
  it("is a route of its own, next to /personas", () => {
    const app = readFileSync(path.join(process.cwd(), "src/renderer/App.tsx"), "utf8");
    expect(app).toMatch(/<Route path="\/personas\/settings" element={<ProtectedPage><PersonasSettingsPage \/><\/ProtectedPage>} \/>/);
  });

  it("shows the heading, the switch and a way back to People", async () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => {
      root!.render(<QueryClientProvider client={qc}><MemoryRouter initialEntries={["/personas/settings"]}><PersonasSettingsPage /></MemoryRouter></QueryClientProvider>);
    });
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    expect(container.querySelector("h1")!.textContent).toBe("Personas settings");
    expect(container.querySelector('button[role="switch"][aria-label="Personas in this workspace"]')).toBeTruthy();
    expect(container.querySelector('a[href="/personas"]')!.textContent).toContain("Personas");
  });
});
