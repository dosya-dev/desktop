// The Sync > Settings switch for usage analytics. Component-test style of this
// app (createRoot + act, no @testing-library), as FinderLocationToggle.test.tsx.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { UsageDataToggle } from "./UsageDataToggle";

const state = vi.fn();
const setConsent = vi.fn();

describe("UsageDataToggle", () => {
  let root: Root | null = null;
  let container: HTMLDivElement;

  beforeAll(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    state.mockReset();
    setConsent.mockReset();
    (window as unknown as { electronAPI: unknown }).electronAPI = { analytics: { state, setConsent } };
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
      root.render(<UsageDataToggle />);
    });
  }

  const box = (): HTMLElement | null => container.querySelector('[role="switch"]');

  it("renders nothing when the bridge has no analytics", async () => {
    (window as unknown as { electronAPI: unknown }).electronAPI = {};
    await mount();
    expect(container.textContent).toBe("");
  });

  it("reads as off once it has been turned off", async () => {
    state.mockResolvedValue({ consent: "denied" });
    await mount();
    expect(box()?.getAttribute("aria-checked")).toBe("false");
  });

  it("shows a yes and asks main to withdraw it", async () => {
    state.mockResolvedValue({ consent: "granted" });
    setConsent.mockResolvedValue({ consent: "denied" });
    await mount();
    expect(box()?.getAttribute("aria-checked")).toBe("true");
    await act(async () => {
      box()?.click();
    });
    expect(setConsent).toHaveBeenCalledWith(false);
    expect(box()?.getAttribute("aria-checked")).toBe("false");
  });

  it("goes back when main could not store the change", async () => {
    state.mockResolvedValue({ consent: "denied" });
    setConsent.mockRejectedValue(new Error("disk full"));
    await mount();
    await act(async () => {
      box()?.click();
    });
    expect(box()?.getAttribute("aria-checked")).toBe("false");
  });
});
