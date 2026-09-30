import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react";
import { VaultMembers } from "./VaultMembers";
import { useVault, type E2eeEngine } from "@/lib/vault/store";

vi.mock("@/lib/auth-context", () => ({ useAuth: () => ({ user: { id: "user_me" } }) }));
vi.mock("@/lib/api-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api-client")>();
  return { ...actual, apiBase: () => "http://api.test" };
});
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
// A macrotask lets every chained await inside a store action settle; one
// microtask would leave openWorkspace -> refreshFolder half done.
const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });

const engine = (o: Partial<E2eeEngine> = {}): E2eeEngine => ({
  hasIdentity: async () => true, setup: async () => ({ recoveryKeyHex: "ab" }), unlock: async () => {},
  unlockWithRecoveryKey: async () => {}, destroyIdentity: async () => {}, lock: () => {},
  createWorkspace: async () => {}, readWorkspaceName: async () => null, readWorkspaceNameById: async () => null, renameWorkspace: async () => {},
  setWorkspaceScope: async () => {}, openWorkspace: async () => {},
  listFolder: async () => [], uploadFile: async () => {}, downloadFile: async () => new Uint8Array(),
  listMembers: async () => [], inviteMember: async () => {}, revokeMember: async () => {}, listMyWorkspaces: async () => [],
  ...o,
});

const members = [
  { userId: "user_me", email: "me@dosya.dev", ed25519Pub: "pm", x25519Pub: "xm" },
  { userId: "user_b", email: "b@dosya.dev", ed25519Pub: "pb", x25519Pub: "xb" },
];

let root: Root; let host: HTMLDivElement;
beforeEach(() => {
  useVault.setState({ status: "unlocked", error: null, busy: false, members });
  useVault.getState().__setEngine(engine({ listMembers: async () => members }));
  host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
});

afterEach(() => {
  act(() => { root.unmount(); });
  host.remove();
});

const render = async () => {
  await act(async () => {
    root.render(<VaultMembers workspaceName="Taxes" onClose={() => {}} />);
    await new Promise((r) => setTimeout(r, 0));
  });
};
const q = (id: string) => host.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;

describe("VaultMembers", () => {
  it("marks the signed-in user and offers revoke only for others", async () => {
    await render();
    expect(q("vault-member-user_me")?.textContent).toMatch(/you/);
    expect(q("vault-revoke-user_me")).toBeNull();
    expect(q("vault-revoke-user_b")).not.toBeNull();
  });

  it("invites by email through the store", async () => {
    const invited: string[] = [];
    useVault.getState().__setEngine(engine({ listMembers: async () => members, inviteMember: async (e) => { invited.push(e); } }));
    await render();
    const input = q("vault-invite-email") as HTMLInputElement;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(input, "c@dosya.dev");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => { q("vault-invite")!.click(); });
    await flush();
    expect(invited).toEqual(["c@dosya.dev"]);
  });

  it("revokes after confirmation, passing the member's signing key", async () => {
    const revoked: [string, string][] = [];
    useVault.getState().__setEngine(engine({ listMembers: async () => members, revokeMember: async (u, k) => { revoked.push([u, k]); } }));
    await render();
    await act(async () => { q("vault-revoke-user_b")!.click(); });
    expect(q("vault-revoke-confirm")).not.toBeNull();
    await act(async () => { q("vault-revoke-confirm")!.click(); });
    await flush();
    expect(revoked).toEqual([["user_b", "pb"]]);
  });
});
