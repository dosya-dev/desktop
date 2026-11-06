// apps/desktop/src/renderer/components/files/FileViewer.people.test.tsx
//
// The viewer's "In this photo" row: the people this device's Personas found in
// an image (engine.peopleInFile), shown only while Personas is ready, each
// chip an in-app link to the persona's page. Nothing is asked of a server.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";

const get = vi.fn();
vi.mock("@/lib/api-client", async (orig) => ({
  ...(await orig<typeof import("@/lib/api-client")>()),
  apiBase: () => "https://api.test",
  api: { get: (p: string) => get(p), put: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
}));
vi.mock("@/lib/personas-device/engine-host", () => import("@/lib/personas-device/__fixtures__/fake-host"));

const { FileViewer } = await import("./FileViewer");
type ViewerFile = import("./FileViewer").ViewerFile;
const { fakeHost, card } = await import("@/lib/personas-device/__fixtures__/fake-host");

beforeAll(() => { (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true; });

const BOX = { x: 0.1, y: 0.1, w: 0.2, h: 0.2 };
let root: Root | null = null;
let container: HTMLDivElement | null = null;
beforeEach(() => {
  fakeHost.reset();
  fakeHost.engine.personas = [card("p1", "Emma")];
  fakeHost.engine.faces.set("f1", [{ persona_id: "p1", name: "Emma", face_id: "fa", box: BOX }]);
  get.mockReset();
  get.mockImplementation(async (p: string) => {
    if (p.endsWith("/versions")) return { ok: true, current_version: 1, versions: [] };
    throw new Error(`unexpected ${p}`);
  });
  vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 502 })));
});
afterEach(() => {
  if (root) act(() => root!.unmount());
  container?.remove();
  root = null; container = null;
  vi.unstubAllGlobals();
});

const base = { size_bytes: 100, mime_type: "image/jpeg", extension: "jpg", region: "eu", created_at: 1, updated_at: 1, lock_mode: "none", is_hidden: 0, uploader_name: null, share_count: 0, comment_count: 0 };
const photo: ViewerFile = { ...base, id: "f1", name: "IMG_1.jpg" };
const doc: ViewerFile = { ...base, id: "f2", name: "notes.txt", mime_type: "text/plain", extension: "txt" };

async function mount(file: ViewerFile, workspaceId?: string) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(createElement(MemoryRouter, null, createElement(FileViewer, { file, files: [file], onClose: () => {}, onNavigate: () => {}, workspaceId })));
  });
  for (let i = 0; i < 4; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}
const row = () => container!.querySelector('[data-testid="viewer-people"]');

describe("FileViewer people chips", () => {
  it("shows In this photo with a chip linking to the persona", async () => {
    await mount(photo, "ws1");
    expect(row()!.textContent).toContain("In this photo");
    const link = row()!.querySelector<HTMLAnchorElement>("a")!;
    expect(link.getAttribute("href")).toBe("/personas/p1");
    expect(link.textContent).toContain("Emma");
  });

  it("asks nothing without a workspace or for a non-image, and shows nothing while Personas is off", async () => {
    await mount(photo);
    expect(fakeHost.engine.peopleInFile).not.toHaveBeenCalled();
    expect(row()).toBeNull();
    act(() => root!.unmount()); container!.remove(); root = null;
    await mount(doc, "ws1");
    expect(fakeHost.engine.peopleInFile).not.toHaveBeenCalled();
    act(() => root!.unmount()); container!.remove(); root = null;
    fakeHost.set({ status: { state: "off" } });
    await mount(photo, "ws1");
    expect(fakeHost.engine.peopleInFile).not.toHaveBeenCalled();
    expect(row()).toBeNull();
    expect(container!.querySelector('[data-testid="viewer-close"]')).toBeTruthy();
  });

  it("never asks a server Personas route", async () => {
    await mount(photo, "ws1");
    const calls = [...get.mock.calls.map(([p]) => String(p)), ...(fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls.map(([u]) => String(u))];
    expect(calls.filter((u) => /personas|\/people/.test(u))).toEqual([]);
  });
});
