import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react";
import { VaultBrowser } from "./VaultBrowser";
import { useVault, type E2eeEngine, type KnownWorkspace } from "@/lib/vault/store";

vi.mock("@/lib/workspace-context", () => ({ useWorkspace: () => ({ active: { id: "gw-1", name: "Main" } }) }));
vi.mock("@/lib/auth-context", () => ({ useAuth: () => ({ user: { id: "user_1", email: "me@dosya.dev" } }) }));
vi.mock("@/lib/api-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api-client")>();
  return { ...actual, apiBase: () => "http://api.test" };
});

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
// jsdom has no matchMedia at all; VaultSpaces now calls useNarrowWindow
// (F2), which reads it unconditionally on every render (as Sidebar's own
// copy always has, in the real Electron renderer where matchMedia exists).
// Stubbed narrow:false so these tests see the same wide-window layout they
// did before that hook was in the render path.
if (!window.matchMedia) {
  window.matchMedia = ((query: string) => ({
    matches: false, media: query, onchange: null,
    addEventListener: () => {}, removeEventListener: () => {},
    addListener: () => {}, removeListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}
// A macrotask lets every chained await inside a store action settle; one
// microtask would leave openWorkspace -> refreshFolder half done.
const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });

const engine = (o: Partial<E2eeEngine> = {}): E2eeEngine => ({
  hasIdentity: async () => true, setup: async () => ({ recoveryKeyHex: "ab" }), unlock: async () => {},
  unlockWithRecoveryKey: async () => {}, destroyIdentity: async () => {}, lock: () => {},
  createWorkspace: async () => {}, readWorkspaceName: async () => null, readWorkspaceNameById: async () => null, renameWorkspace: async () => {},
  setWorkspaceScope: async () => {}, openWorkspace: async () => {},
  listFolder: async () => [], uploadFile: async () => {}, downloadFileToSink: async () => {},
  listMembers: async () => [], inviteMember: async () => {}, revokeMember: async () => {}, listMyWorkspaces: async () => [],
  ...o,
});

const spaces: KnownWorkspace[] = [
  { id: "s1", name: "Taxes", selfFounded: true, shared: false, globalWorkspaceId: "gw-1" },
  { id: "s2", name: "Elsewhere", selfFounded: true, shared: false, globalWorkspaceId: "gw-2" },
  { id: "s3", name: "Team drop", selfFounded: false, shared: true, globalWorkspaceId: "gw-2" },
];

let root: Root; let host: HTMLDivElement;
beforeEach(() => {
  localStorage.clear();
  useVault.setState({ status: "unlocked", error: null, busy: false, workspaces: spaces, activeWorkspaceId: null, entries: [], members: [], ownerUserId: "user_1" });
  useVault.getState().__setEngine(engine());
  host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
});

afterEach(() => {
  act(() => { root.unmount(); });
  host.remove();
});

const render = async () => {
  await act(async () => {
    root.render(<VaultBrowser />);
    await new Promise((r) => setTimeout(r, 0));
  });
};
const q = (id: string) => host.querySelector(`[data-testid="${id}"]`);

describe("VaultBrowser", () => {
  it("lists own Spaces scoped to the active workspace and every shared Space", async () => {
    await render();
    expect(q("vault-space-s1")).not.toBeNull();
    expect(q("vault-space-s2")).toBeNull();          // scoped to gw-2, not shown
    expect(q("vault-space-s3")).not.toBeNull();      // shared: always shown
    expect(q("vault-empty-space")).not.toBeNull();   // nothing selected yet
  });

  it("opens a Space and lists its root folder", async () => {
    const opened: string[] = [];
    useVault.getState().__setEngine(engine({
      openWorkspace: async (id) => { opened.push(id); },
      listFolder: async () => [{ id: "f1", name: "Receipts", kind: "folder" }, { id: "e1", name: "w2.pdf", kind: "file" }],
    }));
    await render();
    await act(async () => { (q("vault-space-s1") as HTMLButtonElement).click(); });
    await flush();
    expect(opened).toEqual(["s1"]);
    expect(q("vault-entry-f1")).not.toBeNull();
    expect(q("vault-entry-e1")).not.toBeNull();
  });

  it("downloads a file through the store", async () => {
    const downloaded: string[] = [];
    const written: number[] = [];
    useVault.getState().__setEngine(engine({
      listFolder: async () => [{ id: "e1", name: "w2.pdf", kind: "file" }],
      downloadFileToSink: async (_f, id, sink) => { downloaded.push(id); await sink(new Uint8Array([1]), 0); },
    }));
    useVault.getState().__setSink({
      open: async () => ({ ok: true, id: "s1" }),
      write: async (_id, _bytes, index) => { written.push(index); },
      close: async () => ({ path: "/x" }),
      abort: async () => {},
    });
    await render();
    await act(async () => { (q("vault-space-s1") as HTMLButtonElement).click(); });
    await flush();
    await act(async () => { (q("vault-download-e1") as HTMLButtonElement).click(); });
    await flush();
    expect(downloaded).toEqual(["e1"]);
    // The decrypted bytes reach the main process one chunk at a time now.
    expect(written).toEqual([0]);
  });

  it("lock returns to the gate", async () => {
    await render();
    await act(async () => { (q("vault-lock") as HTMLButtonElement).click(); });
    expect(useVault.getState().status).toBe("locked");
  });

  it("does not list a Space whose reopen failed, even when it was already active", async () => {
    let listed = 0;
    useVault.getState().__setEngine(engine({
      openWorkspace: async () => { throw new Error("grant missing"); },
      listFolder: async () => { listed++; return []; },
    }));
    useVault.setState({ activeWorkspaceId: "s1" });
    await render();
    await act(async () => { (q("vault-space-s1") as HTMLButtonElement).click(); });
    await flush();
    expect(listed).toBe(0);
    expect(useVault.getState().error).not.toBeNull();
  });

  it("ignores a drop into the Vault while an upload is already running", async () => {
    const uploaded: string[] = [];
    useVault.getState().__setEngine(engine({ uploadFile: async (_f, name) => { uploaded.push(name); } }));
    await render();
    await act(async () => { (q("vault-space-s1") as HTMLButtonElement).click(); });
    await flush();
    act(() => { useVault.setState({ busy: true }); });

    const target = q("vault-drop-target") as HTMLElement;
    const file = new File(["hello"], "a.txt");
    const dropEvent = new Event("drop", { bubbles: true, cancelable: true });
    Object.defineProperty(dropEvent, "dataTransfer", { value: { files: [file], items: [] } });
    await act(async () => { target.dispatchEvent(dropEvent); });
    await flush();

    expect(uploaded).toEqual([]);
  });

  // QA TC-056: an upload blanked the grid into eight skeleton cards for as
  // long as it ran, because the grid keyed its skeletons on the store-wide
  // `busy` flag. The files already there now stay, with a card for the upload.
  it("keeps the existing files visible during an upload and shows the upload's own card", async () => {
    let finish!: () => void;
    const listing = [{ id: "e1", name: "w2.pdf", kind: "file" as const }];
    useVault.getState().__setEngine(engine({
      listFolder: async () => listing,
      uploadFile: () => new Promise<void>((r) => { finish = r; }),
    }));
    await render();
    await act(async () => { (q("vault-space-s1") as HTMLButtonElement).click(); });
    await flush();
    expect(q("vault-entry-e1")).not.toBeNull();

    const input = q("vault-upload-input") as HTMLInputElement;
    const file = new File(["hello"], "taxes-2026.pdf");
    // jsdom's File has no arrayBuffer(); the store reads the bytes with it.
    Object.defineProperty(file, "arrayBuffer", { value: async () => new ArrayBuffer(5) });
    Object.defineProperty(input, "files", { value: [file], configurable: true });
    await act(async () => { input.dispatchEvent(new Event("change", { bubbles: true })); });
    await flush();

    expect(useVault.getState().error).toBeNull();
    expect(useVault.getState().busy).toBe(true);
    expect(q("vault-busy"), "no skeleton grid mid-upload").toBeNull();
    expect(q("vault-entry-e1"), "existing file still shown").not.toBeNull();
    expect(q("vault-uploading")?.textContent).toContain("taxes-2026.pdf");

    listing.push({ id: "e2", name: "taxes-2026.pdf", kind: "file" });
    await act(async () => { finish(); });
    await flush();
    expect(q("vault-uploading")).toBeNull();
    expect(q("vault-entry-e2")).not.toBeNull();
  });

  it("still shows skeletons while a Space's first listing loads", async () => {
    let release!: () => void;
    useVault.getState().__setEngine(engine({
      listFolder: () => new Promise((r) => { release = () => r([{ id: "e1", name: "w2.pdf", kind: "file" }]); }),
    }));
    await render();
    await act(async () => { (q("vault-space-s1") as HTMLButtonElement).click(); });
    await flush();
    expect(q("vault-busy")).not.toBeNull();
    await act(async () => { release(); });
    await flush();
    expect(q("vault-busy")).toBeNull();
    expect(q("vault-entry-e1")).not.toBeNull();
  });
});
