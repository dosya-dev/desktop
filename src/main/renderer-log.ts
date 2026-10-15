/**
 * Which renderer console lines reach main.log, and how they read.
 *
 * Electron 43 passes `console-message` a details object whose `level` is a
 * STRING ("info" | "warning" | "error" | "debug") and marks the old positional
 * `(level: number, message, line, sourceId)` parameters deprecated
 * (electron.d.ts, WebContents 'console-message'). The old code read the
 * positional ones only; when they go away `level < 2` becomes `NaN < 2` ->
 * false, so every line would be logged as "undefined (undefined:undefined)" -
 * destroying the diagnostic this exists for.
 *
 * Pure so `node --test` can load it: no electron import.
 */
export interface RendererConsoleDetails {
  level?: "info" | "warning" | "error" | "debug";
  message?: string;
  lineNumber?: number;
  sourceId?: string;
}

export interface RendererLogLine {
  tag: "warn" | "error";
  text: string;
}

/** Numeric levels of the deprecated signature: 0 verbose, 1 info, 2 warning, 3 error. */
const NUMERIC: Record<number, "warning" | "error"> = { 2: "warning", 3: "error" };

export function rendererLogLine(
  details?: RendererConsoleDetails,
  legacyLevel?: number,
  legacyMessage?: string,
  legacySourceId?: string,
  legacyLine?: number,
): RendererLogLine | null {
  const level =
    details?.level ?? (typeof legacyLevel === "number" ? NUMERIC[legacyLevel] : undefined);
  if (level !== "warning" && level !== "error") return null;

  const message = details?.message ?? legacyMessage;
  if (typeof message !== "string" || message.length === 0) return null;

  const source = details?.sourceId ?? legacySourceId ?? "?";
  const line = details?.lineNumber ?? legacyLine ?? 0;
  return { tag: level === "error" ? "error" : "warn", text: `${message}  (${source}:${line})` };
}
