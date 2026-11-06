// "Remove photo metadata" (API migration 0183) on the desktop share dialog.
// Ticked, the request carries `strip_metadata: true`; untouched, the field is
// absent so an ordinary link is byte-for-byte what it was before the option.
// Rendered with react-dom/client directly, like LoginPage.test.tsx.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const { post } = vi.hoisted(() => ({
  post: vi.fn(async () => ({ ok: true, link: { url: "https://dosya.dev/s/tok" } })),
}));
vi.mock("@/lib/api-client", () => ({
  api: { post, get: vi.fn(async () => ({ ok: true, excluded_count: 0 })) },
  ApiError: class extends Error {},
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/ipc", () => ({ ipc: {} }));
// The dialog reads the effective plan off the /api/me user (Free locks the
// longer expiries). Paid by default so the metadata tests see the old dialog.
const auth = vi.hoisted(() => ({ planId: "pro" as string }));
vi.mock("@/lib/auth-context", () => ({ useAuth: () => ({ user: { plan: { id: auth.planId } } }) }));

import { ShareModal } from "./ShareModal";

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeEach(() => { post.mockClear(); auth.planId = "pro"; });
afterEach(() => {
  if (root) act(() => root!.unmount());
  container?.remove();
  root = null;
  container = null;
});

async function open() {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(<ShareModal open target={{ kind: "file", fileIds: ["f1"] }} name="beach.jpg" onClose={() => {}} />);
  });
}

const button = (text: string) =>
  [...document.body.querySelectorAll("button")].find((b) => b.textContent?.trim() === text)!;

async function click(el: Element) {
  await act(async () => { (el as HTMLElement).click(); await Promise.resolve(); await Promise.resolve(); });
}

function sentBody(): Record<string, unknown> {
  expect(post).toHaveBeenCalledTimes(1);
  return (post.mock.calls[0] as unknown as [string, Record<string, unknown>])[1];
}

describe("ShareModal - remove photo metadata", () => {
  it("sends strip_metadata: true when the box is ticked", async () => {
    await open();
    await click(button("By link"));
    await click(button("Advanced options"));
    const box = document.body.querySelector('[data-testid="strip-metadata"]') as HTMLInputElement;
    expect(box, "strip-metadata checkbox").toBeTruthy();
    await click(box);
    await click(button("Generate link"));
    expect(sentBody().strip_metadata).toBe(true);
  });

  it("sends no strip_metadata when the box is untouched", async () => {
    await open();
    await click(button("By link"));
    await click(button("Advanced options"));
    await click(button("Generate link"));
    expect(sentBody()).not.toHaveProperty("strip_metadata");
  });
});

describe("ShareModal - Free plan expiry cap", () => {
  const HINT = "Free plan links last up to 7 days.";
  const trigger = () => document.body.querySelector('[data-testid="share-expiry-trigger"]') as HTMLButtonElement;
  const listbox = () => document.body.querySelector('[role="listbox"]') as HTMLElement | null;
  const row = (label: string) =>
    [...document.body.querySelectorAll('[role="option"]')].find((o) => o.textContent?.trim() === label) as HTMLElement;
  const hint = () => document.body.querySelector('[data-testid="free-expiry-hint"]');
  const key = async (el: Element, k: string) => {
    await act(async () => { el.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true })); });
  };

  it("puts a lock on every row past 7 days, and says why with a See plans link", async () => {
    auth.planId = "free";
    await open();
    expect(trigger().textContent).toContain("7 days");
    await click(trigger());
    for (const label of ["Never", "30 days", "90 days"]) {
      expect(row(label).getAttribute("aria-disabled"), label).toBe("true");
      expect(row(label).title).toBe(HINT);
      expect(row(label).querySelector('[data-testid="expiry-lock"]'), `${label} lock`).toBeTruthy();
    }
    for (const label of ["1 day", "7 days"]) {
      expect(row(label).getAttribute("aria-disabled"), label).toBeNull();
      expect(row(label).querySelector('[data-testid="expiry-lock"]'), `${label} lock`).toBeNull();
    }
    expect(row("7 days").getAttribute("aria-selected")).toBe("true");
    expect(hint()?.textContent).toContain(HINT);
    expect(hint()?.querySelector("button")?.textContent).toBe("See plans");
  });

  it("does not pick a locked row by click or by keyboard", async () => {
    auth.planId = "free";
    await open();
    await click(trigger());
    await click(row("30 days"));
    expect(listbox(), "a locked row leaves the list open").toBeTruthy();
    expect(row("7 days").getAttribute("aria-selected")).toBe("true");
    // From 7 days, ArrowDown has nowhere pickable to go; Enter keeps 7 days.
    await key(listbox()!, "ArrowDown");
    await key(listbox()!, "Enter");
    expect(listbox()).toBeNull();
    expect(trigger().textContent).toContain("7 days");
  });

  it("moves with the arrow keys, picks with Enter and closes on Escape", async () => {
    await open();
    await key(trigger(), "ArrowDown");
    expect(listbox()).toBeTruthy();
    await key(listbox()!, "ArrowDown");
    await key(listbox()!, "Enter");
    expect(trigger().textContent).toContain("30 days");
    await click(trigger());
    await key(listbox()!, "Escape");
    expect(listbox()).toBeNull();
    expect(trigger().textContent).toContain("30 days");
  });

  it("refuses a locked expiry picked before the plan was known, instead of sending it to be cut to 7 days", async () => {
    await open();
    await click(button("By link"));
    await click(trigger());
    await click(row("30 days"));
    auth.planId = "free";
    // Re-render with the plan now Free; the 30-day pick is still held.
    await act(async () => {
      root!.render(<ShareModal open target={{ kind: "file", fileIds: ["f1"] }} name="beach.jpg" onClose={() => {}} />);
    });
    await click(button("Generate link"));
    expect(post).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain(HINT);
  });

  it("leaves a paid plan's rows unlocked with no hint", async () => {
    await open();
    await click(trigger());
    expect(document.body.querySelectorAll('[role="option"][aria-disabled="true"]').length).toBe(0);
    expect(document.body.querySelectorAll('[data-testid="expiry-lock"]').length).toBe(0);
    expect(hint()).toBeNull();
  });
});
