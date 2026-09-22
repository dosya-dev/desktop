/**
 * Whether the main window should appear as soon as it is ready.
 *
 * The app lives in the tray and registers itself as a login item with
 * `openAsHidden`, yet ready-to-show unconditionally called win.show() +
 * win.focus() - so every boot put the window on top of whatever the user was
 * doing (field report 2026-09-02, desktop #13). Pure so `node --test` can
 * pin it; main/index.ts feeds it the real signals.
 */

export function shouldShowOnReady(input: { openedAsHidden: boolean }): boolean {
  return !input.openedAsHidden;
}

/**
 * macOS reports a hidden login launch through getLoginItemSettings()
 * (`wasOpenedAsHidden`); Windows has no such flag, so the login item is
 * registered with `--hidden` and the argument is the signal (see ipc.ts).
 */
export function launchedHidden(input: { argv: readonly string[]; wasOpenedAsHidden: boolean | undefined }): boolean {
  if (input.wasOpenedAsHidden === true) return true;
  return input.argv.includes("--hidden");
}

/** The argument the Windows login item carries so launchedHidden() can see it. */
export const HIDDEN_LAUNCH_ARG = "--hidden";
