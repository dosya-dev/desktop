// apps/desktop/src/renderer/components/settings/PersonasSection.test.tsx
//
// Mirrors apps/web/src/pages/settings/personas.test.tsx for the desktop port:
// this user's Personas settings on /personas/settings, all through the
// device's engine. Desktop differences: skipped folders are named from the
// folder tree (one GET, which the picker needs anyway) and picked in the
// shared FolderPickerModal.
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
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("sonner", () => ({ toast }));
const clearKeyIfLastWorkspace = vi.fn(async (_u: string | null) => {});
vi.mock("@/lib/personas-device/wipe", () => ({ clearKeyIfLastWorkspace: (u: string | null) => clearKeyIfLastWorkspace(u) }));
vi.mock("@/lib/personas-device/engine-host", () => import("@/lib/personas-device/__fixtures__/fake-host"));
// The picker virtualises its rows against a scroll element jsdom cannot size;
// render every row instead (as AiSearchSection.test.tsx does).
vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: (opts: { count: number }) => ({
    getTotalSize: () => opts.count * 36,
    getVirtualItems: () => Array.from({ length: opts.count }, (_, i) => ({ key: i, index: i, start: i * 36 })),
  }),
}));

const { fakeHost, card, READY } = await import("@/lib/personas-device/__fixtures__/fake-host");
const { PersonasSection } = await import("./PersonasSection");

const TURN_OFF_TEXT = "Your people, names and corrections for this workspace are deleted from all your devices.";
const TREE = { ok: true, folders: [
  { id: "d1", name: "Work receipts", parent_id: null, file_count: 2 },
  { id: "d2", name: "Private", parent_id: null, file_count: 1 },
] };

beforeAll(() => { (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true; });

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeEach(() => {
  clearKeyIfLastWorkspace.mockClear();
  fakeHost.reset({ ...READY, read: 3, total: 10 });
  fakeHost.engine.personas = [card("p1", "Emma")];
  fakeHost.engine.skipped = ["d1"];
  toast.success.mockReset(); toast.error.mockReset();
  get.mockReset();
  get.mockImplementation(async (p: string) => {
    if (p.startsWith("/api/folders/tree")) return TREE;
    throw new Error(`unexpected ${p}`);
  });
});
afterEach(() => {
  if (root) act(() => root!.unmount());
  container?.remove();
  root = null; container = null;
  document.body.innerHTML = "";
});

const flush = async () => { for (let i = 0; i < 6; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };

async function mount() {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root!.render(<QueryClientProvider client={qc}><MemoryRouter><PersonasSection wsId="ws1" /></MemoryRouter></QueryClientProvider>);
  });
  await flush();
}

const text = () => container!.textContent ?? "";
const switchFor = (label: string) => container!.querySelector<HTMLButtonElement>(`button[role="switch"][aria-label="${label}"]`);
const click = async (el: Element | null | undefined) => { expect(el).toBeTruthy(); await act(async () => { (el as HTMLElement).click(); }); await flush(); };
const buttonIn = (scope: ParentNode, label: string) => [...scope.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.trim() === label) ?? null;
const dialog = () => document.body.querySelector<HTMLElement>('[role="dialog"]');

