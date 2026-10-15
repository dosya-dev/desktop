import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { __resetDistributionCache, loadDistribution, useDistribution } from "./use-distribution";

function Probe() {
  const d = useDistribution();
  return <span data-testid="d">{d ?? "loading"}</span>;
}

describe("useDistribution", () => {
  let root: Root | null = null;
  let container: HTMLDivElement;

  beforeAll(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterEach(() => {
    act(() => root?.unmount());
    root = null;
    container?.remove();
    __resetDistributionCache();
    // @ts-expect-error test teardown
    delete window.electronAPI;
  });

  async function mount() {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root!.render(<Probe />);
    });
    await act(async () => {});
    return container.querySelector("[data-testid=d]")!.textContent;
  }

  it("reports the store the main process detected", async () => {
    (window as any).electronAPI = { getDistribution: vi.fn().mockResolvedValue("mas") };
    expect(await mount()).toBe("mas");
  });

  it("asks the main process once and shares the answer", async () => {
    const getDistribution = vi.fn().mockResolvedValue("snap");
    (window as any).electronAPI = { getDistribution };
    await loadDistribution();
    await loadDistribution();
    expect(await mount()).toBe("snap");
    expect(getDistribution).toHaveBeenCalledTimes(1);
  });

  it("treats an older preload without the channel, or a rejection, as the direct build", async () => {
    (window as any).electronAPI = {};
    expect(await loadDistribution()).toBe("direct");
    __resetDistributionCache();
    (window as any).electronAPI = { getDistribution: vi.fn().mockRejectedValue(new Error("no")) };
    expect(await loadDistribution()).toBe("direct");
  });
});
