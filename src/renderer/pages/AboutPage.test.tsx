// The About window's facts come from four bridges and the auth context; this
// pins what each row says for a given state, and the update button's label
// per build, without a real Electron.
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

vi.mock("@/assets/app-icon.png", () => ({ default: "icon.png" }));
vi.mock("@/lib/auth-context", () => ({
  useAuth: () => ({ user: { email: "firat@example.com" } }),
}));

import { AboutPage } from "./AboutPage";
import { channelName, syncLine, updateButton, updateHint } from "@/lib/about-info";

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

describe("pure helpers", () => {
  it("names the channel for people, not for the build system", () => {
    expect(channelName("direct")).toBe("Direct download");
    expect(channelName("mas")).toBe("Mac App Store");
    expect(channelName("ms-store")).toBe("Microsoft Store");
    expect(channelName("snap")).toBe("Snap Store");
  });

  it("summarises sync the way the tray does: paused, errors, syncing, failed files, synced", () => {
    const pair = (status: string) => ({ status });
    expect(syncLine(null)).toBe("No folders");
    expect(syncLine({ pairs: [], globalPaused: false, activeTransfers: [] })).toBe("No folders");
    expect(syncLine({ pairs: [pair("idle")], globalPaused: true, activeTransfers: [] })).toBe("Paused · 1 folder");
    expect(syncLine({ pairs: [pair("error"), pair("idle")], globalPaused: false, activeTransfers: [] })).toBe("1 with errors · 2 folders");
    expect(syncLine({ pairs: [pair("syncing")], globalPaused: false, activeTransfers: [] })).toBe("Syncing · 1 folder");
    expect(syncLine({ pairs: [pair("idle")], globalPaused: false, activeTransfers: [], fileErrorCount: 3 })).toBe("3 files not synced · 1 folder");
    expect(syncLine({ pairs: [pair("idle"), pair("idle")], globalPaused: false, activeTransfers: [] })).toBe("All synced · 2 folders");
  });

  it("offers the right update button per build and state", () => {
    expect(updateButton("direct", { state: "idle" })).toEqual({ label: "Check for Updates", action: "check", busy: false });
    expect(updateButton("direct", { state: "checking" })).toEqual({ label: "Checking…", action: "check", busy: true });
    expect(updateButton("direct", { state: "downloading", percent: 40 })).toEqual({ label: "Downloading 40%", action: "check", busy: true });
    expect(updateButton("direct", { state: "ready", version: "3.1.0" })).toEqual({ label: "Restart to Update", action: "install", busy: false });
    expect(updateButton("mas", { state: "store-managed" })).toEqual({ label: "Open Mac App Store", action: "store", busy: false });
    expect(updateButton("snap", { state: "store-managed" }).action).toBeNull();
    expect(updateHint({ state: "not-available" })).toBe("You're up to date");
    expect(updateHint({ state: "error", message: "offline" })).toBe("Update check failed: offline");
    expect(updateHint({ state: "idle" })).toBeNull();
  });
});

describe("AboutPage", () => {
  it("shows the version, channel, system, engine, account, sync and Finder rows", async () => {
    (window as unknown as { electronAPI: unknown }).electronAPI = {
      getAboutInfo: () => Promise.resolve({ version: "3.0.10", distribution: "mas", platform: "macOS 24.6.0", arch: "arm64", electron: "43.4.0", chrome: "142.0.0.0" }),
      getUpdateStatus: () => Promise.resolve({ state: "store-managed" }),
      getSyncStatus: () => Promise.resolve({ pairs: [{ status: "idle" }, { status: "idle" }], globalPaused: false, activeTransfers: [], fileErrorCount: 0 }),
      fileProvider: { status: () => Promise.resolve({ available: true, enabled: true, needsApproval: false }) },
      onUpdateStatusChanged: () => () => {},
      onSyncStatusChanged: () => () => {},
    };
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => { root!.render(<AboutPage />); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });

    const text = container.textContent ?? "";
    expect(text).toContain("Version 3.0.10");
    expect(text).toContain("Mac App Store");
    expect(text).toContain("macOS 24.6.0 · arm64");
    expect(text).toContain("Electron 43.4.0 · Chromium 142.0.0.0");
    expect(text).toContain("firat@example.com");
    expect(text).toContain("All synced · 2 folders");
    expect(text).toContain("Finder location");
    expect(text).toContain("Open Mac App Store");
    expect(text).toContain("Copy Details");
  });

  it("opens the acknowledgements list from its link", async () => {
    (window as unknown as { electronAPI: unknown }).electronAPI = {
      getAboutInfo: () => Promise.resolve({ version: "3.0.10", distribution: "direct", platform: "Linux 6.8", arch: "x64", electron: "43.4.0", chrome: "142" }),
      getUpdateStatus: () => Promise.resolve({ state: "idle" }),
      getSyncStatus: () => Promise.resolve(null),
      fileProvider: { status: () => Promise.resolve({ available: false, enabled: false, needsApproval: false }) },
      onUpdateStatusChanged: () => () => {},
      onSyncStatusChanged: () => () => {},
    };
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => { root!.render(<AboutPage />); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(container.textContent).not.toContain("Finder location");
    expect(container.textContent).toContain("Check for Updates");

    const ack = [...container.querySelectorAll("button")].find((b) => b.textContent === "Acknowledgements");
    expect(ack).toBeTruthy();
    await act(async () => { ack!.click(); });
    expect(container.textContent).toContain("zustand");
    expect(container.textContent).toContain("MIT");
  });
});
