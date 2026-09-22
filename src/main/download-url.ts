// Small pure slice of the file:download IPC handler (src/main/ipc.ts), split
// out the way session-cookie.ts's sessionCookieHeader was: everything else
// that handler does - the save dialog, the session cookie header, the
// fetch/pipe to disk - needs real Electron/session/fs APIs the Node test
// runner can't provide, so the handler stays untestable in isolation. This
// one piece - deciding which URL to fetch, and rejecting a malformed archive
// entry index before it reaches a request - has no such dependency.

/**
 * Upper bound on an archive entry's central-directory index. Not a real zip
 * limit (a ZIP64 central directory can exceed this) - just implausibly large
 * for anything this app will ever be asked to open, so it catches a
 * corrupted or hostile IPC argument without pretending to validate the
 * archive itself.
 */
const MAX_ARCHIVE_ENTRY_INDEX = 1_000_000;

export interface DownloadUrlParams {
  fileId: string;
  version?: number;
  /**
   * Central-directory index of one entry inside a stored zip. This is the
   * ONLY way an entry is addressed - never by name - which is what keeps
   * traversal unreachable through this path. Undefined means "download the
   * file itself", not entry 0.
   */
  archiveEntryIndex?: number;
}

/**
 * Builds the URL the file:download IPC handler fetches, given an
 * already-validated fileId. Throws on a malformed archiveEntryIndex - the
 * handler's other arguments (fileId, fileName, version) are validated by the
 * handler itself before this is called.
 */
export function buildDownloadUrl(apiBase: string, { fileId, version, archiveEntryIndex }: DownloadUrlParams): string {
  if (
    archiveEntryIndex !== undefined &&
    (!Number.isInteger(archiveEntryIndex) || archiveEntryIndex < 0 || archiveEntryIndex > MAX_ARCHIVE_ENTRY_INDEX)
  ) {
    throw new Error("Invalid archive entry index");
  }

  const encodedId = encodeURIComponent(fileId);

  // An entry inside an archive is addressed by its central-directory INDEX,
  // which is what makes traversal unreachable - never by a path.
  //
  // The version rides along rather than being dropped: an entry index is only
  // meaningful against ONE version of the zip, because a re-upload renumbers
  // the central directory. Dropping it meant the viewer showing v1 saved v3's
  // entry N - a different file entirely, under the name the dialog suggested.
  if (archiveEntryIndex !== undefined) {
    const v = version ? `&version=${version}` : "";
    return `${apiBase}/api/files/${encodedId}/archive/entry?i=${archiveEntryIndex}&dl=1${v}`;
  }

  const qs = version ? `?version=${version}` : "";
  return `${apiBase}/api/files/${encodedId}/download${qs}`;
}
