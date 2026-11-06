import { useEffect, useState } from "react";

/**
 * Keeps a popover mounted for `exitMs` after `open` turns false so its close
 * transition can play, and reports `closing` for that window. Reopening while
 * it closes simply flips `closing` back, so the CSS transition retargets from
 * wherever it is instead of jumping.
 */
export function useExitPresence(open: boolean, exitMs: number): { mounted: boolean; closing: boolean } {
  const [mounted, setMounted] = useState(open);

  useEffect(() => {
    if (open) {
      setMounted(true);
      return;
    }
    const timer = window.setTimeout(() => setMounted(false), exitMs);
    return () => window.clearTimeout(timer);
  }, [open, exitMs]);

  return { mounted: open || mounted, closing: !open && mounted };
}
