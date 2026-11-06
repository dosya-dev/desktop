import { useEffect, useRef } from "react";

/**
 * Run `onClosed` when the window's close button hides the app to the tray.
 *
 * Closing to the tray keeps this renderer alive, so without this a sign-in
 * form reopened from the tray still held the typed password and the last
 * error (QA TC-004/TC-010). Not fired for minimize. A no-op where the bridge
 * lacks the event (component tests, an older preload).
 */
export function useOnClosedToTray(onClosed: () => void): void {
  const latest = useRef(onClosed);
  latest.current = onClosed;
  useEffect(() => {
    const subscribe = window.electronAPI?.onWindowClosedToTray;
    if (typeof subscribe !== "function") return;
    return subscribe(() => latest.current());
  }, []);
}
