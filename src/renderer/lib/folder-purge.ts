/**
 * Permanently deleting a trashed folder, one bounded pass at a time.
 *
 * The purge spends storage round trips per file, so the API stopped trying to
 * do the whole thing in one request: it works through the folder until its
 * budget runs out and answers 202 `{ complete: false, remaining, files_affected }`,
 * or 200 `{ complete: true, remaining: 0 }` when there is nothing left. The
 * call is idempotent and the folder rows deliberately survive an unfinished
 * pass - they are how the next call re-enumerates what remains - so finishing
 * the job is simply asking again.
 *
 * The client half is this loop. Without it the page took the first answer as
 * the whole job and told the user a folder was permanently deleted while most
 * of it was still there.
 *
 * The web client has its own copy (apps/web/src/lib/folder-purge.ts) and this
 * mirrors its behaviour deliberately: the two apps ship separately and neither
 * imports from the other. Two rules in particular are load-bearing and are the
 * same on both sides - a body with no `complete` field counts as FINISHED (an
 * older API answering a bare `{ ok: true }` must not be hit fifty times), and
 * a rejection propagates rather than being retried (a 403 or a 404 would be
 * just as refused fifty times over). What is deliberately NOT copied is the
 * web's cancel hook: the desktop has no bulk-cancel control to poll.
 *
 * Electron-free and dependency-free so `npm run test:unit` can load it.
 */

/** The body of a permanent-delete answer. Every field is optional: an older API answers `{ ok: true }`. */
export interface PurgeResponse {
  ok?: boolean;
  permanent?: boolean;
  complete?: boolean;
  remaining?: number;
  files_affected?: number;
}

export interface PurgeOutcome {
  /** False when the pass cap stopped us with work still to do. */
  complete: boolean;
  /** Files removed across every pass. */
  filesAffected: number;
  /** What the last pass said was left. */
  remaining: number;
  calls: number;
}

/**
 * How many passes one click will make. A folder large enough to never finish
 * would otherwise spin forever, hammering the API from a window nobody is
 * watching; at the cap the user is told it is still emptying and can ask
 * again, which resumes exactly where this left off.
 */
export const MAX_PURGE_CALLS = 50;

export async function purgeTrashedFolder(
  purgeOnce: () => Promise<PurgeResponse>,
  opts: { maxCalls?: number } = {},
): Promise<PurgeOutcome> {
  const maxCalls = Math.max(1, opts.maxCalls ?? MAX_PURGE_CALLS);
  let filesAffected = 0;
  let remaining = 0;
  let calls = 0;

  while (calls < maxCalls) {
    // Deliberately unguarded: a failure is the caller's to report, along with
    // whatever it already says on the error. Retrying a refusal fifty times
    // would only make the user wait for the same answer.
    const body = await purgeOnce();
    calls += 1;
    filesAffected += body.files_affected ?? 0;
    remaining = body.remaining ?? 0;
    // Anything but an explicit `false` counts as finished.
    if (body.complete !== false) return { complete: true, filesAffected, remaining, calls };
  }

  return { complete: false, filesAffected, remaining, calls };
}

export interface PurgeMessage {
  /** Which toast to raise: success, info (still emptying), error (refused). */
  kind: "success" | "info" | "error";
  title: string;
  body: string;
}

/** The title both paths use when a purge stopped with work still to do. */
const STILL_EMPTYING_TITLE = "Still emptying";

/** "Ask again" is the whole recovery, so both paths say it the same way. */
const CARRY_ON = 'Choose "Delete permanently" again to carry on.';

const plural = (n: number, word: string) => `${n.toLocaleString()} ${word}${n === 1 ? "" : "s"}`;

/** What to tell the user when the loop stops, finished or not. */
export function purgeSummary(outcome: PurgeOutcome, folderName: string): PurgeMessage {
  if (outcome.complete) {
    return {
      kind: "success",
      title: "Deleted",
      body: outcome.filesAffected > 0
        ? `"${folderName}" and its ${plural(outcome.filesAffected, "file")} were permanently deleted.`
        : `"${folderName}" was permanently deleted.`,
    };
  }
  return {
    kind: "info",
    title: STILL_EMPTYING_TITLE,
    body: `"${folderName}" is very large - ${plural(outcome.filesAffected, "file")} removed so far, `
      + `about ${outcome.remaining.toLocaleString()} to go. ${CARRY_ON}`,
  };
}

/** One folder the bulk purge could not finish. */
export interface UnfinishedFolder {
  name: string;
  filesAffected: number;
  remaining: number;
}

/**
 * The multi-select purge's summary.
 *
 * A folder that answered 202 is NOT a deleted item, and saying "2 items
 * permanently deleted" over a folder that is still half full is the same
 * claim the single-folder path was fixed for. The wording is the row-level
 * wording - same title, same "very large", same instruction to ask again - so
 * the two paths cannot drift into describing one behaviour two ways.
 */
export function bulkPurgeSummary(opts: {
  /** Items that really are gone: deleted files plus folders that completed. */
  deleted: number;
  failed: number;
  incomplete: UnfinishedFolder[];
}): PurgeMessage {
  const { deleted, failed, incomplete } = opts;
  const parts: string[] = [];

  if (incomplete.length === 0) {
    parts.push(`${plural(deleted, "item")} permanently deleted.`);
    if (failed > 0) parts.push(`${plural(failed, "item")} could not be deleted.`);
    // A refusal is an error even when something else did go: reporting it in
    // a green toast is the same overstatement in a smaller form.
    return failed > 0
      ? { kind: "error", title: "Some items could not be deleted", body: parts.join(" ") }
      : { kind: "success", title: "Deleted", body: parts.join(" ") };
  }

  const removed = incomplete.reduce((sum, f) => sum + f.filesAffected, 0);
  const left = incomplete.reduce((sum, f) => sum + f.remaining, 0);
  if (deleted > 0) parts.push(`${plural(deleted, "item")} permanently deleted.`);
  parts.push(
    incomplete.length === 1
      ? `"${incomplete[0].name}" is very large - ${plural(removed, "file")} removed so far, about ${left.toLocaleString()} to go.`
      : `${plural(incomplete.length, "folder")} are very large - ${plural(removed, "file")} removed so far, about ${left.toLocaleString()} to go.`,
  );
  parts.push(CARRY_ON);
  if (failed > 0) parts.push(`${plural(failed, "item")} could not be deleted.`);

  return { kind: "info", title: STILL_EMPTYING_TITLE, body: parts.join(" ") };
}
