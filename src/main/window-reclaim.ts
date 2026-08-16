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
  let disposed = false;

  const clear = (): void => {
    if (timer !== null) {
      cancel(timer);
      timer = null;
    }
  };

  return {
    onHide() {
      if (disposed || opts.delayMs <= 0) return;
      clear(); // a duplicate hide replaces the timer, never stacks one
      timer = schedule(() => {
        timer = null;
        // Re-check at fire time: quit owns the window during shutdown, and a
        // window shown through a path that bypassed onShow must survive.
        if (!opts.isQuitting() && opts.isHidden()) opts.destroy();
      }, opts.delayMs);
    },
    onShow() {
      clear();
    },
    dispose() {
      disposed = true;
      clear();
    },
  };
}
