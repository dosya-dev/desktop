/**
 * Whether the app is genuinely quitting, as opposed to the window being closed
 * to the tray.
 *
 * This used to be smuggled around as `(app as any).isQuitting` - a property
 * Electron's `App` does not declare, set and read from four places across two
 * modules. The cast silenced the compiler in both directions: a typo in the
 * property name, or Electron introducing a real `isQuitting` with different
 * semantics, would both have failed silently at runtime.
 */

let quitting = false;

export function markQuitting(): void {
  quitting = true;
}

export function isQuitting(): boolean {
  return quitting;
}
