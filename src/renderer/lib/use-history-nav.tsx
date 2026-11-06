import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { createSwipeTracker, type SwipeDir } from "./swipe-nav";
import { guardNavigation } from "./nav-guard";
import { currentDir } from "./i18n";

/** Navigation API (Chromium 102+); history.length is the fallback for back. */
export function historyCan(): { back: boolean; forward: boolean } {
  const nav = (window as { navigation?: { canGoBack?: boolean; canGoForward?: boolean } }).navigation;
  return { back: nav?.canGoBack ?? window.history.length > 1, forward: nav?.canGoForward ?? false };
}

/**
 * Whether an element under the pointer can still scroll sideways in this
 * direction (deltaX < 0 is toward the left). A right-to-left scroller starts
 * flush right with scrollLeft 0 and goes negative as it scrolls left, so its
 * position is measured from the start edge with Math.abs.
 */
export function canScrollX(start: EventTarget | null, deltaX: number): boolean {
  for (let el = start instanceof Element ? start : null; el && el !== document.body; el = el.parentElement) {
    const max = el.scrollWidth - el.clientWidth;
    if (max <= 1) continue;
    const style = getComputedStyle(el);
    if (style.overflowX !== "auto" && style.overflowX !== "scroll") continue;
    const rtl = style.direction === "rtl";
    const fromStart = rtl ? Math.abs(el.scrollLeft) : el.scrollLeft;
    const towardStart = rtl ? deltaX > 0 : deltaX < 0;
    if (towardStart ? fromStart > 0 : fromStart < max - 1) return true;
  }
  return false;
}

/**
 * The swipe tracker reads fingers-right as back, which is right for a
 * left-to-right page. In right-to-left the back button sits on the right, so
 * the gesture mirrors, as Chromium's own overscroll navigation does there.
 */
export function mirrorSwipe(dir: SwipeDir | null, uiDir: "ltr" | "rtl"): SwipeDir | null {
  if (uiDir === "ltr" || dir === null) return dir;
  return dir === "back" ? "forward" : "back";
}

/** The window edge the swipe arrow grows from: the side of the button it stands for. */
export function swipeEdge(dir: SwipeDir, uiDir: "ltr" | "rtl"): "left" | "right" {
  return (dir === "back") === (uiDir === "ltr") ? "left" : "right";
}

const IS_MAC = typeof navigator !== "undefined" && /Mac/i.test(navigator.platform);

/**
 * App-wide back/forward input besides the menu (Cmd+[ / Cmd+]):
 * - macOS two-finger swipe (wheel bursts), with an edge arrow while swiping;
 * - mouse side buttons (button 3 back, 4 forward) on every platform.
 * The three-finger swipe setting arrives from main as a "go-back"/"go-forward"
 * menu action, handled by MenuBridge like the menu items.
 * Renders the swipe indicator; mount once inside the router.
 */
export function HistoryNavigation() {
  const navigate = useNavigate();
  const [swipe, setSwipe] = useState<{ dir: SwipeDir; progress: number; edge: "left" | "right" } | null>(null);
  const hideTimer = useRef<number | null>(null);

  useEffect(() => {
    const go = (dir: SwipeDir) => {
      const can = historyCan();
      if (dir === "back" && can.back) guardNavigation(() => navigate(-1));
      if (dir === "forward" && can.forward) guardNavigation(() => navigate(1));
    };

    const feed = createSwipeTracker();
    let gestureScrollable: boolean | null = null;
    let lastWheel = 0;
    const onWheel = (e: WheelEvent) => {
      // Decide "does this belong to a scroller?" once per burst, at its start.
      if (e.timeStamp - lastWheel > 200) gestureScrollable = null;
      lastWheel = e.timeStamp;
      if (gestureScrollable === null) gestureScrollable = canScrollX(e.target, e.deltaX);
      const r = feed({
        deltaX: e.deltaX,
        deltaY: e.deltaY,
        inverted: (e as WheelEvent & { webkitDirectionInvertedFromDevice?: boolean }).webkitDirectionInvertedFromDevice ?? true,
        ctrlKey: e.ctrlKey,
        shiftKey: e.shiftKey,
        scrollableX: gestureScrollable,
        time: e.timeStamp,
      });
      if (hideTimer.current) window.clearTimeout(hideTimer.current);
      // Read at event time: the language can change while the app runs.
      const uiDir = currentDir();
      const fire = mirrorSwipe(r.fire, uiDir);
      const dir = mirrorSwipe(r.dir, uiDir);
      if (fire) {
        setSwipe(null);
        go(fire);
        return;
      }
      const can = historyCan();
      if (dir && (dir === "back" ? can.back : can.forward)) {
        setSwipe({ dir, progress: r.progress, edge: swipeEdge(dir, uiDir) });
        // Fingers lifted short of the trigger: let the arrow slide away.
        hideTimer.current = window.setTimeout(() => setSwipe(null), 220);
      } else {
        setSwipe(null);
      }
    };

    const onMouseUp = (e: MouseEvent) => {
      if (e.button === 3) { e.preventDefault(); go("back"); }
      if (e.button === 4) { e.preventDefault(); go("forward"); }
    };

    if (IS_MAC) window.addEventListener("wheel", onWheel, { passive: true });
    window.addEventListener("mouseup", onMouseUp);
    return () => {
      window.removeEventListener("wheel", onWheel);
      window.removeEventListener("mouseup", onMouseUp);
      if (hideTimer.current) window.clearTimeout(hideTimer.current);
    };
  }, [navigate]);

  if (!swipe) return null;
  // The arrow points at the edge it grows from, so it is placed and drawn
  // physically, inside its own left-to-right island.
  const Icon = swipe.edge === "left" ? ChevronLeft : ChevronRight;
  const offset = -44 + swipe.progress * 60;
  return (
    <div
      aria-hidden
      dir="ltr"
      data-testid="swipe-nav-indicator"
      className="pointer-events-none fixed top-1/2 z-[400] flex h-10 w-10 items-center justify-center rounded-full border bg-[var(--color-bg)] shadow-lg"
      style={{
        [swipe.edge]: offset, // rtl-ok: mirrored, swipeEdge picks the side
        transform: "translateY(-50%)",
        opacity: Math.min(1, 0.3 + swipe.progress),
        borderColor: "var(--color-border)",
      }}
    >
      <Icon size={20} className={swipe.progress >= 0.95 ? "text-[var(--color-primary)]" : "text-[var(--color-text-secondary)]"} />
    </div>
  );
}
