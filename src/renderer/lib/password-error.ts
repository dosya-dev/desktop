import { LIMITS, validatePassword } from "@dosya-dev/shared";
import { t } from "./i18n";

/**
 * validatePassword()'s verdict in the chosen language, or null when the
 * password is acceptable. The shared validator stays the single rule; only
 * its English sentence is replaced, with the same limits as arguments.
 */
export function passwordError(password: string): string | null {
  if (validatePassword(password) === null) return null;
  return password.length < LIMITS.PASSWORD_MIN
    ? t("common.error.passwordMustBeAtLeastMinCharacters", { min: LIMITS.PASSWORD_MIN })
    : t("common.error.passwordMustBeAtMostMaxCharacters", { max: LIMITS.PASSWORD_MAX });
}
