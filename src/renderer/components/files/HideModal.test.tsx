// QA TC-039: the Hide dialog sometimes showed only a spinner, forever. It
// waited on three requests with no deadline, so one request that never
// answered left it spinning with Apply greyed out. Now the visibility read has
// a deadline and the dialog offers a retry; the roster no longer gates it.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const { get, post } = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(async () => ({ ok: true })),
}));
vi.mock("@/lib/api-client", () => ({
  api: { get, post },
  ApiError: class extends Error {},
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { HideModal, HIDE_LOAD_TIMEOUT_MS } from "./HideModal";

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

let root: Root | null = null;
let container: HTMLDivElement | null = null;

/** A request that only ever ends by being aborted, like a stalled connection. */
function hang(_path: string, signal?: AbortSignal) {
  return new Promise((_resolve, reject) => {
    signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
  });
}

function roster(path: string) {
  if (path.startsWith("/api/team")) return Promise.resolve({ ok: true, members: [] });
  if (path.startsWith("/api/roles")) return Promise.resolve({ ok: true, roles: [] });
  return null;
}

beforeEach(() => {
  vi.useFakeTimers();
  get.mockReset();
});
afterEach(() => {
  if (root) act(() => root!.unmount());
  container?.remove();
  root = null;
  container = null;
  vi.useRealTimers();
});

async function open() {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <HideModal
        open
        target={{ id: "f1", name: "report.docx", type: "file" }}
        workspaceId="ws1"
        onClose={() => {}}
        onDone={() => {}}
      />,
    );
  });
}

const spinner = () => document.body.querySelector('[role="status"]');
const button = (text: string) =>
  [...document.body.querySelectorAll("button")].find((b) => b.textContent?.trim() === text);

describe("HideModal - loading never spins forever", () => {
  it("a visibility read that never answers turns into an error with Retry, and Retry loads", async () => {
    get.mockImplementation((path: string, signal?: AbortSignal) => roster(path) ?? hang(path, signal));
    await open();
    expect(spinner(), "spinner while loading").toBeTruthy();

    await act(async () => { await vi.advanceTimersByTimeAsync(HIDE_LOAD_TIMEOUT_MS + 10); });
    expect(spinner(), "spinner gone after the deadline").toBeNull();
    expect(document.body.querySelector('[role="alert"]')?.textContent).toMatch(/reach the server/i);
    expect(button("Apply")?.disabled, "Apply stays off without the current state").toBe(true);

    get.mockImplementation((path: string) => roster(path) ?? Promise.resolve({ ok: true, hidden_mode: "everyone", rules: [] }));
    await act(async () => { button("Retry")!.click(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(spinner()).toBeNull();
    expect(document.body.querySelector('[role="alert"]')).toBeNull();
    const everyone = [...document.body.querySelectorAll<HTMLInputElement>('input[name="hide-mode"]')][1];
    expect(everyone.checked, "loaded mode is shown").toBe(true);
    expect(button("Apply")?.disabled).toBe(false);
  });

  it("a stalled member/role list does not hold the dialog", async () => {
    get.mockImplementation((path: string, signal?: AbortSignal) =>
      path.startsWith("/api/files/") ? Promise.resolve({ ok: true, hidden_mode: "none", rules: [] }) : hang(path, signal));
    await open();
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(spinner()).toBeNull();
    expect(button("Apply")?.disabled).toBe(false);
  });
});
