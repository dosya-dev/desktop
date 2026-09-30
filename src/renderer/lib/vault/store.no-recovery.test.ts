import { describe, it, expect, beforeEach, vi } from "vitest";
import { useVault, type E2eeEngine } from "./store";

// See store.test.ts's identical comment: the store's module-level initial
// state constructs the REAL engine, which needs a primed API base this test
// environment never provides. Vitest hoists this above the import.
vi.mock("@/lib/api-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api-client")>();
  return { ...actual, apiBase: () => "http://api.test" };
});

/**
 * The web app builds against the VENDORED e2ee bundle (apps/web/vendor),
 * re-vendored by hand from packages/e2ee-client. Until that lands, the bundle
 * has no `unlockWithRecoveryKey` at all - the shape of the module TODAY - and
 * the adapter that copes with it had no test of its own: nothing proved the
 * app degrades to a sentence instead of a TypeError, and deleting the fallback
 * would have gone unnoticed. The resolver itself (`recoveryUnlockFrom`) now
 * lives in `./engine` and is covered by `engine.test.ts`; this file covers
 * only the store's reaction when the engine reports the build cannot recover.
 */
function engineThatCannotRecover(): E2eeEngine {
  return {
    hasIdentity: async () => true,
    setup: async () => ({ recoveryKeyHex: "ab12" }),
    unlock: async () => {},
    unlockWithRecoveryKey: async () => { throw new Error("e2ee: recovery unlock unavailable in this build"); },
    destroyIdentity: async () => {},
    lock: () => {},
    createWorkspace: async () => {},
    readWorkspaceName: async () => null, readWorkspaceNameById: async () => null,
    renameWorkspace: async () => {},
    setWorkspaceScope: async () => {},
    openWorkspace: async () => {},
    listFolder: async () => [],
    uploadFile: async () => {},
    downloadFile: async () => new Uint8Array(),
    listMembers: async () => [],
    inviteMember: async () => {},
    revokeMember: async () => {},
    listMyWorkspaces: async () => [],
  };
}

beforeEach(() => {
  useVault.setState({ status: "locked", error: null, hasIdentity: true, busy: false });
});

describe("the store, when the build cannot do recovery unlock", () => {
  it("blames the build, not the key - the key was never tried", async () => {
    useVault.getState().__setEngine(engineThatCannotRecover());

    await useVault.getState().unlockWithRecoveryKey("ab12cd34");

    const error = useVault.getState().error ?? "";
    expect(useVault.getState().status).toBe("locked");
    expect(error).not.toMatch(/did not unlock/i);
    expect(error).toMatch(/not available in this version/i);
  });
});
