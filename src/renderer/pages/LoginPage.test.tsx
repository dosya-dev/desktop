// Regression for Sentry dosya-desktop issue 149708526 (3.0.10): "Rendered
// fewer hooks than expected". The login page mounted unauthenticated, the
// session check (or a just-completed sign-in) flipped isAuthenticated, and the
// re-render took the early-return redirect ABOVE a hook call - so React saw
// fewer hooks than the previous render and threw error #300. Rendering with
// react-dom/client directly, like MaintenanceScreen.test.tsx.
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";

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

// QA TC-004/TC-010/TC-014: the close button only hides the window to the tray,
// so the form outlived "closing the app" with the typed password and the last
// error; and a fetch that never got an answer showed Chromium's raw text.
describe("LoginPage form state", () => {
  function setValue(input: HTMLInputElement, value: string) {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }

  it("offers Try again for a network failure and clears the password on close-to-tray", async () => {
    let closedToTray: (() => void) | null = null;
    (window as unknown as { electronAPI: unknown }).electronAPI = {
      onWindowClosedToTray: (cb: () => void) => {
        closedToTray = cb;
        return () => { closedToTray = null; };
      },
    };
    auth.isAuthenticated = false;
    auth.isLoading = false;
    auth.login.mockResolvedValue({ ok: false, error: "Could not reach dosya.", reason: "network" });

    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => { root!.render(<App />); });

    const email = container.querySelector('input[type="email"]') as HTMLInputElement;
    const password = container.querySelector('input[type="password"]') as HTMLInputElement;
    await act(async () => { setValue(email, "test@example.com"); setValue(password, "123"); });
    await act(async () => {
      container!.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });

    const alert = container.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain("Could not reach dosya.");
    const retry = alert?.querySelector("button");
    expect(retry).not.toBeNull();
    await act(async () => { retry!.click(); });
    expect(auth.login).toHaveBeenCalledTimes(2);

    // Hidden to the tray: password and error go, the email stays.
    await act(async () => { closedToTray!(); });
    expect((container.querySelector('input[type="password"]') as HTMLInputElement).value).toBe("");
    expect((container.querySelector('input[type="email"]') as HTMLInputElement).value).toBe("test@example.com");
    expect(container.querySelector('[role="alert"]')).toBeNull();

    delete (window as unknown as { electronAPI?: unknown }).electronAPI;
  });

  it("shows no retry for a wrong password", async () => {
    auth.isAuthenticated = false;
    auth.isLoading = false;
    auth.login.mockResolvedValue({ ok: false, error: "Incorrect email or password.", reason: "invalid" });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => { root!.render(<App />); });
    await act(async () => {
      container!.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    const alert = container.querySelector('[role="alert"]');
    expect(alert?.textContent).toBe("Incorrect email or password.");
    expect(alert?.querySelector("button")).toBeNull();
  });
});

// An account whose email was never verified used to get "Please verify your
// email before signing in." with no way to get a code. Sign-in now hands the
// user to the verify screen, which sends a fresh code.
describe("LoginPage verification hand-off", () => {
  function StateEcho() {
    const loc = useLocation();
    return <pre data-testid="verify-state">{JSON.stringify(loc.state)}</pre>;
  }
  function render(initial: { pathname: string; state?: unknown }) {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    return act(async () => {
      root!.render(
        <MemoryRouter initialEntries={[initial]}>
          <Routes>
            <Route path="/login" element={<LoginPage />} />
            <Route path="/verify" element={<StateEcho />} />
          </Routes>
        </MemoryRouter>,
      );
    });
  }

  it("moves an unverified account to the verify screen with its email", async () => {
    auth.isAuthenticated = false;
    auth.isLoading = false;
    auth.login.mockResolvedValue({ ok: false, error: "", reason: "unverified" });
    await render({ pathname: "/login", state: { email: "new@example.com" } });
    await act(async () => {
      container!.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    const echoed = container!.querySelector('[data-testid="verify-state"]');
    expect(JSON.parse(echoed!.textContent!)).toEqual({ email: "new@example.com", fromSignIn: true });
    expect(container!.querySelector('[role="alert"]')).toBeNull();
  });

  it("confirms a just-verified email instead of showing a bare form", async () => {
    auth.isAuthenticated = false;
    auth.isLoading = false;
    await render({ pathname: "/login", state: { email: "new@example.com", verified: true } });
    expect(container!.querySelector('[role="status"]')?.textContent).toBe("Your email is verified. Sign in to continue.");
  });
});
