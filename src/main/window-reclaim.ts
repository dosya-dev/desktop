/**
 * Decides WHEN a hidden window's renderer should be destroyed to reclaim its
 * memory. Pure logic - the clock and the window probes are injected so
 * `npm run test:unit` can drive it without Electron (same pattern as
 * deep-link.ts and sync/device-id.ts).
 */

export interface WindowReclaimerOptions {
  /** How long the window must stay hidden before it is destroyed. <= 0 disables reclaim. */
  delayMs: number;
  /** True while the app is quitting - quit's own shutdown owns the window then. */
  isQuitting: () => boolean;
  /** True while the window still exists and is not visible to the user. */
  isHidden: () => boolean;
  /** Actually tear the window down. Only ever called when the checks above hold. */
  destroy: () => void;
  /**
   * How often to re-check visibility as a backstop for a hide we were never
   * told about. Omit to disable the backstop entirely.
   *
   * This exists because Electron's "hide" event is not reliably delivered. On
   * macOS 24.6 / Electron 43, `win.hide()` flips `isVisible()` to false without
   * emitting it at all - reproduced against the real app with the app forced
   * frontmost. An event-only reclaimer therefore never arms its timer, the
   * renderer is never torn down, and the memory this feature exists to give
   * back is silently kept forever. Polling is the only thing that survives an
   * event the platform declines to send.
   */
  verifyIntervalMs?: number;
  /** Injected clock for tests; defaults to the real timers. */
  schedule?: (fn: () => void, ms: number) => unknown;
  cancel?: (handle: unknown) => void;
}

export interface WindowReclaimer {
  onHide(): void;
  onShow(): void;
  dispose(): void;
}

export function createWindowReclaimer(opts: WindowReclaimerOptions): WindowReclaimer {
  const schedule = opts.schedule ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const cancel = opts.cancel ?? ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>));

  let timer: unknown = null;
  let verifyTimer: unknown = null;
  let disposed = false;

  const clear = (): void => {
    if (timer !== null) {
      cancel(timer);
      timer = null;
    }
  };

  const armDestroy = (): void => {
    if (disposed || opts.delayMs <= 0) return;
    clear(); // a duplicate hide replaces the timer, never stacks one
    timer = schedule(() => {
      timer = null;
      // Re-check at fire time: quit owns the window during shutdown, and a
      // window shown through a path that bypassed onShow must survive.
      if (!opts.isQuitting() && opts.isHidden()) opts.destroy();
    }, opts.delayMs);
  };

  /**
   * Periodically notice a window that is hidden without a pending destroy -
   * i.e. a hide whose event never arrived. Deliberately arms the SAME timer
   * rather than destroying on the spot, so the "hidden for delayMs" contract
   * still holds; a missed event costs at most one extra interval, never a
   * premature teardown.
   */
  const armVerify = (): void => {
    const interval = opts.verifyIntervalMs;
    if (disposed || opts.delayMs <= 0 || interval === undefined || interval <= 0) return;
    verifyTimer = schedule(() => {
      verifyTimer = null;
      if (disposed) return;
      if (timer === null && !opts.isQuitting() && opts.isHidden()) armDestroy();
      armVerify();
    }, interval);
  };

  armVerify();

  return {
    onHide() {
      if (disposed) return;
      armDestroy();
    },
    onShow() {
      clear();
    },
    dispose() {
      disposed = true;
      clear();
      if (verifyTimer !== null) {
        cancel(verifyTimer);
        verifyTimer = null;
      }
    },
  };
}