describe("Personas settings section", () => {
  it("shows the workspace switch, the device switch, skipped folders and the delete button, and nothing about region, owner, plan or consent", async () => {
    await mount();
    expect(switchFor("Personas in this workspace")!.getAttribute("aria-checked")).toBe("true");
    expect(switchFor("Read on this device")!.getAttribute("aria-checked")).toBe("true");
    expect(text()).toContain("Skipped folders");
    expect(text()).toContain("Work receipts");
    expect(container!.querySelector('button[aria-label="Stop skipping Work receipts"]')).toBeTruthy();
    expect(buttonIn(container!, "Add folder")).toBeTruthy();
    expect(buttonIn(container!, "Delete my people in this workspace")).toBeTruthy();
    expect(text()).not.toMatch(/region|owner|plan|agree|server|cloudflare/i);
  });

  it('switching Personas off asks "Are you sure?" then turns it off on every device', async () => {
    await mount();
    await click(switchFor("Personas in this workspace"));
    const d = dialog()!;
    expect(d.textContent).toContain("Are you sure?");
    expect(d.textContent).toContain(TURN_OFF_TEXT);
    expect(fakeHost.engine.turnOff).not.toHaveBeenCalled();
    await click(buttonIn(d, "Turn off and delete"));
    expect(fakeHost.engine.turnOff).toHaveBeenCalledTimes(1);
    // The device's cached key goes too when this was its last workspace (the helper decides).
    expect(clearKeyIfLastWorkspace).toHaveBeenCalledTimes(1);
    expect(switchFor("Personas in this workspace")!.getAttribute("aria-checked")).toBe("false");
    expect(dialog()).toBeNull();
  });

  it("Cancel keeps Personas on", async () => {
    await mount();
    await click(switchFor("Personas in this workspace"));
    await click(buttonIn(dialog()!, "Cancel"));
    expect(fakeHost.engine.turnOff).not.toHaveBeenCalled();
    expect(dialog()).toBeNull();
  });

  it('"Delete my people in this workspace" asks the same and does the same', async () => {
    await mount();
    await click(buttonIn(container!, "Delete my people in this workspace"));
    expect(dialog()!.textContent).toContain(TURN_OFF_TEXT);
    await click(buttonIn(dialog()!, "Turn off and delete"));
    expect(fakeHost.engine.turnOff).toHaveBeenCalledTimes(1);
  });

  it("keeps the dialog open with a message when turning off fails", async () => {
    fakeHost.engine.turnOff.mockRejectedValueOnce(new Error("offline"));
    await mount();
    await click(switchFor("Personas in this workspace"));
    await click(buttonIn(dialog()!, "Turn off and delete"));
    expect(dialog()!.textContent).toContain("Something went wrong. Try again.");
    expect(clearKeyIfLastWorkspace).not.toHaveBeenCalled();
  });

  it("switching Personas on starts it at once (no consent step)", async () => {
    fakeHost.set({ status: { state: "off" } });
    await mount();
    expect(switchFor("Personas in this workspace")!.getAttribute("aria-checked")).toBe("false");
    expect(switchFor("Read on this device")).toBeNull();
    await click(switchFor("Personas in this workspace"));
    expect(fakeHost.engine.turnOn).toHaveBeenCalledTimes(1);
    expect(dialog()).toBeNull();
  });

  it('"Read on this device" pauses and resumes reading here', async () => {
    await mount();
    await click(switchFor("Read on this device"));
    expect(fakeHost.engine.setPaused).toHaveBeenLastCalledWith(true);
    expect(switchFor("Read on this device")!.getAttribute("aria-checked")).toBe("false");
    await click(switchFor("Read on this device"));
    expect(fakeHost.engine.setPaused).toHaveBeenLastCalledWith(false);
  });

  it("says this device cannot read photos, and has no device switch then", async () => {
    fakeHost.supported = false;
    await mount();
    expect(text()).toContain("This device can't read photos. Your other devices can.");
    expect(switchFor("Read on this device")).toBeNull();
  });

  it("Add folder opens the folder picker without offering skipped folders, and skips the pick; × stops skipping one", async () => {
    await mount();
    await click(buttonIn(container!, "Add folder"));
    const picker = document.body.querySelector(".fixed")!;
    expect(picker.textContent).toContain("Skipped folders");
    const rowNames = [...picker.querySelectorAll("button span")].map((s) => s.textContent);
    expect(rowNames).toContain("Private");
    expect(rowNames).not.toContain("Work receipts");
    await click([...picker.querySelectorAll("button")].find((b) => b.textContent === "Private"));
    await click([...picker.querySelectorAll("button")].filter((b) => b.textContent === "Add folder").pop());
    expect(fakeHost.engine.skipFolder).toHaveBeenCalledWith("d2", true);
    expect(text()).toContain("Private");
    await click(container!.querySelector('button[aria-label="Stop skipping Work receipts"]'));
    expect(fakeHost.engine.skipFolder).toHaveBeenCalledWith("d1", false);
    expect(text()).not.toContain("Work receipts");
  });

  it("sends the user to the Vault step while Personas is locked or has no Vault", async () => {
    fakeHost.set({ status: { state: "needs_unlock" } });
    await mount();
    expect(text()).toContain("Unlock with your Vault passphrase to open your people on this device.");
    expect(container!.querySelector('a[href="/personas"]')!.textContent).toBe("Open Personas");
    act(() => root!.unmount()); container!.remove(); root = null;

    fakeHost.set({ status: { state: "needs_identity" } });
    await mount();
    expect(text()).toContain("Personas uses your Vault passphrase to protect your people. Set it up to continue.");
  });

  it("has its heading and a link to how Personas protects privacy", async () => {
    await mount();
    expect(container!.querySelector("h1")!.textContent).toBe("Personas settings");
    const link = container!.querySelector<HTMLAnchorElement>('a[href="https://dosya.dev/biometric-data-policy"]')!;
    expect(link.textContent).toBe("How Personas protects your privacy");
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toContain("noopener");
  });

  it("says so with a retry when the engine cannot answer", async () => {
    fakeHost.set({ status: null, error: new Error("offline") });
    await mount();
    expect(text()).toContain("Personas could not be loaded.");
    await click(buttonIn(container!, "Try again"));
    expect(fakeHost.refresh).toHaveBeenCalled();
  });

  it("never asks a server Personas route", async () => {
    await mount();
    expect(get.mock.calls.filter(([p]) => String(p).includes("personas"))).toEqual([]);
  });
});

describe("PersonasSection turn-off dialog focus", () => {
  it("focuses Cancel when the dialog opens, closes on Escape and gives focus back to the opener", async () => {
    await mount();
    const opener = buttonIn(container!, "Delete my people in this workspace")!;
    opener.focus();
    await click(opener);
    expect(document.activeElement).toBe(buttonIn(dialog()!, "Cancel"));
    await act(async () => { document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
    await flush();
    expect(dialog()).toBeNull();
    expect(fakeHost.engine.turnOff).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(opener);
  });
});
