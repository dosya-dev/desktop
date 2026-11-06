// Ported from apps/web/src/components/video-poster.test.tsx - keep in sync with the web copy.
import { describe, it, expect, afterEach, vi, beforeAll } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

// fileThumbUrl() resolves through api-client, which throws until main.tsx's
// IPC round trip primes it - mock the module (see FileDetailPanel.test.tsx).
vi.mock("@/lib/api-client", () => ({ apiBase: () => "https://api.example.com" }));

const ensurePoster = vi.fn<(f: { id: string }) => Promise<string | null>>();
vi.mock("@/lib/video-poster", () => ({ ensurePoster: (f: { id: string }) => ensurePoster(f) }));

import { VideoPoster } from "./VideoPoster";

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

let root: Root | null = null;
let host: HTMLDivElement | null = null;
function mount(el: React.ReactElement) {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(el));
}
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  ensurePoster.mockReset();
});

const img = () => host!.querySelector("img");

describe("VideoPoster", () => {
  it("asks /thumb for the stored poster first", () => {
    mount(<VideoPoster file={{ id: "v1", current_version: 2 }} />);
    expect(img()!.getAttribute("src")).toMatch(/\/api\/files\/v1\/thumb\?version=2&w=512$/);
    expect(ensurePoster).not.toHaveBeenCalled();
  });

  it("grabs a frame in the tab when the server has no poster yet", async () => {
    ensurePoster.mockResolvedValue("blob:poster");
    mount(<VideoPoster file={{ id: "v1", current_version: 1 }} />);
    await act(async () => { img()!.dispatchEvent(new Event("error")); });
    expect(ensurePoster).toHaveBeenCalledWith({ id: "v1", current_version: 1 });
    expect(img()!.getAttribute("src")).toBe("blob:poster");
  });

  it("renders nothing when no frame can be had, and does not loop", async () => {
    ensurePoster.mockResolvedValue("blob:broken");
    mount(<VideoPoster file={{ id: "v1" }} />);
    await act(async () => { img()!.dispatchEvent(new Event("error")); });
    await act(async () => { img()!.dispatchEvent(new Event("error")); });
    expect(img()).toBeNull();
    expect(ensurePoster).toHaveBeenCalledTimes(1);
  });

  it("never asks for a locked video without its unlock token", () => {
    mount(<VideoPoster file={{ id: "v1", lock_mode: "full_lock" }} />);
    expect(img()).toBeNull();
  });

  it("carries the unlock token, and does not grab a locked video", async () => {
    mount(<VideoPoster file={{ id: "v1", lock_mode: "full_lock" }} unlockToken="ut1" />);
    expect(img()!.getAttribute("src")).toContain("ut=ut1");
    await act(async () => { img()!.dispatchEvent(new Event("error")); });
    expect(ensurePoster).not.toHaveBeenCalled();
    expect(img()).toBeNull();
  });
});
