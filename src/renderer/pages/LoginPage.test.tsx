// Regression for Sentry dosya-desktop issue 149708526 (3.0.10): "Rendered
// fewer hooks than expected". The login page mounted unauthenticated, the
// session check (or a just-completed sign-in) flipped isAuthenticated, and the
// re-render took the early-return redirect ABOVE a hook call - so React saw
// fewer hooks than the previous render and threw error #300. Rendering with
// react-dom/client directly, like MaintenanceScreen.test.tsx.
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router-dom";

const auth = {
  isAuthenticated: false,
  isLoading: true,
  login: vi.fn(),
  refreshUser: vi.fn(),
};
vi.mock("@/lib/auth-context", () => ({ useAuth: () => ({ ...auth }) }));
vi.mock("@/lib/ipc", () => ({ ipc: {} }));

import { LoginPage } from "./LoginPage";

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(() => {
  if (root) act(() => root!.unmount());
  container?.remove();
  root = null;
  container = null;
});

function App() {
  return (
    <MemoryRouter initialEntries={["/login"]}>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/dashboard" element={<div data-testid="dashboard">dashboard</div>} />
      </Routes>
    </MemoryRouter>
  );
}

describe("LoginPage", () => {
  it("survives the auth state flipping to authenticated while mounted, and redirects", async () => {
    const uncaught: unknown[] = [];
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container, { onUncaughtError: (err) => uncaught.push(err) });

    // 1. Mount while the session check is still in flight: the form renders.
    auth.isAuthenticated = false;
    auth.isLoading = true;
    await act(async () => { root!.render(<App />); });
    expect(container.querySelector("form")).not.toBeNull();
    expect(uncaught).toEqual([]);

    // 2. The session check resolves as signed in. Same component instance,
    //    new props from context - the render that used to throw #300.
    auth.isAuthenticated = true;
    auth.isLoading = false;
    await act(async () => { root!.render(<App />); });

    expect(uncaught).toEqual([]);
    expect(container.querySelector('[data-testid="dashboard"]')).not.toBeNull();
  });
});
