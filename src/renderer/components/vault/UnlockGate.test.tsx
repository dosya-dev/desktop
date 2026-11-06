import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react";
import { UnlockGate } from "./UnlockGate";
import { useVault, type E2eeEngine } from "@/lib/vault/store";

const authUser = vi.hoisted(() => ({ current: { id: "user_1" } as { id: string; email?: string; has_password?: boolean } }));
const apiPost = vi.hoisted(() => vi.fn(async () => ({ ok: true })));
vi.mock("@/lib/auth-context", () => ({ useAuth: () => ({ user: authUser.current }) }));
// apiBase is overridden too, not just api.get: the store's module-level
// initial state eagerly constructs the REAL engine (defaultEngine() ->
// buildE2eeClient() -> apiBase()), unprimed in this test environment (no
// main process) - see store.test.ts's identical mock and its comment.
vi.mock("@/lib/api-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api-client")>();
  return { ...actual, apiBase: () => "http://api.test", api: { ...actual.api, get: async () => ({ ok: true, method: null }), post: apiPost } };
});

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function fakeEngine(hasIdentity: () => Promise<boolean>): E2eeEngine {
  return {
    hasIdentity, setup: async () => ({ recoveryKeyHex: "ab12" }), unlock: async () => {},
    unlockWithRecoveryKey: async () => {}, destroyIdentity: async () => {}, lock: () => {},
    createWorkspace: async () => {}, readWorkspaceName: async () => null, readWorkspaceNameById: async () => null, renameWorkspace: async () => {},
  setWorkspaceScope: async () => {}, openWorkspace: async () => {},
    listFolder: async () => [], uploadFile: async () => {}, downloadFileToSink: async () => {},
    listMembers: async () => [], inviteMember: async () => {}, revokeMember: async () => {}, listMyWorkspaces: async () => [],
  };
}

let root: Root; let host: HTMLDivElement;
beforeEach(() => {
  authUser.current = { id: "user_1" };
  apiPost.mockClear();
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

  it("an Apple or Google sign-in account destroys its vault with an emailed code, not a password", async () => {
    authUser.current = { id: "user_1", email: "a@x.com", has_password: false };
    const calls: unknown[][] = [];
    const engine = fakeEngine(async () => true);
    engine.destroyIdentity = async (proof, code) => { calls.push([proof, code]); };
    useVault.getState().__setEngine(engine);
    await render();

    await act(async () => { (host.querySelector('[data-testid="vault-destroy"]') as HTMLButtonElement).click(); });
    expect(document.querySelector("#vault-destroy-password")).toBeNull();

    await act(async () => { (document.querySelector('[data-testid="vault-destroy-send-code"]') as HTMLButtonElement).click(); });
    expect(apiPost).toHaveBeenCalledWith("/api/e2ee/destroy-request", {});

    const input = document.querySelector("#vault-destroy-email-code") as HTMLInputElement;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(input, "123 456");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => { (document.querySelector('[data-testid="vault-destroy-modal"] input[type="checkbox"]') as HTMLInputElement).click(); });
    await act(async () => { (document.querySelector('[data-testid="vault-destroy-confirm"]') as HTMLButtonElement).click(); });

    expect(calls).toEqual([[{ code: "123456" }, undefined]]);
  });

  it("moves to the emailed code when the password path is refused for email-code 2FA, not to a 2FA field", async () => {
    const { ApiError } = await import("@/lib/api-client");
    const engine = fakeEngine(async () => true);
    engine.destroyIdentity = async () => {
      throw new ApiError("Destroying a vault is not available on accounts using email codes for two-factor authentication. Switch to an authenticator app in your security settings, then try again.", 409);
    };
    useVault.getState().__setEngine(engine);
    await render();

    await act(async () => { (host.querySelector('[data-testid="vault-destroy"]') as HTMLButtonElement).click(); });
    const pw = document.querySelector("#vault-destroy-password") as HTMLInputElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(pw, "hunter22");
      pw.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => { (document.querySelector('[data-testid="vault-destroy-modal"] input[type="checkbox"]') as HTMLInputElement).click(); });
    await act(async () => { (document.querySelector('[data-testid="vault-destroy-confirm"]') as HTMLButtonElement).click(); });

    expect(document.querySelector("#vault-destroy-password")).toBeNull();
    expect(document.querySelector('[data-testid="vault-destroy-send-code"]')).not.toBeNull();
    expect(document.querySelector("#vault-destroy-code")).toBeNull();
  });
});
