// Swipe navigation in a right-to-left layout: the back button sits on the
// right, so a swipe mirrors (as Chromium's own overscroll navigation does in
// RTL locales), and a sideways scroller inside an RTL page reports its scroll
// position as zero or negative.
import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { canScrollX, mirrorSwipe, swipeEdge } from "./use-history-nav";

function scroller(opts: { dir: "ltr" | "rtl"; scrollLeft: number; scrollWidth?: number; clientWidth?: number }): HTMLElement {
  const el = document.createElement("div");
  el.style.overflowX = "auto";
  el.style.direction = opts.dir;
  Object.defineProperty(el, "scrollWidth", { configurable: true, value: opts.scrollWidth ?? 500 });
  Object.defineProperty(el, "clientWidth", { configurable: true, value: opts.clientWidth ?? 200 });
  el.scrollLeft = opts.scrollLeft;
  Object.defineProperty(el, "scrollLeft", { configurable: true, value: opts.scrollLeft });
  const child = document.createElement("span");
  el.appendChild(child);
  document.body.appendChild(el);
  return child;
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("canScrollX", () => {
  it("left-to-right: at the start it can only scroll right", () => {
    const at = scroller({ dir: "ltr", scrollLeft: 0 });
    expect(canScrollX(at, -10)).toBe(false);
    expect(canScrollX(at, 10)).toBe(true);
  });

  it("left-to-right: at the far end it can only scroll left", () => {
    const at = scroller({ dir: "ltr", scrollLeft: 300 });
    expect(canScrollX(at, -10)).toBe(true);
    expect(canScrollX(at, 10)).toBe(false);
  });

  it("right-to-left at its start (scrollLeft 0, flush right) can scroll left, not right", () => {
    const at = scroller({ dir: "rtl", scrollLeft: 0 });
    expect(canScrollX(at, -10)).toBe(true);
    expect(canScrollX(at, 10)).toBe(false);
  });

  it("right-to-left part way (negative scrollLeft) can scroll both ways", () => {
    const at = scroller({ dir: "rtl", scrollLeft: -120 });
    expect(canScrollX(at, -10)).toBe(true);
    expect(canScrollX(at, 10)).toBe(true);
  });

  it("right-to-left at its far end (scrollLeft -300) can only scroll right", () => {
    const at = scroller({ dir: "rtl", scrollLeft: -300 });
    expect(canScrollX(at, -10)).toBe(false);
    expect(canScrollX(at, 10)).toBe(true);
  });

  it("an element that does not overflow is not a scroller", () => {
    const at = scroller({ dir: "rtl", scrollLeft: 0, scrollWidth: 200, clientWidth: 200 });
    expect(canScrollX(at, -10)).toBe(false);
    expect(canScrollX(at, 10)).toBe(false);
  });
});

describe("mirrorSwipe", () => {
  it("is the identity in left-to-right", () => {
    expect(mirrorSwipe("back", "ltr")).toBe("back");
    expect(mirrorSwipe("forward", "ltr")).toBe("forward");
    expect(mirrorSwipe(null, "ltr")).toBe(null);
  });

  it("swaps back and forward in right-to-left", () => {
    expect(mirrorSwipe("back", "rtl")).toBe("forward");
    expect(mirrorSwipe("forward", "rtl")).toBe("back");
    expect(mirrorSwipe(null, "rtl")).toBe(null);
  });
});

describe("swipeEdge", () => {
  it("shows back on the left and forward on the right in left-to-right", () => {
    expect(swipeEdge("back", "ltr")).toBe("left");
    expect(swipeEdge("forward", "ltr")).toBe("right");
  });

  it("shows back on the right and forward on the left in right-to-left", () => {
    expect(swipeEdge("back", "rtl")).toBe("right");
    expect(swipeEdge("forward", "rtl")).toBe("left");
  });
});

describe("HistoryNavigation two-finger swipe", () => {
  // A trackpad swipe with natural scrolling: fingers moving left send positive deltaX.
  async function swipeFingersLeft(locale: "ar" | "en"): Promise<{ path: string; edge: string | null; ltrIsland: boolean }> {
    Object.defineProperty(navigator, "platform", { configurable: true, value: "MacIntel" });
    (window as { navigation?: unknown }).navigation = { canGoBack: true, canGoForward: true };
    vi.resetModules();
    const { HistoryNavigation } = await import("./use-history-nav");
    const { renderInLocale } = await import("../test-utils/rtl");
    const { MemoryRouter, useLocation } = await import("react-router-dom");
    let path = "";
    const Where = () => {
      path = useLocation().pathname;
      return null;
    };
    const view = await renderInLocale(
      <MemoryRouter initialEntries={["/a", "/b", "/c"]} initialIndex={1}>
        <HistoryNavigation />
        <Where />
      </MemoryRouter>,
      locale,
    );
    let edge: string | null = null;
    let ltrIsland = false;
    const wheel = async (deltaX: number) => {
      await act(async () => {
        window.dispatchEvent(new WheelEvent("wheel", { deltaX, deltaY: 0 }));
      });
    };
    await wheel(40);
    const indicator = document.querySelector<HTMLElement>("[data-testid=swipe-nav-indicator]");
    if (indicator) {
      edge = indicator.style.left !== "" ? "left" : indicator.style.right !== "" ? "right" : null;
      ltrIsland = indicator.getAttribute("dir") === "ltr";
    }
    for (let i = 0; i < 5; i++) await wheel(40);
    view.unmount();
    return { path, edge, ltrIsland };
  }

  it("fingers moving left go forward in en, with the arrow at the right edge", async () => {
    expect(await swipeFingersLeft("en")).toEqual({ path: "/c", edge: "right", ltrIsland: true });
  });

  it("fingers moving left go back in ar, with the arrow at the right edge", async () => {
    expect(await swipeFingersLeft("ar")).toEqual({ path: "/a", edge: "right", ltrIsland: true });
  });
});
