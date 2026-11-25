/**
 * The renderer half of native Sign in with Apple.
 *
 * App Review (guideline 4, 2026-11-11) refused the app for sending "Continue
 * with Apple" to the system browser. On an entitled macOS build the Apple
 * button now runs Apple's own sheet inside the app (main/apple-sign-in.ts and
 * the Swift behind it) and posts the proof to /api/auth/desktop/apple, which
 * answers like /api/auth/login does: a session cookie, or a 2FA challenge.
 * Everywhere else - Windows, Linux, a dev run, a build without the entitlement
 * - the caller keeps the browser flow Google and GitHub use.
 *
 * Both sign-in and sign-up call this; the pages differ only in what they say
 * when it fails, so the words stay with them.
 */
import { api } from "./api-client";

export type NativeAppleResult =
  /** Signed in. The session cookie is set; the caller waits for it and loads the user. */
  | { kind: "signed-in" }
  /** The account has 2FA; the challenge cookie is set and the 2FA page takes over. */
  | { kind: "2fa"; method?: string }
  /** The user dismissed the sheet, or another sheet is already up. Nothing to show. */
  | { kind: "dismissed" }
  /** No sheet here: the caller runs the browser flow instead. */
  | { kind: "unavailable" }
  /** The sheet or the server failed; `error` is the thrown value for the log. */
  | { kind: "failed"; error: unknown };

/** Whether this build can show Apple's sheet. False wherever the IPC is missing. */
export async function nativeAppleSignInAvailable(): Promise<boolean> {
  try {
    return (await window.electronAPI.appleSignInAvailable?.()) === true;
  } catch {
    return false;
  }
}

export async function runNativeAppleSignIn(): Promise<NativeAppleResult> {
  if (!(await nativeAppleSignInAvailable())) return { kind: "unavailable" };

  let outcome: Awaited<ReturnType<typeof window.electronAPI.appleSignIn>>;
  try {
    outcome = await window.electronAPI.appleSignIn();
  } catch (error) {
    return { kind: "failed", error };
  }
  switch (outcome.status) {
    case "canceled":
    case "busy":
      return { kind: "dismissed" };
    case "unavailable":
      return { kind: "unavailable" };
    case "failed":
      return { kind: "failed", error: new Error(outcome.message) };
    case "ok":
      break;
  }

  try {
    const data = await api.post<{ ok: boolean; requires_2fa?: boolean; method?: string }>(
      "/api/auth/desktop/apple",
      outcome.proof,
    );
    if (data.requires_2fa) return { kind: "2fa", method: data.method };
    if (!data.ok) return { kind: "failed", error: new Error("sign-in refused") };
    return { kind: "signed-in" };
  } catch (error) {
    return { kind: "failed", error };
  }
}
