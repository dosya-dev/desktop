import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react";
import { UnlockGate } from "./UnlockGate";
import { useVault, type E2eeEngine } from "@/lib/vault/store";

vi.mock("@/lib/auth-context", () => ({ useAuth: () => ({ user: { id: "user_1" } }) }));
// apiBase is overridden too, not just api.get: the store's module-level
// initial state eagerly constructs the REAL engine (defaultEngine() ->
// buildE2eeClient() -> apiBase()), unprimed in this test environment (no
// main process) - see store.test.ts's identical mock and its comment.
vi.mock("@/lib/api-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api-client")>();
  return { ...actual, apiBase: () => "http://api.test", api: { ...actual.api, get: async () => ({ ok: true, method: null }) } };
});

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function fakeEngine(hasIdentity: () => Promise<boolean>): E2eeEngine {
  return {
    hasIdentity, setup: async () => ({ recoveryKeyHex: "ab12" }), unlock: async () => {},
    unlockWithRecoveryKey: async () => {}, destroyIdentity: async () => {}, lock: () => {},
    createWorkspace: async () => {}, readWorkspaceName: async () => null, readWorkspaceNameById: async () => null, renameWorkspace: async () => {},
  setWorkspaceScope: async () => {}, openWorkspace: async () => {},
    listFolder: async () => [], uploadFile: async () => {}, downloadFile: async () => new Uint8Array(),
    listMembers: async () => [], inviteMember: async () => {}, revokeMember: async () => {}, listMyWorkspaces: async () => [],
  };
}

let root: Root; let host: HTMLDivElement;
beforeEach(() => {
  localStorage.clear();
  useVault.setState({ status: "locked", error: null, hasIdentity: null, busy: false, recoveryKeyOnce: null, ownerUserId: null, workspaces: [] });
  host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
});

afterEach(() => {
  act(() => { root.unmount(); });
  host.remove();
});

async function render() {
  // One act() around both the render and a macrotask: two separate act()
  // calls let a store promise continuation resolve BETWEEN them, outside any
  // act(), which is what produced the act() warnings here. A macrotask (not
  // just a microtask) lets every chained await inside a store action settle;
  // one microtask would leave openWorkspace -> refreshFolder half done.
  await act(async () => {
    root.render(<UnlockGate />);
    await new Promise((r) => setTimeout(r, 0));
  });
}

describe("UnlockGate", () => {
  it("shows Setup when no identity exists", async () => {
    useVault.getState().__setEngine(fakeEngine(async () => false));
    await render();
    expect(host.querySelector('[data-testid="vault-setup"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="vault-unlock"]')).toBeNull();
  });

  it("shows Unlock when an identity exists", async () => {
    useVault.getState().__setEngine(fakeEngine(async () => true));
    await render();
    expect(host.querySelector('[data-testid="vault-unlock"]')).not.toBeNull();
  });

  // A network blip must never route a returning user into Setup, whose
  // setup() would overwrite their real keys.
  it("shows Retry, not Setup, when the identity check fails", async () => {
    useVault.getState().__setEngine(fakeEngine(async () => { throw new Error("offline"); }));
    await render();
    expect(host.querySelector('[data-testid="vault-retry"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="vault-setup"]')).toBeNull();
  });

  it("binds the signed-in user before checking", async () => {
    useVault.setState({ ownerUserId: "someone_else", workspaces: [{ id: "w", name: "Theirs", selfFounded: true, shared: false, globalWorkspaceId: null }] });
    useVault.getState().__setEngine(fakeEngine(async () => true));
    await render();
    expect(useVault.getState().ownerUserId).toBe("user_1");
    expect(useVault.getState().workspaces).toEqual([]);
  });
});
