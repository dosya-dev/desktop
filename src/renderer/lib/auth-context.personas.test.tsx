// On-device Personas learns who is signed in from AuthProvider: its engines
// are per user, and a sign-out teardown holds until the user changes
// (lib/personas-device/teardown.ts).
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { AuthProvider, useAuth } from "./auth-context";
import { personasUser, setPersonasUser } from "./personas-device/teardown";

const apiGet = vi.hoisted(() => vi.fn());
vi.mock("./api-client", async () => {
  const actual = await vi.importActual<typeof import("./api-client")>("./api-client");
  return { ...actual, api: { ...actual.api, get: apiGet, post: vi.fn() } };
});
vi.mock("./sentry", () => ({ setSentryUser: vi.fn(), reportError: vi.fn() }));

function Probe({ onReady }: { onReady: (refresh: (fresh?: boolean) => Promise<boolean>) => void }) {
  const { refreshUser } = useAuth();
  onReady(refreshUser);
  return null;
}

describe("AuthProvider and Personas", () => {
  let root: Root | null = null;
  let container: HTMLDivElement;
  let refresh: (fresh?: boolean) => Promise<boolean>;

  beforeAll(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(async () => {
    setPersonasUser(null);
    container = document.createElement("div");
    document.body.appendChild(container);
    (window as unknown as { electronAPI: unknown }).electronAPI = {
      fileProvider: { link: vi.fn().mockResolvedValue({ ok: true }), status: vi.fn(), setEnabled: vi.fn() },
      waitForSession: vi.fn().mockResolvedValue(undefined),
    };
    apiGet.mockReset();
    apiGet.mockRejectedValue(Object.assign(new Error("401"), { status: 401 }));
    await act(async () => {
      root = createRoot(container);
      root.render(<AuthProvider><Probe onReady={(r) => (refresh = r)} /></AuthProvider>);
    });
  });

  afterEach(() => {
    act(() => root?.unmount());
    root = null;
    container.remove();
    setPersonasUser(null);
  });

  it("hands the signed-in user's id to Personas", async () => {
    expect(personasUser()).toBeNull();
    apiGet.mockResolvedValue({ user: { id: "u1" } });
    await act(async () => { await refresh(true); });
    expect(personasUser()).toBe("u1");
  });
});
