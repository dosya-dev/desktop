import { activityColor } from "./palette";
import { t } from "./i18n";
import type { MessageKey } from "../../i18n/keys";

/**
 * Human-readable labels for workspace activity actions.
 *
 * The API emits underscore ids ("file_uploaded"), and the labels are keyed by
 * that stable id, never by English text. Each known id has two messages: the
 * whole sentence with the person as {actor} (the activity feed), and the bare
 * phrase for layouts that print the name in an element of their own. Anything
 * not in the map falls back to the id with separators spaced out, so an
 * unknown or future action degrades to readable words instead of a raw
 * identifier.
 */

const ACTION_KEYS: Record<string, { sentence: MessageKey; phrase: MessageKey }> = {
  file_uploaded: { sentence: "common.label.actorUploadedAFile", phrase: "common.label.activityUploadedAFileFragment" },
  file_deleted: { sentence: "common.label.actorDeletedAFile", phrase: "common.label.activityDeletedAFileFragment" },
  file_permanently_deleted: { sentence: "common.label.actorPermanentlyDeletedAFile", phrase: "common.label.activityPermanentlyDeletedAFileFragment" },
  file_restored: { sentence: "common.label.actorRestoredAFile", phrase: "common.label.activityRestoredAFileFragment" },
  file_renamed: { sentence: "common.label.actorRenamedAFile", phrase: "common.label.activityRenamedAFileFragment" },
  file_moved: { sentence: "common.label.actorMovedAFile", phrase: "common.label.activityMovedAFileFragment" },
  file_copied: { sentence: "common.label.actorCopiedAFile", phrase: "common.label.activityCopiedAFileFragment" },
  file_shared: { sentence: "common.label.actorSharedAFile", phrase: "common.label.activitySharedAFileFragment" },
  file_shared_email: { sentence: "common.label.actorSharedAFileViaEmail", phrase: "common.label.activitySharedAFileViaEmailFragment" },
  file_request_created: { sentence: "common.label.actorCreatedAFileRequest", phrase: "common.label.activityCreatedAFileRequestFragment" },
  file_request_uploaded: { sentence: "common.label.actorReceivedAFileViaRequest", phrase: "common.label.activityReceivedAFileViaRequestFragment" },
  folder_renamed: { sentence: "common.label.actorRenamedAFolder", phrase: "common.label.activityRenamedAFolderFragment" },
  folder_moved: { sentence: "common.label.actorMovedAFolder", phrase: "common.label.activityMovedAFolderFragment" },
  folder_created: { sentence: "common.label.actorCreatedAFolder", phrase: "common.label.activityCreatedAFolderFragment" },
  member_invited: { sentence: "common.label.actorInvitedAMember", phrase: "common.label.activityInvitedAMemberFragment" },
  member_joined: { sentence: "common.label.actorJoinedTheWorkspace", phrase: "common.label.activityJoinedTheWorkspaceFragment" },
  member_removed: { sentence: "common.label.actorRemovedAMember", phrase: "common.label.activityRemovedAMemberFragment" },
  member_left: { sentence: "common.label.actorLeftTheWorkspace", phrase: "common.label.activityLeftTheWorkspaceFragment" },
  file_downloaded: { sentence: "common.label.actorDownloadedAFile", phrase: "common.label.activityDownloadedAFileFragment" },
  file_viewed: { sentence: "common.label.actorViewedAFile", phrase: "common.label.activityViewedAFileFragment" },
  file_version_uploaded: { sentence: "common.label.actorUploadedANewVersionOfAFile", phrase: "common.label.activityUploadedANewVersionOfAFileFragment" },
  file_locked: { sentence: "common.label.actorLockedAFile", phrase: "common.label.activityLockedAFileFragment" },
  file_unlocked: { sentence: "common.label.actorUnlockedAFile", phrase: "common.label.activityUnlockedAFileFragment" },
  files_batch_deleted: { sentence: "common.label.actorDeletedFiles", phrase: "common.label.activityDeletedFilesFragment" },
  folder_deleted: { sentence: "common.label.actorDeletedAFolder", phrase: "common.label.activityDeletedAFolderFragment" },
  folder_shared: { sentence: "common.label.actorSharedAFolder", phrase: "common.label.activitySharedAFolderFragment" },
  link_revoked: { sentence: "common.label.actorRevokedAShareLink", phrase: "common.label.activityRevokedAShareLinkFragment" },
  share_updated: { sentence: "common.label.actorUpdatedAShareLink", phrase: "common.label.activityUpdatedAShareLinkFragment" },
  comment_added: { sentence: "common.label.actorCommentedOnAFile", phrase: "common.label.activityCommentedOnAFileFragment" },
};

/** The bare phrase ("uploaded a file") in the current language. */
export function actionLabel(action: string): string {
  const keys = ACTION_KEYS[action];
  return keys ? t(keys.phrase) : action.replace(/[._]/g, " ");
}

/**
 * The whole-sentence message for `action`, with the person as {actor}, or
 * null for an action this map does not know (the caller then shows the name
 * and actionLabel()'s spaced-out id).
 */
export function actionSentenceKey(action: string): MessageKey | null {
  return ACTION_KEYS[action]?.sentence ?? null;
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
