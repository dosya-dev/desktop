import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react";
import { useVault, spaceName, type E2eeEngine, type KnownWorkspace } from "./store";
import { ENGINE_NO_ACTIVE_WORKSPACE } from "./engine";
import { ApiError } from "@/lib/api-client";
import { I18nProvider, t } from "@/lib/i18n";
import type { Messages } from "../../../i18n/translator";
import tr from "../../../i18n/messages/tr.json";

// Same reason as store.test.ts: the store's initial state builds the real
// engine, which needs an API base to import cleanly.
vi.mock("@/lib/api-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api-client")>();
  return { ...actual, apiBase: () => "http://api.test" };
});

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function engine(overrides: Partial<E2eeEngine> = {}): E2eeEngine {
  return {
    hasIdentity: async () => true, setup: async () => ({ recoveryKeyHex: "ab12" }), unlock: async () => {},
    unlockWithRecoveryKey: async () => {}, destroyIdentity: async () => {}, lock: () => {},
    createWorkspace: async () => {}, readWorkspaceName: async () => null, readWorkspaceNameById: async () => null,
    renameWorkspace: async () => {}, setWorkspaceScope: async () => {}, openWorkspace: async () => {},
    listFolder: async () => [], uploadFile: async () => {}, downloadFileToSink: async () => {},
    listMembers: async () => [], inviteMember: async () => {}, revokeMember: async () => {}, listMyWorkspaces: async () => [],
    ...overrides,
  };
}

let root: Root | null = null;
/** Switches the app language the way a fresh provider does (activate + listeners). */
function language(locale: "en" | "tr"): void {
  act(() => root?.unmount());
  root = createRoot(document.createElement("div"));
  act(() => root!.render(
    locale === "en"
      ? <I18nProvider initial="en">{null}</I18nProvider>
      : <I18nProvider initial="tr" initialMessages={tr as Messages}>{null}</I18nProvider>,
  ));
}

beforeEach(() => {
  language("en");
  useVault.setState({ status: "locked", error: null, destroyNeedsCode: false, busy: false, hasIdentity: true });
});

afterEach(() => {
  language("en");
  act(() => root?.unmount());
  root = null;
});

describe("useVault in the chosen language", () => {
  it("writes its own sentences in the current language and redoes them on a switch", async () => {
    language("tr");
    useVault.getState().__setEngine(engine({ unlock: async () => { throw new Error("e2ee: unlock failed"); } }));
    await useVault.getState().unlock("wrong");
    expect(useVault.getState().error).toBe(tr["vault.error.incorrectPassphraseOrNoIdentityFound"]);

    language("en");
    expect(useVault.getState().error).toBe("Incorrect passphrase or no identity found.");
  });

  it("leaves server text as sent, whatever the language", async () => {
    useVault.getState().__setEngine(engine({ destroyIdentity: async () => { throw new Error("Incorrect password"); } }));
    await useVault.getState().destroyIdentity("wrong");
    language("tr");
    expect(useVault.getState().error).toBe("Incorrect password");
    expect(useVault.getState().destroyNeedsCode).toBe(false);
  });

  it("asks for the two-factor code from the server's code, not from the sentence", async () => {
    language("tr");
    useVault.getState().__setEngine(engine({
      destroyIdentity: async () => { throw new ApiError("2fa_required", 400, { error: "2fa_required" }); },
    }));
    expect(await useVault.getState().destroyIdentity("pw")).toBe(false);
    expect(useVault.getState().error).toBe(tr["vault.label.enterYourTwoFactorCodeToContinue"]);
    expect(useVault.getState().destroyNeedsCode).toBe(true);
  });

  it("says the engine's own refusals in the current language", async () => {
    language("tr");
    useVault.getState().__setEngine(engine({ listFolder: async () => { throw new Error(ENGINE_NO_ACTIVE_WORKSPACE); } }));
    await useVault.getState().refreshFolder("");
    expect(useVault.getState().error).toBe(tr["vault.error.e2eeNoActiveWorkspace"]);
  });

  it("does not rewrite an error that replaced its own sentence", async () => {
    language("tr");
    useVault.getState().__setEngine(engine({ unlock: async () => { throw new Error("x"); } }));
    await useVault.getState().unlock("wrong");
    useVault.setState({ error: "Server said no" });
    language("en");
    expect(useVault.getState().error).toBe("Server said no");
  });
});

describe("spaceName", () => {
  const ws = (over: Partial<KnownWorkspace>): KnownWorkspace =>
    ({ id: "w", name: "Space", selfFounded: false, globalWorkspaceId: null, shared: false, ...over });

  it("shows a placeholder in the current language and a real name as typed", () => {
    language("tr");
    expect(spaceName(ws({ stub: true }), t)).toBe(tr["vault.label.space"]);
    expect(spaceName(ws({ stub: true, shared: true, name: "Shared Space" }), t)).toBe(tr["vault.status.sharedSpace"]);
    // A real name that happens to read "Space" is the user's, not a placeholder.
    expect(spaceName(ws({ stub: false }), t)).toBe("Space");
    expect(spaceName(ws({ name: "Belgeler" }), t)).toBe("Belgeler");
  });
});
