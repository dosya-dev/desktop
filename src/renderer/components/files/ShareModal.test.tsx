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

import { ShareModal } from "./ShareModal";

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeEach(() => { post.mockClear(); });
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
