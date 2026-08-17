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

export const ACTION_COLORS: Record<string, string> = {
  file_uploaded: "#22c55e",
  file_deleted: "#ef4444",
  file_permanently_deleted: "#991b1b",
  file_restored: "#2563EB",
  file_shared: "#7C3AED",
  file_shared_email: "#7C3AED",
  file_request_created: "#D97706",
  file_request_uploaded: "#16a34a",
  folder_created: "#22c55e",
  folder_renamed: "#706e69",
  folder_moved: "#706e69",
  file_renamed: "#706e69",
  file_moved: "#706e69",
  file_copied: "#3b82f6",
  member_invited: "#D97706",
  member_joined: "#16a34a",
  member_removed: "#ef4444",
};

export function actionLabel(action: string): string {
  return ACTION_LABELS[action] ?? action.replace(/[._]/g, " ");
}

export function actionColor(action: string): string {
  return ACTION_COLORS[action] ?? "#706e69";
}
