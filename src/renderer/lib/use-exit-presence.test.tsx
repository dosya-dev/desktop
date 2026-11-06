import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useExitPresence } from "./use-exit-presence";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let last: { mounted: boolean; closing: boolean } = { mounted: false, closing: false };
function Probe({ open }: { open: boolean }) {
  last = useExitPresence(open, 120);
  return null;
}

describe("useExitPresence", () => {
  let root: Root;
  let host: HTMLDivElement;
  beforeEach(() => {
    vi.useFakeTimers();
    host = document.createElement("div");
    root = createRoot(host);
  });
  afterEach(() => {
    act(() => root.unmount());
    vi.useRealTimers();
  });
  const render = (open: boolean) => act(() => root.render(<Probe open={open} />));

  it("stays mounted and closing until the exit time has passed", () => {
    render(true);
    expect(last).toEqual({ mounted: true, closing: false });
    render(false);
    expect(last).toEqual({ mounted: true, closing: true });
    act(() => { vi.advanceTimersByTime(120); });
    expect(last).toEqual({ mounted: false, closing: false });
  });

  it("reopening mid-close cancels the unmount", () => {
    render(true);
    render(false);
    act(() => { vi.advanceTimersByTime(60); });
    render(true);
    act(() => { vi.advanceTimersByTime(200); });
    expect(last).toEqual({ mounted: true, closing: false });
  });

  it("is unmounted from the start when closed", () => {
    render(false);
    expect(last).toEqual({ mounted: false, closing: false });
  });
});
