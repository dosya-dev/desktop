/**
 * What "Restart and install" does once an update has downloaded.
 *
 * Electron's quitAndInstall() closes every window first and only quits once
 * they are all gone - and it does that BEFORE emitting before-quit, which is
 * where markQuitting() normally runs. The main window's close handler treats a
 * close without a quit in progress as "hide to tray", so the window hid, none
 * ever closed, and the app sat in the tray with the update uninstalled. The
 * quit has to be marked before quitAndInstall() is called.
 *
 * Kept free of Electron imports so the ordering is unit-testable.
 */
export interface InstallDeps {
  /** Tell the renderer the install has begun, before the windows start closing. */
  announceInstalling: () => void;
  markQuitting: () => void;
  quitAndInstall: () => void;
  showDownloadedFile: () => void;
}

export function installDownloadedUpdate(platform: NodeJS.Platform, deps: InstallDeps): void {
  if (platform === "linux") {
    // On Linux, quitAndInstall() is unreliable for AppImage.
    // Show the downloaded file so the user can install manually.
    deps.showDownloadedFile();
    return;
  }
  deps.announceInstalling();
  deps.markQuitting();
  deps.quitAndInstall();
}

/**
 * Backstop for a quitAndInstall() that never finishes quitting.
 *
 * Electron proceeds with the install only once every window has closed. On
 * 3.1.2 the close handler hid the window instead (see above), and the only
 * thing that eventually closed it was the memory reclaimer, five minutes
 * later - which is why "Restart and install" appeared to take ten minutes.
 * The real fix marks the quit first; this exists so that any future
 * regression of that shape costs seconds, not minutes: once the quit has
 * begun, a window still open after `timeoutMs` is destroyed outright.
 *
 * `hasWindows`/`destroyWindows` are injected so the timing is testable
 * without Electron. Re-arming replaces the pending timer, never stacks one.
 */
export interface QuitWatchdogOptions {
  timeoutMs: number;
  hasWindows: () => boolean;
  destroyWindows: () => void;
  schedule?: (fn: () => void, ms: number) => unknown;
  cancel?: (handle: unknown) => void;
}

export interface QuitWatchdog {
  rearm(): void;
}

export function armQuitWatchdog(opts: QuitWatchdogOptions): QuitWatchdog {
  const schedule = opts.schedule ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const cancel = opts.cancel ?? ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  let timer: unknown = null;

  const arm = (): void => {
    if (timer !== null) cancel(timer);
    timer = schedule(() => {
      timer = null;
      if (opts.hasWindows()) opts.destroyWindows();
    }, opts.timeoutMs);
  };

  arm();
  return { rearm: arm };
}
