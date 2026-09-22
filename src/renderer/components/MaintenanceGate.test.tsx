// Round 3 fix for a real bug: MaintenanceGate's onRetry used to do
// `await refreshUser(); clearMaintenance(); return true;` - but refreshUser()
// never throws (it swallows 401, 503/surface_disabled, and every other
// error), so clearMaintenance() ran unconditionally and dismissed the screen
// on every "Check now" / 60s tick even while the surface was still down.
// This test exercises MaintenanceGate + AuthProvider together against a
// mocked api client, the way the real app wires them, rather than unit
// testing refreshUser()'s return value in isolation.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ApiError } from "../lib/api-client";
import { AuthProvider } from "../lib/auth-context";
import { MaintenanceGate } from "./MaintenanceGate";

const apiGet = vi.hoisted(() => vi.fn());
vi.mock("../lib/api-client", async () => {
  const actual = await vi.importActual<typeof import("../lib/api-client")>("../lib/api-client");
  return { ...actual, api: { ...actual.api, get: apiGet } };
});

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeEach(() => {
  apiGet.mockReset();
});

afterEach(() => {
  if (root) act(() => root!.unmount());
  container?.remove();
  root = null;
  container = null;
});

function click(label: string | RegExp) {
  const button = [...document.querySelectorAll("button")].find((node) =>
    typeof label === "string" ? node.textContent?.trim() === label : label.test(node.textContent ?? ""));
  expect(button).toBeDefined();
  return act(async () => { button!.click(); });
}

describe("MaintenanceGate + auth-context", () => {
  it("stays up through a failed retry and only dismisses once /api/me actually succeeds", async () => {
    // Mount: /api/me is gated (503 surface_disabled).
    apiGet.mockRejectedValueOnce(
      new ApiError("Paused", 503, { code: "surface_disabled", surface: "desktop", message: "brb" }),
    );

    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root!.render(
        <AuthProvider>
          <MaintenanceGate>
            <div data-testid="protected">protected content</div>
          </MaintenanceGate>
        </AuthProvider>,
      );
    });

    expect(container.querySelector('[data-testid="maintenance-screen"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="protected"]')).toBeNull();

    // "Check now" while STILL gated: refreshUser() swallows the 503 and
    // resolves false - the screen must not dismiss.
    apiGet.mockRejectedValueOnce(
      new ApiError("Paused", 503, { code: "surface_disabled", surface: "desktop", message: "brb" }),
    );
    await click(/Check now/);
    expect(container.querySelector('[data-testid="maintenance-screen"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="protected"]')).toBeNull();

    // The surface comes back: /api/me succeeds, and only now does the screen
    // go away.
    apiGet.mockResolvedValueOnce({ user: { id: "u1", email: "f@x.dev" } });
    await click(/Check now/);

    expect(container.querySelector('[data-testid="maintenance-screen"]')).toBeNull();
    expect(container.querySelector('[data-testid="protected"]')).not.toBeNull();
  });
});
