/**
 * Native Sign in with Apple, the main-process half.
 *
 * App Review (guideline 4, 2026-11-11) refused the app for finishing "Continue
 * with Apple" in the system browser. The sheet itself is Swift, in the addon
 * (native/.../AppleSignIn.swift); this file decides what to hand it and what to
 * make of its answer, and is deliberately free of `electron` imports so it runs
 * under node:test.
 *
 * The nonce is the app's one contribution to the proof. A fresh random value
 * is made per attempt; Apple is given only its SHA-256 (inside the signed
 * identity token as the `nonce` claim) and the server is given the raw value
 * once, beside the token. A token that did not answer this exact request
 * cannot satisfy both.
 */
import { createHash, randomBytes as nodeRandomBytes } from "node:crypto";
import type { AppleSignInOutcome, AppleSignInProof } from "./apple-sign-in-types";

/** What the addon exports for this, all optional: an addon built before this
 *  module existed simply has no sheet to offer. */
export interface AppleSignInNative {
  appleSignInAvailable?(): boolean;
  signInWithApple?(nonceHash: string): Promise<AppleNativeCredential>;
}

/** The addon's answer, field for field what ASAuthorizationAppleIDCredential
 *  carried. Empty strings for what Apple did not send. */
export interface AppleNativeCredential {
  identityToken: string;
  authorizationCode: string;
  user: string;
  name: string;
  email: string;
}

export type { AppleSignInOutcome, AppleSignInProof } from "./apple-sign-in-types";

/** 32 random bytes as hex: the raw nonce the server receives, and its hash,
 *  the only form Apple ever sees. */
export function makeAppleNonce(randomBytes: (n: number) => Buffer = nodeRandomBytes): { raw: string; hashed: string } {
  const raw = randomBytes(32).toString("hex");
  const hashed = createHash("sha256").update(raw).digest("hex");
  return { raw, hashed };
}

/**
 * Whether the native sheet can be offered: macOS, an addon that has it, and a
 * process entitled to show it. Anything else means the browser flow, which is
 * what Google and GitHub use anyway.
 */
export function appleSignInAvailable(native: AppleSignInNative | null, platform: NodeJS.Platform = process.platform): boolean {
  if (platform !== "darwin" || !native?.appleSignInAvailable) return false;
  try {
    return native.appleSignInAvailable() === true;
  } catch {
    return false;
  }
}

/**
 * Runs the sheet and shapes its answer for the server. The addon's three exact
 * error messages become statuses the renderer can act on without parsing text;
 * anything else is a failure with the message kept for the log.
 */
export async function runAppleSignIn(
  native: AppleSignInNative | null,
  opts: { platform?: NodeJS.Platform; randomBytes?: (n: number) => Buffer } = {},
): Promise<AppleSignInOutcome> {
  if (!appleSignInAvailable(native, opts.platform) || !native?.signInWithApple) return { status: "unavailable" };
  const nonce = makeAppleNonce(opts.randomBytes);
  let credential: AppleNativeCredential;
  try {
    credential = await native.signInWithApple(nonce.hashed);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message === "canceled" || message === "unavailable" || message === "busy") return { status: message };
    return { status: "failed", message };
  }
  if (!credential?.identityToken) return { status: "failed", message: "Apple returned no identity token" };
  const proof: AppleSignInProof = { identity_token: credential.identityToken, nonce: nonce.raw };
  if (credential.authorizationCode) proof.authorization_code = credential.authorizationCode;
  if (credential.name) proof.name = credential.name;
  return { status: "ok", proof };
}
