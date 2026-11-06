import { ApiError, NetworkError } from "./api-client";
import { t } from "./i18n";

/**
 * The message a sign-in, sign-up, verification or two-factor form shows for a
 * failed request. Server messages for problems the user can fix (wrong code,
 * account exists, locked for N minutes) are shown as the server wrote them.
 * A server-side failure (5xx) never is: its text is for us ("Email delivery
 * not configured"), so the user gets a plain "our side" message instead.
 * Anything else falls back to the form's own message.
 */
export function authErrorMessage(err: unknown, fallback: string): string {
  if (err instanceof NetworkError) return err.message;
  if (err instanceof ApiError) {
    if (err.status >= 500) return t("common.error.somethingWentWrongOnOurSide");
    return err.message || fallback;
  }
  return fallback;
}

/** The API's 403 for an account whose email was never verified. */
export function isEmailUnverifiedError(err: unknown): boolean {
  return err instanceof ApiError && err.status === 403 && err.data.code === "email_unverified";
}
