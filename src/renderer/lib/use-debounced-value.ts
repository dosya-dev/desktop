// Ported from apps/web/src/hooks/use-debounced-value.ts - keep in sync
import { useState, useEffect } from "react";

/**
 * Returns `value` only after it has stopped changing for `delayMs`.
 *
 * Used to keep a text input responsive while the expensive consequence of
 * typing (a request, a URL write) fires once per pause instead of once per
 * keystroke. The first value is returned immediately so the initial render
 * is not delayed.
 */
export function useDebouncedValue<T>(value: T, delayMs = 300): T {
  const [debounced, setDebounced] = useState(value);

  useEffect(() => {
    if (value === debounced) return;
    const t = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(t);
    // `debounced` is read only to skip a no-op timer; including it would
    // restart the timer on every settle.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, delayMs]);

  return debounced;
}
