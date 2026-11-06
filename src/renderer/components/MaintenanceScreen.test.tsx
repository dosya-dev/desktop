// This app has no @testing-library/react dependency, matching the pattern
// apps/web/src/components/maintenance-screen.test.tsx already established:
// render with react-dom/client directly and query the DOM by hand, wrapped
// in React's own act().
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MaintenanceScreen } from "./MaintenanceScreen";

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

function click(label: string | RegExp) {
  const button = [...document.querySelectorAll("button")].find((node) =>
    typeof label === "string" ? node.textContent?.trim() === label : label.test(node.textContent ?? ""));
  expect(button).toBeDefined();
  return act(async () => { button!.click(); });
}

describe("MaintenanceScreen", () => {
  it("shows the desktop copy, message, and re-checks on demand", async () => {
    const onRetry = vi.fn().mockResolvedValue(false);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root!.render(
        <MaintenanceScreen message="brb" onRetry={onRetry} email="f@x.dev" onSignOut={() => {}} />,
      );
    });

    expect(container.textContent).toContain("The desktop app is paused for maintenance");
    expect(container.textContent).toContain("brb");
    expect(container.textContent).toMatch(/Signed in as f@x\.dev/);

    await click(/Check now/);
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("re-checks every 60 seconds", async () => {
    vi.useFakeTimers();
    try {
      const onRetry = vi.fn().mockResolvedValue(false);
      container = document.createElement("div");
      document.body.appendChild(container);
      root = createRoot(container);
      await act(async () => {
        root!.render(<MaintenanceScreen message={null} onRetry={onRetry} />);
      });

      await act(async () => {
        await vi.advanceTimersByTimeAsync(60_000);
      });

      expect(onRetry).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("in English the team's message carries no dir, so a Hebrew message lays out exactly as before", async () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root!.render(<MaintenanceScreen message={"\u05e0\u05d7\u05d6\u05d5\u05e8 \u05d1-14:00."} onRetry={async () => false} email="f@x.dev" onSignOut={() => {}} />);
    });
    // dir="auto" is set only in a right-to-left language (useAutoDir), on an
    // inline span that keeps the box on the page's alignment; English keeps
    // the bare text, as before.
    expect(container.querySelector("[dir]")).toBeNull();
    const box = container.querySelector(".whitespace-pre-wrap")!;
    expect(box.hasAttribute("dir")).toBe(false);
    expect(box.children.length).toBe(0);
    expect(box.textContent).toBe("\u05e0\u05d7\u05d6\u05d5\u05e8 \u05d1-14:00.");
  });
});

