import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useDebouncedValue } from "./use-debounced-value";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let seen: string[] = [];
function Probe({ value }: { value: string }) {
  seen.push(useDebouncedValue(value, 300));
  return null;
}

describe("useDebouncedValue", () => {
  let root: Root;
  let host: HTMLDivElement;
  beforeEach(() => {
    vi.useFakeTimers();
    seen = [];
    host = document.createElement("div");
    root = createRoot(host);
  });
  afterEach(() => {
    act(() => root.unmount());
    vi.useRealTimers();
  });

  it("returns the first value at once and later values only after a pause", () => {
    act(() => root.render(<Probe value="a" />));
    expect(seen.at(-1)).toBe("a");
    act(() => root.render(<Probe value="ab" />));
    act(() => vi.advanceTimersByTime(200));
    act(() => root.render(<Probe value="abc" />));
    act(() => vi.advanceTimersByTime(200));
    // The pause restarted on "abc", so "ab" never surfaced.
    expect(seen.at(-1)).toBe("a");
    act(() => vi.advanceTimersByTime(100));
    expect(seen.at(-1)).toBe("abc");
    expect(seen).not.toContain("ab");
  });
});
