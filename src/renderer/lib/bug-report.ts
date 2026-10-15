// The desktop half of a bug report's diagnostics (spec:
// docs/superpowers/specs/2026-10-03-bug-report-design.md). DOM-free and
// Electron-free on purpose: every fact arrives as an argument, so this runs
// under node --test alongside src/main's tests.

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

/** "2 folders · 1 in error · 3 files failed", or "1 folder · paused". No paths. */
export function summariseSync(
  status: { pairs: { status: string; fileErrorCount: number }[]; globalPaused: boolean } | null,
): string | null {
  if (!status) return null;
  const n = status.pairs.length;
  if (n === 0) return status.globalPaused ? "no folders · paused" : "no folders";
  const parts = [`${n} ${n === 1 ? "folder" : "folders"}`];
  const errors = status.pairs.filter((p) => p.status === "error").length;
  if (errors > 0) parts.push(`${errors} in error`);
  const failed = status.pairs.reduce((sum, p) => sum + (p.fileErrorCount || 0), 0);
  if (failed > 0) parts.push(`${failed} ${failed === 1 ? "file" : "files"} failed`);
  if (status.globalPaused) parts.push("paused");
  return parts.join(" · ");
}

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
    app_version: sanitize(input.info?.version || "unknown"),
    build: sanitizeNullable(input.info ? `${input.info.distribution} ${input.info.arch}`.trim() || null : null),
    platform: sanitize(input.info?.platform || "unknown"),
    locale: sanitizeNullable(orNull(input.info?.locale)),
    workspace_id: sanitizeNullable(orNull(input.workspaceId)),
    page: sanitizeNullable(pathOnly(orNull(input.page))),
    error_ref: sanitizeNullable(orNull(input.errorRef)),
    error_message: sanitizeNullable(orNull(input.errorMessage)),
    extra: Object.fromEntries(Object.entries(extra).map(([k, v]) => [k, sanitize(v)])),
    captured_at: input.now ?? Math.floor(Date.now() / 1000),
  };
}

/** The rows the card shows. Empty values are left out; the id is "Error
 *  reference", never the vendor's name. */
export function diagnosticsRows(d: DesktopDiagnostics): { label: string; value: string }[] {
  const rows: { label: string; value: string | null }[] = [
    { label: "App", value: d.build ? `${d.app_version} · ${d.build}` : d.app_version },
    { label: "System", value: d.platform },
    { label: "Workspace", value: d.workspace_id },
    { label: "Page", value: d.page },
    { label: "Error reference", value: d.error_ref },
    { label: "Error", value: d.error_message },
    ...Object.entries(d.extra).map(([label, value]) => ({ label, value })),
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
