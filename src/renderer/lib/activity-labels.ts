import { activityColor } from "./palette";
/**
 * Human-readable labels for workspace activity actions.
 *
 * The API emits underscore ids ("file_uploaded"); anything not in the map
 * falls back to the id with separators spaced out, so an unknown or future
 * action degrades to readable words instead of a raw identifier.
 */

export const ACTION_LABELS: Record<string, string> = {
  file_uploaded: "uploaded a file",
  file_deleted: "deleted a file",
  file_permanently_deleted: "permanently deleted a file",
  file_restored: "restored a file",
  file_renamed: "renamed a file",
  file_moved: "moved a file",
  file_copied: "copied a file",
  file_shared: "shared a file",
  file_shared_email: "shared a file via email",
  file_request_created: "created a file request",
  file_request_uploaded: "received a file via request",
  folder_renamed: "renamed a folder",
  folder_moved: "moved a folder",
  folder_created: "created a folder",
  member_invited: "invited a member",
  member_joined: "joined the workspace",
  member_removed: "removed a member",
};


export function actionLabel(action: string): string {
  return ACTION_LABELS[action] ?? action.replace(/[._]/g, " ");
}

/**
 * The activity dot. The action-to-tone map is shared with the web app now: the two
 * render the same feed from the same API and used to disagree on several actions -
 * a file request was blue in one and amber in the other, and a permanent delete was a
 * darker red than an ordinary one.
 */
export function actionColor(action: string, scheme: "light" | "dark" = "light"): string {
  return activityColor(action, scheme);
}
