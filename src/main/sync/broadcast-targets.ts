/**
 * Which windows a status broadcast is worth sending to.
 *
 * `broadcast()` sent to every window unconditionally, so a window the user
 * cannot see kept paying for a structured clone and a full React commit twice
 * a second until memory reclaim destroyed it 5-10 minutes later (DSK-003:
 * measured 2.00 commits/s and ~1.9% of a core with the window hidden).
 *
 * `isMinimized()` is checked as well as `isVisible()` because Electron's
 * `isVisible()` for a minimized window is documented to differ by platform;
 * on macOS 15.7.4 it returns false, which is why reclaim already worked there
 * by accident. Either signal is enough to skip.
 *
 * Pure (structural window type, no electron import) so `node --test` can load it.
 */
export interface WindowVisibility {
  isDestroyed(): boolean;
  isVisible(): boolean;
  isMinimized(): boolean;
}

export function shouldReceiveStatus(win: WindowVisibility): boolean {
  try {
    if (win.isDestroyed()) return false;
    if (win.isMinimized()) return false;
    return win.isVisible();
  } catch {
    // A window torn down between the check and here is not a target.
    return false;
  }
}
