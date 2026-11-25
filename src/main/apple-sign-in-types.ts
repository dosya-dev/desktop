/**
 * The shapes native Sign in with Apple passes between main, preload and the
 * renderer. Kept apart from apple-sign-in.ts, which imports node:crypto, so the
 * renderer's typecheck can see these without seeing Node.
 */

/** The body /api/auth/desktop/apple takes. */
export interface AppleSignInProof {
  identity_token: string;
  /** The raw nonce; Apple was only ever given its SHA-256. */
  nonce: string;
  authorization_code?: string;
  name?: string;
}

export type AppleSignInOutcome =
  | { status: "ok"; proof: AppleSignInProof }
  /** The user dismissed the sheet. Not an error; nothing to show. */
  | { status: "canceled" }
  /** No sheet on this build or this Mac: the caller falls back to the browser. */
  | { status: "unavailable" }
  /** A sheet is already up for an earlier click. */
  | { status: "busy" }
  | { status: "failed"; message: string };
