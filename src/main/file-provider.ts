/**
 * Puts dosya.dev under Locations in the Finder sidebar, by handing the File
 * Provider extension in Contents/PlugIns a session of its own and registering
 * the domain. Ported from apps/mobile/src/filesProvider/link.ts, because the
 * problem and its ordering rules are the same on both platforms.
 *
 * The extension is a separate process with no access to Electron's cookie jar,
 * so it cannot present the desktop's session cookie, and it must not share the
 * app's session either: both would rotate the same refresh token, the server
 * keeps one generation of grace, and whichever lost the race would sign the user
 * out. So the app mints it a LINKED session - a second session row, parented to
 * this one and revoked with it - and writes it to the keychain group the two
 * share. This side never reads that entry back; it only asks whose it is.
 *
 * Every entry point is best-effort. A Finder location is a convenience, and
 * nothing here may block sign-in, sign-out, or the purge that runs between
 * accounts.
 */

/** What the native addon exports. Identical to the mobile module's interface. */
export interface FileProviderNative {
  isSupported(): boolean;
  storedUserId(): string | null;
  writeSession(json: string): void;
  clearSession(): void;
  registerDomain(): Promise<boolean>;
  removeDomain(): Promise<boolean>;
  signalChanges(): Promise<boolean>;
  /** Whether the user has approved the provider; null when no domain exists. */
  domainEnabled(): Promise<boolean | null>;
}

/** What POST /api/auth/desktop/linked-session gives us, as the extension wants it. */
export interface MintedSession {
  access: string;
  refresh: string;
  apiBaseUrl: string;
}

export interface FileProviderDeps {
  /** Null on every platform but macOS, and on a build with no addon. */
  native: FileProviderNative | null;
  mint: () => Promise<MintedSession>;
  /** How long to wait for a native call. The addon has no timeout of its own:
   *  it waits on macOS, and macOS may take as long as it likes. */
  waitMs?: number;
}

const DEFAULT_WAIT_MS = 30_000;

/** Thrown inside a link when this build can offer no location at all, so the
 *  caller hears "not linked" rather than a success it cannot have. Not a
 *  failure worth logging, which is why it carries no message worth reading. */
class NoLocationPossible extends Error {
  constructor() {
    super("no Finder location is possible in this build");
  }
}

/**
 * `promise`, bounded by `waitMs`. On expiry the settle callback decides what
 * that means, because the two kinds of call here want opposite things.
 *
 * Deliberately NOT unref'd. An unreferenced timer does not fire when nothing
 * else holds the event loop open, which is precisely the case during teardown,
 * where an unresolved wait would strand the sign-out waiting on it.
 */
