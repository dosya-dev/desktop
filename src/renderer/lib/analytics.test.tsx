// The renderer names events and hands them to main; it sends nothing itself.
// .tsx so vitest runs it: it imports @dosya-dev/shared, which node --test cannot load.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { recordApiActivity, trackEvent, trackScreen, trackUpload } from "./analytics";

const track = vi.fn();

beforeEach(() => {
  track.mockReset();
  (window as unknown as { electronAPI: unknown }).electronAPI = { analytics: { track } };
});
afterEach(() => vi.restoreAllMocks());

describe("renderer analytics", () => {
  it("names an action from a succeeded API call and ignores reads", () => {
    recordApiActivity("POST", "/api/shares");
    recordApiActivity("DELETE", "/api/files/f_93kd02?permanent=1");
    recordApiActivity("GET", "/api/files");
    recordApiActivity(undefined, "/api/me");
    expect(track.mock.calls).toEqual([
      ["share_create", undefined],
      ["file_delete", { batch: false }],
    ]);
  });

  it("names a screen by its route with ids replaced, and never the About window", () => {
    trackScreen("/files");
    trackScreen("/personas/p_8f3k2j1");
    trackScreen("/editor/f_93kd02");
    trackScreen("/about");
    expect(track.mock.calls).toEqual([
      ["page_view", { screen: "/files" }],
      ["page_view", { screen: "/personas/:id" }],
      ["page_view", { screen: "/editor/:id" }],
    ]);
  });

  it("reports an upload as a size band", () => {
    trackUpload(5_000_000);
    expect(track).toHaveBeenCalledWith("file_upload", { size_band: "1_10mb" });
  });

  it("cannot pass a name: unknown events and free text never reach the bridge", () => {
    trackEvent("opened passport.pdf");
    trackEvent("search", { mode: "tax return 2026" });
    trackEvent("login", { method: "browser", email: "ada@example.com" });
    expect(track.mock.calls).toEqual([
      ["search", undefined],
      ["login", { method: "browser" }],
    ]);
  });

  it("does nothing, and does not throw, without a bridge or with a broken one", () => {
    (window as unknown as { electronAPI: unknown }).electronAPI = {};
    expect(() => trackEvent("logout")).not.toThrow();
    (window as unknown as { electronAPI: unknown }).electronAPI = { analytics: { track: () => { throw new Error("gone"); } } };
    expect(() => trackEvent("logout")).not.toThrow();
  });
});
