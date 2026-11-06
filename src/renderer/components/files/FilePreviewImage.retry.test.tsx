// Ported from apps/web/src/components/file-preview-image.retry.test.tsx - keep in sync.
// The one thumbnail retry: a failed `/thumb` is asked for once more after a
// short pause (new URL via `retry=1`) before the component gives up on the
// server and falls back to the raw original.
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

// The renderer learns the API origin from the main process at boot; a
// component test primes it the way the Search page test does.
vi.mock("@/lib/api-client", async (orig) => ({
  ...(await orig<typeof import("@/lib/api-client")>()),
  apiBase: () => "https://api.test",
}));

const { FilePreviewImage, THUMB_RETRY_MS } = await import("./FilePreviewImage");

let root: Root | null = null;
let container: HTMLDivElement;

beforeAll(() => { (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true; });
beforeEach(() => { vi.useFakeTimers(); container = document.createElement("div"); document.body.appendChild(container); });
afterEach(() => { if (root) act(() => root!.unmount()); root = null; container.remove(); vi.useRealTimers(); });

async function mount(fileName: string) {
  await act(async () => {
    root = createRoot(container);
    root.render(<FilePreviewImage fileId="f1" fileName={fileName} size={128} fallback={<i data-testid="fallback" />} />);
  });
}
const img = () => container.querySelector("img");
async function fail() { await act(async () => { img()!.dispatchEvent(new Event("error")); }); }

describe("FilePreviewImage thumbnail retry", () => {
  it("retries the thumbnail once after the pause, then falls back to /raw", async () => {
    await mount("photo.jpg");
    const first = img()!.src;
    expect(first).toContain("/api/files/f1/thumb?");
    expect(first).not.toContain("retry=");

    await fail();
    expect(img()!.src).toBe(first);
    await act(async () => { vi.advanceTimersByTime(THUMB_RETRY_MS); });
    expect(img()!.src).toContain("retry=1");
    expect(img()!.src).toContain("w=128");

    await fail();
    expect(img()!.src).toContain("/api/files/f1/raw");
    expect(container.querySelector('[data-testid="fallback"]')).toBeNull();
  });

  it("keeps the caller's own query on the retried URL", async () => {
    await act(async () => {
      root = createRoot(container);
      root.render(<FilePreviewImage fileId="f1" fileName="photo.png" query="ut=tok" size={256} fallback={<i />} />);
    });
    await fail();
    await act(async () => { vi.advanceTimersByTime(THUMB_RETRY_MS); });
    const url = new URL(img()!.src);
    expect(url.searchParams.get("ut")).toBe("tok");
    expect(url.searchParams.get("retry")).toBe("1");
    expect(url.searchParams.get("w")).toBe("256");
  });

  it("a non-image never asks for a thumbnail", async () => {
    await mount("notes.txt");
    expect(img()).toBeNull();
    expect(container.querySelector('[data-testid="fallback"]')).not.toBeNull();
  });
});
