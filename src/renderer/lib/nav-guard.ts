// apps/desktop/src/renderer/lib/nav-guard.ts
//
// One page at a time may ask to be consulted before the app navigates away
// from it - the text editor with unsaved changes does. React Router's
// useBlocker only works under a data router and the app uses <HashRouter>,
// so instead every app-level way of leaving a page (menu Back/Forward and
// Go, Cmd+[ / Cmd+], mouse side buttons and swipes, tray and dosya:// deep
// links, Sign out) goes through guardNavigation().
//
// Framework-free so it runs under `node --test` (nav-guard.test.ts).

/** Return true to take over (and call `proceed` later, or never); false to let it through. */
export type NavGuard = (proceed: () => void) => boolean;

let current: NavGuard | null = null;

/** Install a guard; the returned function removes it (and only it). */
export function setNavGuard(guard: NavGuard): () => void {
  current = guard;
  return () => {
    if (current === guard) current = null;
  };
}

export function guardNavigation(proceed: () => void): void {
  if (current && current(proceed)) return;
  proceed();
}
