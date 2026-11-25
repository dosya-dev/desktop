// The email form follows the admin dashboard's email sign-up switch, read from
// GET /api/auth/signup. Rendering with react-dom/client directly, like
// LoginPage.test.tsx.
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";

const mockGet = vi.fn();
vi.mock("@/lib/api-client", async (orig) => ({
  ...(await orig<typeof import("@/lib/api-client")>()),
  api: { get: (...a: unknown[]) => mockGet(...a), post: vi.fn() },
}));
vi.mock("@/lib/auth-context", () => ({ useAuth: () => ({ refreshUser: vi.fn() }) }));
vi.mock("@/lib/ipc", () => ({ ipc: {} }));

import { SignUpPage } from "./SignUpPage";

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
  mockGet.mockReset();
});

async function mount() {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(<MemoryRouter><SignUpPage /></MemoryRouter>);
  });
  // Let the status request settle.
  await act(async () => { await Promise.resolve(); });
  return container;
}

describe("SignUpPage email sign-up switch", () => {
  it("asks the API and hides the email form when sign-up is off", async () => {
    mockGet.mockResolvedValue({ ok: true, email_signup: false });
    const el = await mount();
    expect(mockGet).toHaveBeenCalledWith("/api/auth/signup");
    expect(el.querySelector("form")).toBeNull();
    expect(el.querySelector('input[type="email"]')).toBeNull();
    // The provider buttons stay.
    expect(el.querySelectorAll("button").length).toBeGreaterThanOrEqual(3);
  });

  it("shows the form when sign-up is on", async () => {
    mockGet.mockResolvedValue({ ok: true, email_signup: true });
    const el = await mount();
    expect(el.querySelector("form")).not.toBeNull();
  });

  it("shows the form if asking the API fails", async () => {
    mockGet.mockRejectedValue(new Error("offline"));
    const el = await mount();
    expect(el.querySelector("form")).not.toBeNull();
  });
});