function bounded<T>(
  promise: Promise<T>,
  ms: number,
  onExpiry: (resolve: (value: T) => void, reject: (error: Error) => void) => void,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => onExpiry(resolve, reject), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/**
 * A native call, given up on after `waitMs`. Giving up resolves false rather
 * than rejecting: a domain that did not register is the same outcome to this
 * module whether macOS refused or never answered, and the difference must not
 * hold the queue for the rest of the session.
 */
function waitFor(promise: Promise<boolean>, deps: FileProviderDeps): Promise<boolean> {
  return bounded(promise, deps.waitMs ?? DEFAULT_WAIT_MS, (resolve) => resolve(false));
}

/**
 * The mint, bounded by the same deadline. This one REJECTS on expiry, for two
 * reasons: an unfinished mint must abort the link rather than write a session it
 * never received, and the mint is an unbounded fetch on a queue that sign-out
 * shares - `undici` has no overall deadline, so a black-holed network would
 * otherwise hold the sign-out teardown for as long as it stayed black-holed.
 */
function mintWithin(deps: FileProviderDeps): Promise<MintedSession> {
  return bounded(deps.mint(), deps.waitMs ?? DEFAULT_WAIT_MS, (_resolve, reject) =>
    reject(new Error("the linked session did not arrive in time")),
  );
}

// Link and unlink run strictly one after another. An account switch fires both
// at once - the purge of the old account and the link of the new one - and the
// purge's removeDomain landing after the link's registerDomain would leave the
// new account with no Finder location until the next launch.
let queue: Promise<void> = Promise.resolve();

/**
 * Runs `op` after everything already queued, and reports whether it finished.
 * Failures are logged and swallowed - every entry point here is best-effort -
 * but the boolean is what lets a caller that shows the user something, like the
 * Settings switch, avoid reporting a success it did not have.
 */
function serialized(op: () => Promise<void>): Promise<boolean> {
  let finished = false;
  const run = queue
    .then(op)
    .then(() => {
      finished = true;
    })
    .catch((e) => {
      console.warn("[fileProvider]", e instanceof Error ? e.message : e);
    });
  queue = run;
  return run.then(() => finished);
}

// A sign-in and a profile refresh arriving together must not mint two linked
// sessions, the second of which revokes the first. A plain link joins whatever
// is pending for the account; a fresh re-mint joins only another fresh re-mint,
// since the pending plain link may be keeping a dead session.
let pendingLink: { userId: string; fresh: boolean; promise: Promise<boolean> } | null = null;

function link(userId: string, fresh: boolean, deps: FileProviderDeps): Promise<boolean> {
  if (pendingLink?.userId === userId && (!fresh || pendingLink.fresh)) return pendingLink.promise;
  const promise = serialized(async () => {
    const native = deps.native;
    if (!native || !native.isSupported()) throw new NoLocationPossible();

    const stored = native.storedUserId();
    if (stored === userId && !fresh) {
      await waitFor(native.registerDomain(), deps);
      await waitFor(native.signalChanges(), deps);
      return;
    }

    // Another account's session, and the files macOS downloaded for it, must
    // never survive into this one: drop the domain first, which deletes them.
    if (stored && stored !== userId) {
      native.clearSession();
      await waitFor(native.removeDomain(), deps);
    }

    // Mint before overwriting: a failed mint leaves whatever was stored, which
    // is either nothing or this account's previous session.
    const session = await mintWithin(deps);
    native.writeSession(JSON.stringify({ ...session, userId }));
    await waitFor(native.registerDomain(), deps);
  }).finally(() => {
    if (pendingLink?.promise === promise) pendingLink = null;
  });
  pendingLink = { userId, fresh, promise };
  return promise;
}

/**
 * Make sure the extension holds a session for `userId` and the location is
 * registered. Mints only when nothing is stored or what is stored belongs to
 * another account. Runs whenever /api/me confirms who is signed in: the
 * extension wipes its own entry once the server rejects its refresh, and the
 * next of these calls is what replaces it.
 */
export function linkFileProvider(userId: string, deps: FileProviderDeps): Promise<boolean> {
  return link(userId, false, deps);
}

/**
 * Fresh sign-in: mint even if a session is stored for this account. The
 * extension's session is a child of the app's and the server kills it with its
 * parent, so anything stored across a sign-out is dead, and a plain link would
 * keep it and leave Finder asking to sign in. The location and its downloaded
 * files stay: they belong to this same account.
 */
export function relinkFileProvider(userId: string, deps: FileProviderDeps): Promise<boolean> {
  return link(userId, true, deps);
}

/**
 * Sign-out and account purge: forget the extension's session and remove the
 * location together with every file macOS downloaded for it. The server side of
 * the linked session is revoked by the app's own logout call, which orphans it.
 *
 * `accountId` is the account being purged. When the stored session already
 * belongs to someone else - the account that just signed in and linked first -
 * it is left alone. Null means "whoever it is".
 */
export function unlinkFileProvider(accountId: string | null, deps: FileProviderDeps): Promise<void> {
  // Before queueing, not inside: a link requested after this call must enqueue
  // its own work rather than be deduped into whatever was pending. Otherwise
  // switching the Finder location off and straight back on ends with the
  // preference on, nothing stored, and no location until the next launch.
  pendingLink = null;
  return serialized(async () => {
    const native = deps.native;
    if (!native) return;
    const stored = native.storedUserId();
    if (accountId && stored && stored !== accountId) return;
    native.clearSession();
    await waitFor(native.removeDomain(), deps);
  }).then(() => undefined);
}

/** Nudge Finder to pick up changes the app just made. */
export async function signalFileProvider(deps: FileProviderDeps): Promise<void> {
  const native = deps.native;
  if (!native || !native.isSupported()) return;
  try {
    await waitFor(native.signalChanges(), deps);
  } catch {
    /* best-effort */
  }
}

/** Test hook. */
export function __resetFileProviderLink(): void {
  queue = Promise.resolve();
  pendingLink = null;
}
