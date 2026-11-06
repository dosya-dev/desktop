// The desktop half of a bug report's diagnostics (spec:
// docs/superpowers/specs/2026-10-03-bug-report-design.md). DOM-free and
// Electron-free on purpose: every fact arrives as an argument, so this runs
// under node --test alongside src/main's tests (hence the relative `.ts`
// imports). What is SENT (the diagnostics object, the body) stays English and
// stable for support; only the card's labels and the sync line it shows are
// translated, at call time.
import { tl } from "./locale-state.ts";
import type { MessageKey } from "../../i18n/keys.ts";

export interface DesktopDiagnostics {
  v: 1;
  client: "desktop";
  app_version: string;
  build: string | null;
  platform: string;
  locale: string | null;
  workspace_id: string | null;
  page: string | null;
  error_ref: string | null;
  error_message: string | null;
  extra: Record<string, string>;
  captured_at: number;
}

/** What main answers on app:get-diagnostics-info. */
export interface DiagnosticsInfo {
  version: string;
  distribution: string;
  arch: string;
  platform: string;
  locale: string;
}

const orNull = (v: string | null | undefined): string | null => (typeof v === "string" && v.length > 0 ? v : null);

/** The path only. The sync page carries a local path in its query string. */
function pathOnly(p: string | null): string | null {
  return p === null ? null : p.split(/[?#]/)[0];
}

/**
 * Replaces a local filesystem path with the token "<path>", keeping whatever
 * text came before it. Covers the shapes diagnostics strings actually carry: a
 * file:// URL, a POSIX home path (/Users/x or /home/x) and a Windows user path
 * with either slash style and any drive letter. Each match runs through the
 * next whitespace, quote or closing paren, whichever comes first, so "Sync
 * folder not found: /Users/f/Work" becomes "Sync folder not found: <path>".
 * A string with no path in it is returned unchanged.
 */
export function redactPaths(s: string): string {
  if (!s) return s;
  return s
    .replace(/file:\/\/[^\s"'`]*/g, "<path>")
    .replace(/[A-Za-z]:\\Users\\[^\s"'`)]+/g, "<path>")
    .replace(/[A-Za-z]:\/Users\/[^\s"'`)]+/g, "<path>")
    .replace(/\/(?:Users|home)\/[^\s"'`)]+/g, "<path>");
}

/** The server clamps every diagnostics string to this length; clamp here too
 *  so a long value is trimmed rather than the whole field being refused. */
export const DIAGNOSTICS_STRING_MAX = 300;

function sanitize(s: string): string {
  return redactPaths(s).slice(0, DIAGNOSTICS_STRING_MAX);
}

function sanitizeNullable(s: string | null): string | null {
  return s === null ? null : sanitize(s);
}

type SyncStatus = { pairs: { status: string; fileErrorCount: number }[]; globalPaused: boolean };

function syncCounts(status: SyncStatus) {
  return {
    folderCount: status.pairs.length,
    errorCount: status.pairs.filter((p) => p.status === "error").length,
    failedCount: status.pairs.reduce((sum, p) => sum + (p.fileErrorCount || 0), 0),
    paused: status.globalPaused ? "yes" : "no",
  };
}

/** "2 folders · 1 in error · 3 files failed", or "1 folder · paused". No paths.
 *  This is the value SENT with the report, so it stays English. */
export function summariseSync(status: SyncStatus | null): string | null {
  if (!status) return null;
  const { folderCount: n, errorCount: errors, failedCount: failed, paused } = syncCounts(status);
  if (n === 0) return paused === "yes" ? "no folders · paused" : "no folders";
  const parts = [`${n} ${n === 1 ? "folder" : "folders"}`];
  if (errors > 0) parts.push(`${errors} in error`);
  if (failed > 0) parts.push(`${failed} ${failed === 1 ? "file" : "files"} failed`);
  if (paused === "yes") parts.push("paused");
  return parts.join(" · ");
}

/** The same summary in the chosen language, for the card the user reads. */
export function describeSync(status: SyncStatus | null): string | null {
  return status ? tl("report-problem.status.noFoldersPaused", syncCounts(status)) : null;
}

/** What collectDesktopDiagnostics sends when main gave no facts. */
const UNKNOWN = "unknown";

export function collectDesktopDiagnostics(input: {
  info: DiagnosticsInfo | null;
  sync: string | null;
  workspaceId: string | null;
  page: string | null;
  errorRef: string | null;
  errorMessage: string | null;
  now?: number;
}): DesktopDiagnostics {
  const extra: Record<string, string> = {};
  if (input.sync) extra.Sync = input.sync;
  return {
    v: 1,
    client: "desktop",
    app_version: sanitize(input.info?.version || UNKNOWN),
    build: sanitizeNullable(input.info ? `${input.info.distribution} ${input.info.arch}`.trim() || null : null),
    platform: sanitize(input.info?.platform || UNKNOWN),
    locale: sanitizeNullable(orNull(input.info?.locale)),
    workspace_id: sanitizeNullable(orNull(input.workspaceId)),
    page: sanitizeNullable(pathOnly(orNull(input.page))),
    error_ref: sanitizeNullable(orNull(input.errorRef)),
    error_message: sanitizeNullable(orNull(input.errorMessage)),
    extra: Object.fromEntries(Object.entries(extra).map(([k, v]) => [k, sanitize(v)])),
    captured_at: input.now ?? Math.floor(Date.now() / 1000),
  };
}

/** Card labels for the `extra` keys, which are sent as they are. */
const EXTRA_LABELS: Record<string, MessageKey> = { Sync: "common.label.sync" };

/** The rows the card shows, in the chosen language. Empty values are left
 *  out; the id is "Error reference", never the vendor's name. `sync` is the
 *  translated sync line (describeSync) shown in place of the English one
 *  the payload carries. */
export function diagnosticsRows(d: DesktopDiagnostics, display: { sync?: string | null } = {}): { label: string; value: string }[] {
  const shown = (v: string) => (v === UNKNOWN ? tl("report-problem.label.unknown") : v);
  const rows: { label: string; value: string | null }[] = [
    { label: tl("report-problem.label.app"), value: d.build ? `${d.app_version} · ${d.build}` : shown(d.app_version) },
    { label: tl("common.label.system"), value: shown(d.platform) },
    { label: tl("common.label.workspace"), value: d.workspace_id },
    { label: tl("report-problem.label.page"), value: d.page },
    { label: tl("report-problem.label.errorReference"), value: d.error_ref },
    { label: tl("common.status.error"), value: d.error_message },
    ...Object.entries(d.extra).map(([key, value]) => ({
      label: EXTRA_LABELS[key] ? tl(EXTRA_LABELS[key]) : key,
      value: key === "Sync" && display.sync ? display.sync : value,
    })),
  ];
  return rows.filter((r): r is { label: string; value: string } => typeof r.value === "string" && r.value.length > 0);
}

/** The API refuses bodies over 10,000 characters; stay under with room. */
export const BODY_MAX = 9_500;

/**
 * The ticket body: the user's words, then (opt-in) the log tail under a
 * marker. Attachments are images only, so the log travels in the body. When
 * the two do not fit, the TAIL is cut from its start, so the newest log lines
 * and the whole of the user's text survive.
 */
export function composeBody(userText: string, logTail: string | null, lines: number): string {
  const text = userText.trim().slice(0, BODY_MAX);
  const tail = (logTail ?? "").trim();
  if (!tail) return text;
  const marker = `\n\n--- Recent log (last ${lines} lines) ---\n`;
  const room = BODY_MAX - text.length - marker.length;
  if (room <= 0) return text;
  const fitted = tail.length > room ? tail.slice(tail.length - room) : tail;
  return text + marker + fitted;
}
