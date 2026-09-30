import { useState, useEffect } from "react";

/**
 * Width below which the sidebar drops to icons on its own.
 *
 * The window can now be dragged to 700px. At 260px the expanded sidebar would
 * take more than a third of that, so it collapses before the content has to.
 */
export const NARROW_WINDOW = "(max-width: 1000px)";

export function useNarrowWindow(): boolean {
  const [narrow, setNarrow] = useState(
    () => typeof window !== "undefined" && window.matchMedia(NARROW_WINDOW).matches,
  );
  useEffect(() => {
    const mq = window.matchMedia(NARROW_WINDOW);
    const onChange = (e: MediaQueryListEvent) => setNarrow(e.matches);
    mq.addEventListener("change", onChange);
    setNarrow(mq.matches);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  return narrow;
}
