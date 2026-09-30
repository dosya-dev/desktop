// Which sign-ins re-mint the Finder extension's session.
//
// The extension's session is a child of the app's and the server kills it with
// its parent, so anything stored across a sign-out is dead. A plain link keeps
// what is stored, which is right on a boot or a profile refresh and wrong after
// signing in again: Finder would ask to sign in until the next app launch.
// Password sign-in goes through login(); Google and 2FA go through refreshUser,
// and used to be treated as boots.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { AuthProvider, useAuth } from "./auth-context";

const apiGet = vi.hoisted(() => vi.fn());
const apiPost = vi.hoisted(() => vi.fn());
vi.mock("./api-client", async () => {
  const actual = await vi.importActual<typeof import("./api-client")>("./api-client");
  return { ...actual, api: { ...actual.api, get: apiGet, post: apiPost } };
});
vi.mock("./sentry", () => ({ setSentryUser: vi.fn(), reportError: vi.fn() }));

const link = vi.fn();

function Probe({ onReady }: { onReady: (refresh: (fresh?: boolean) => Promise<boolean>) => void }) {
  const { refreshUser } = useAuth();
  onReady(refreshUser);
  return null;
}

describe("the Finder link follows the kind of sign-in", () => {
  let root: Root | null = null;
  let container: HTMLDivElement;
  let refresh: (fresh?: boolean) => Promise<boolean>;

  beforeAll(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(async () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    link.mockReset();
    link.mockResolvedValue({ ok: true });
    apiGet.mockReset();
    apiPost.mockReset();
    (window as unknown as { electronAPI: unknown }).electronAPI = {
      fileProvider: { link, status: vi.fn(), setEnabled: vi.fn() },
      waitForSession: vi.fn().mockResolvedValue(undefined),
    };
    // Signed out at boot, so the mount check does not link on its own.
    apiGet.mockRejectedValue(Object.assign(new Error("401"), { status: 401 }));
    await act(async () => {
      root = createRoot(container);
      root.render(
        <AuthProvider>
          <Probe onReady={(r) => (refresh = r)} />
        </AuthProvider>,
      );
    });
    link.mockClear();
  });

  afterEach(() => {
    act(() => root?.unmount());
    root = null;
    container.remove();
    vi.restoreAllMocks();
  });

  it("a sign-in that completes through refreshUser re-mints", async () => {
    apiGet.mockResolvedValue({ user: { id: "u1" } });
    await act(async () => {
      await refresh(true);
    });
    expect(link).toHaveBeenCalledWith("u1", true);
  });

  it("a plain refresh keeps whatever the extension already holds", async () => {
    apiGet.mockResolvedValue({ user: { id: "u1" } });
    await act(async () => {
      await refresh();
    });
    expect(link).toHaveBeenCalledWith("u1", false);
  });
});
