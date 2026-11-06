/**
 * macOS three-finger "Swipe between pages" as history navigation. Electron
 * reports the swipe's own direction; in a left-to-right language a right swipe
 * is Back, in a right-to-left language the pages run the other way, so the
 * same swipe is Forward. Pure: no Electron import.
 */
export function swipeToHistory(direction: string, dir: "ltr" | "rtl"): "back" | "forward" | null {
  if (direction !== "right" && direction !== "left") return null;
  const back = (direction === "right") === (dir === "ltr");
  return back ? "back" : "forward";
}
