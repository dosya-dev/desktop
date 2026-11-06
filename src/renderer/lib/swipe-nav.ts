/**
 * Two-finger horizontal swipe -> history back/forward, as browsers do.
 *
 * Electron does not turn trackpad overscroll into navigation, and its
 * BrowserWindow "swipe" event only fires for the three-finger setting, so a
 * Mac user with the default two-finger "Swipe between pages" got nothing.
 * Trackpad swipes arrive as a burst of wheel events; this tracker folds one
 * burst into at most one navigation. Pure (no DOM) so node:test covers it.
 */

/** Horizontal travel, in wheel pixels, that commits the navigation. */
export const SWIPE_TRIGGER_PX = 140;
/** A gap this long between wheel events ends the gesture (momentum included). */
export const SWIPE_IDLE_MS = 200;

export type SwipeDir = "back" | "forward";

export interface WheelSample {
  deltaX: number;
  deltaY: number;
  /** WheelEvent.webkitDirectionInvertedFromDevice: true with macOS natural scrolling. */
  inverted: boolean;
  /** Pinch-zoom arrives as ctrl+wheel; Shift+wheel is a mouse scrolling sideways. */
  ctrlKey: boolean;
  shiftKey: boolean;
  /** An element under the pointer can still scroll this way: the swipe belongs to it. */
  scrollableX: boolean;
  time: number;
}

export interface SwipeState {
  /** 0..1 toward the trigger, for the edge indicator; 0 when idle or ignored. */
  progress: number;
  dir: SwipeDir | null;
  /** Set exactly once per gesture, when it commits. */
  fire: SwipeDir | null;
}

/** Fingers moving right means "back", whichever way the content scrolls. */
export function swipeDirection(accumX: number, inverted: boolean): SwipeDir {
  const fingersRight = inverted ? accumX < 0 : accumX > 0;
  return fingersRight ? "back" : "forward";
}

export function createSwipeTracker() {
  let lastTime = -Infinity;
  let accum = 0;
  let mode: "undecided" | "track" | "ignore" | "done" = "undecided";

  return function feed(s: WheelSample): SwipeState {
    if (s.time - lastTime > SWIPE_IDLE_MS) {
      accum = 0;
      mode = "undecided";
    }
    lastTime = s.time;
    const idle: SwipeState = { progress: 0, dir: null, fire: null };

    if (mode === "undecided") {
      // The first event decides the whole gesture: a mostly vertical scroll,
      // a pinch, a mouse Shift+wheel, or a swipe that a sideways-scrolling
      // element can absorb is not a navigation.
      if (s.ctrlKey || s.shiftKey || s.scrollableX || Math.abs(s.deltaY) >= Math.abs(s.deltaX) || s.deltaX === 0) {
        mode = "ignore";
      } else {
        mode = "track";
      }
    }
    if (mode !== "track") return idle;

    accum += s.deltaX;
    const dir = swipeDirection(accum, s.inverted);
    if (Math.abs(accum) >= SWIPE_TRIGGER_PX) {
      // Momentum keeps sending events after the fingers lift; "done" swallows
      // them until the burst goes quiet, so one swipe is one navigation.
      mode = "done";
      return { progress: 0, dir: null, fire: dir };
    }
    return { progress: Math.abs(accum) / SWIPE_TRIGGER_PX, dir, fire: null };
  };
}
