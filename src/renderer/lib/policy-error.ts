import {
  LIMITS, checkUploadFile, extensionOf, splitFolderPath,
  validateFileName, validateFolderName, validateFolderPath, validateFolderPathShape, validateFolderSegment,
  type UploadLimits,
} from "@dosya-dev/shared";
import { t } from "./i18n";

/**
 * The shared policy checks' verdicts in the chosen language.
 *
 * @dosya-dev/shared stays the single rule: each function here first asks the
 * shared validator, returns null when it accepts, and only then picks the
 * catalog message for the branch that refused, with the same limits as
 * arguments. The branch is found by re-asking the shared checks (or their
 * documented conditions), never by reading their English sentence.
 */

/** Rename: files cap at FILE_NAME_MAX, folders at FOLDER_NAME_MAX. */
export function nameError(name: string, kind: "file" | "folder"): string | null {
  const refused = kind === "folder" ? validateFolderName(name) : validateFileName(name);
  if (refused === null) return null;
  const trimmed = name.trim();
  const max = kind === "folder" ? LIMITS.FOLDER_NAME_MAX : LIMITS.FILE_NAME_MAX;
  if (trimmed.length < 1) return t("files.error.nameIsRequired");
  if (trimmed.length > max) return t("files.error.nameTooLongMaxMax", { max });
  return t("files.error.nameContainsInvalidCharacters");
}

/** Create folder: a path, checked whole and then segment by segment. */
export function folderPathError(path: string): string | null {
  if (validateFolderPath(path) === null) return null;
  const raw = path.trim();
  if (validateFolderPathShape(raw) !== null) {
    return raw.length < 1
      ? t("files.error.folderNameIsRequired")
      : t("files.error.pathTooLongMaxMaxChars", { max: LIMITS.FOLDER_PATH_MAX });
  }
  const parts = splitFolderPath(raw);
  if (parts.length === 0) return t("files.error.folderNameIsRequired");
  for (const part of parts) {
    if (validateFolderSegment(part) === null) continue;
    return part.length > LIMITS.FOLDER_NAME_MAX
      ? t("files.error.folderNameNameIsTooLongMaxMaxChars", { name: part, max: LIMITS.FOLDER_NAME_MAX })
      : t("files.error.folderNameNameContainsInvalidCharacters", { name: part });
  }
  // The shared rule refused for a reason this mirror does not know yet: its
  // own sentence beats saying nothing.
  return validateFolderPath(path);
}

/**
 * Upload: why this workspace would refuse the file, or null. The shared check
 * runs its rules in order (size, allowed list, blocked list); asking it again
 * with one rule at a time names the one that refused.
 */
export function uploadFileError(file: { name: string; size: number }, limits: UploadLimits): string | null {
  if (checkUploadFile(file, limits) === null) return null;
  if (checkUploadFile(file, { max_file_size_gb: limits.max_file_size_gb }) !== null) {
    return t("files.error.fileExceedsTheLimitGBSizeLimitForThis", { limit: String(limits.max_file_size_gb) });
  }
  const extension = extensionOf(file.name);
  if (checkUploadFile(file, { allowed_extensions: limits.allowed_extensions }) !== null) {
    return t("files.error.fileTypeExtensionIsNotInTheAllowedList", { hasExtension: extension ? "yes" : "no", extension });
  }
  return t("files.error.fileTypeExtensionIsNotAllowedInThisWorkspace", { extension });
}

/**
 * One sentence for a pile of rejections, as summariseRejections() words it:
 * the dominant reason in full, the rest counted.
 */
export function rejectionsSummary(rejected: { name: string; reason: string }[]): string {
  if (rejected.length === 0) return "";
  const byReason = new Map<string, number>();
  for (const r of rejected) byReason.set(r.reason, (byReason.get(r.reason) ?? 0) + 1);
  const sorted = [...byReason.entries()].sort((a, b) => b[1] - a[1]);
  const [reason, count] = sorted[0];
  if (sorted.length === 1) {
    // A file name and its reason: no words of our own to translate.
    return rejected.length === 1
      ? `${rejected[0].name}: ${reason}`
      : t("files.error.reasonCountFiles", { reason, count: String(rejected.length) });
  }
  return t("files.error.reasonCountFilesAndOtherReason", { reason, count: String(count), otherCount: sorted.length - 1 });
}
