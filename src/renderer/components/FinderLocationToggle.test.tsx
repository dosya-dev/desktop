// The switch that puts dosya.dev in the Finder sidebar. Written in this app's
// component-test style (createRoot + act, no @testing-library), matching
// MaintenanceGate.test.tsx.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { FinderLocationToggle } from "./FinderLocationToggle";

const status = vi.fn();
const setEnabled = vi.fn();
const link = vi.fn();
const openSettings = vi.fn();

describe("FinderLocationToggle", () => {
  let root: Root | null = null;
  let container: HTMLDivElement;

  beforeAll(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    status.mockReset();
    setEnabled.mockReset();
    link.mockReset();
    openSettings.mockReset();
    // Every bridge method returns a promise, so the fakes must too: a bare
    // vi.fn() returns undefined, and the component's .catch on it throws. CI
    // reported that as an unhandled error while this suite still said "passed"
    // locally, which is why the mocks are pinned here rather than per test.
    openSettings.mockResolvedValue(undefined);
    link.mockResolvedValue({ ok: true });
    (window as unknown as { electronAPI: unknown }).electronAPI = {
      fileProvider: { status, setEnabled, link, openSettings },
    };
  });

  afterEach(() => {
    act(() => root?.unmount());
    root = null;
    container.remove();
    vi.restoreAllMocks();
  });

  async function mount(): Promise<void> {
    await act(async () => {
      root = createRoot(container);
      root.render(<FinderLocationToggle userId="u1" />);
    });
  }

  const box = (): HTMLElement | null => container.querySelector('[role="switch"]');

  it("renders nothing when the platform cannot offer a Finder location", async () => {
    status.mockResolvedValue({ available: false, enabled: true });
    await mount();
    expect(container.textContent).toBe("");
  });

  it("renders nothing when there is no electron bridge at all", async () => {
    (window as unknown as { electronAPI: unknown }).electronAPI = {};
    await mount();
    expect(container.textContent).toBe("");
  });

  it("shows the stored state and writes the new one", async () => {
    status.mockResolvedValue({ available: true, enabled: true });
    setEnabled.mockResolvedValue({ enabled: false });
    await mount();

    expect(box()?.getAttribute("aria-checked")).toBe("true");
    await act(async () => {
      box()?.click();
    });
    expect(setEnabled).toHaveBeenCalledWith(false, "u1");
    expect(box()?.getAttribute("aria-checked")).toBe("false");
  });

  it("puts the switch back when the write fails", async () => {
    status.mockResolvedValue({ available: true, enabled: true });
    setEnabled.mockRejectedValue(new Error("nope"));
    await mount();

    await act(async () => {
      box()?.click();
    });
    // A switch left showing the state the user asked for, while the app is in
    // the other one, is worse than not moving at all.
    expect(box()?.getAttribute("aria-checked")).toBe("true");
  });

  it("shows a stored off as off, and turning it on links this account", async () => {
    status.mockResolvedValue({ available: true, enabled: false });
    setEnabled.mockResolvedValue({ enabled: true });
    await mount();

    expect(box()?.getAttribute("aria-checked")).toBe("false");
    await act(async () => {
      box()?.click();
    });
    expect(setEnabled).toHaveBeenCalledWith(true, "u1");
    expect(box()?.getAttribute("aria-checked")).toBe("true");
  });

  it("turning it on with nobody signed in sends no account", async () => {
    status.mockResolvedValue({ available: true, enabled: false });
    setEnabled.mockResolvedValue({ enabled: true });
    await act(async () => {
      root = createRoot(container);
      root.render(<FinderLocationToggle userId={null} />);
    });
    await act(async () => {
      box()?.click();
    });
    expect(setEnabled).toHaveBeenCalledWith(true, undefined);
  });

  it("says so when the location could not be set up, instead of claiming success", async () => {
    // The main process cannot always link when the switch goes on: the mint is
    // rate limited to 10 per session per 15 minutes, and it needs the network.
    // Reporting a bare success there leaves a switch that is on with no location
    // and nothing anywhere to explain it.
    status.mockResolvedValue({ available: true, enabled: false });
    setEnabled.mockResolvedValue({ enabled: true, linked: false });
    await mount();

    await act(async () => {
      box()?.click();
    });
    // The preference stays on - it is what the user asked for, and it is retried
    // on the next sign-in - but the state is stated plainly.
    expect(box()?.getAttribute("aria-checked")).toBe("true");
    expect(container.textContent).toMatch(/not set up yet/i);
  });

  it("says nothing extra when the link worked", async () => {
    status.mockResolvedValue({ available: true, enabled: false });
    setEnabled.mockResolvedValue({ enabled: true, linked: true });
    await mount();
    await act(async () => {
      box()?.click();
    });
    expect(container.textContent).not.toMatch(/not set up yet/i);
  });

  it("asks for the System Settings approval macOS is waiting on", async () => {
    // macOS registers the domain DISABLED and keeps it there until the user
    // approves the extension. Until then the folder exists and hangs, so a
    // switch that just reads "on" is a lie.
    status.mockResolvedValue({ available: true, enabled: true, needsApproval: true });
    await mount();

    expect(box()?.getAttribute("aria-checked")).toBe("true");
    expect(container.textContent).toMatch(/system settings/i);

    const button = [...container.querySelectorAll("button")].find((b) =>
      /open system settings/i.test(b.textContent ?? ""),
    );
    expect(button).toBeTruthy();
    await act(async () => {
      button?.click();
    });
    expect(openSettings).toHaveBeenCalled();
  });

  it("says nothing about approval once it is approved", async () => {
    status.mockResolvedValue({ available: true, enabled: true, needsApproval: false });
    await mount();
    expect(container.textContent).not.toMatch(/system settings/i);
  });

  it("surfaces approval reported by the switch itself", async () => {
    status.mockResolvedValue({ available: true, enabled: false, needsApproval: false });
    setEnabled.mockResolvedValue({ enabled: true, linked: true, needsApproval: true });
    await mount();
    await act(async () => {
      box()?.click();
    });
    expect(container.textContent).toMatch(/system settings/i);
  });

  it("survives a preload whose bridge returns no promise", async () => {
    // The shipped preload returns promises, but an app mid-update can be running
    // an older one, and then `openSettings().catch(...)` is a TypeError thrown
    // inside a React event handler. CI caught exactly this as an unhandled error
    // while the suite locally still reported a pass, so this pins it with an
    // assertion instead of relying on the runner noticing.
    const errors: unknown[] = [];
    const onError = (e: Event) => errors.push(e);
    window.addEventListener("error", onError);
    try {
      status.mockResolvedValue({ available: true, enabled: true, needsApproval: true });
      setEnabled.mockReturnValue(undefined as never);
      openSettings.mockReturnValue(undefined as never);
      await mount();

      const button = [...container.querySelectorAll("button")].find((b) =>
        /open system settings/i.test(b.textContent ?? ""),
      );
      await act(async () => {
        button?.click();
      });
      await act(async () => {
        box()?.click();
      });
      expect(openSettings).toHaveBeenCalled();
      expect(setEnabled).toHaveBeenCalled();
      expect(errors).toEqual([]);
    } finally {
      window.removeEventListener("error", onError);
    }
  });
});
