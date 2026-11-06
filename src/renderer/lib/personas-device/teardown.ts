// Ported from apps/web/src/lib/personas-device/teardown.ts - keep the two in step.
//
// Sign-out hook for on-device Personas, kept apart from engine-host so the
// session teardown (lib/session-reset.ts) does not pull the engine into the
// main bundle. engine-host registers its teardown when it loads.
//
// Desktop difference: the signed-in user lives in AuthProvider's React state,
// not in a store a module can read, so AuthProvider hands its user id over
// here (setPersonasUser) and Personas reads it from here. The web app reads
// the same from its useSession store.
const fns = new Set<() => void>();
let tornDown = false;

let userId: string | null = null;
let lastUserId: string | null = null;
const userFns = new Set<() => void>();

/** True from a sign-out teardown until the session's user changes: no engine may be made meanwhile. */
export function personasTornDown(): boolean {
  return tornDown;
}

/** The session's user changed (signed out, or someone signed in): engines may be made again. */
export function resumePersonas(): void {
  tornDown = false;
}

export function onPersonasTeardown(fn: () => void): () => void {
  fns.add(fn);
  return () => fns.delete(fn);
}

/**
 * Stop every read loop, the reader worker and the listing cache without
 * barring new engines (Vault destroy: the user stays signed in and may set the
 * Vault up again).
 */
export function stopPersonas(): void {
  for (const fn of [...fns]) {
    try {
      fn();
    } catch {
      // best effort
    }
  }
}

/** Stop everything and make no new engine until the session's user changes (sign-out). */
export function teardownPersonas(): void {
  tornDown = true;
  stopPersonas();
}

/** The last user id seen, kept after sign-out so the sign-out wipe still knows whose key to remove. */
export function lastPersonasUser(): string | null {
  return userId ?? lastUserId;
}

/** The signed-in user's id, or null while signed out. */
export function personasUser(): string | null {
  return userId;
}

/**
 * AuthProvider calls this whenever its user changes. A different user (signed
 * out, or someone signed in) lifts a sign-out teardown.
 */
export function setPersonasUser(id: string | null): void {
  if (id === userId) return;
  userId = id;
  if (id) lastUserId = id;
  resumePersonas();
  for (const fn of [...userFns]) fn();
}

/** Called after every change of the signed-in user. */
export function subscribePersonasUser(fn: () => void): () => void {
  userFns.add(fn);
  return () => {
    userFns.delete(fn);
  };
}
