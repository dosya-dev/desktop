import { open, stat } from "node:fs/promises";

/**
 * The main-process half of a bug report: what the renderer cannot know about
 * the machine, and the one file the user cannot easily find
 * (<userData>/logs/main.log, see file-logger.ts).
 *
 * Electron-free so node --test can load it; ipc.ts wires it to `app`.
 */

/** Spec: the last 200 lines of the log ride along, under their own toggle. */
export const LOG_TAIL_LINES = 200;
/** Never read more than this from the end of the file, however long its lines. */
export const LOG_TAIL_MAX_BYTES = 64 * 1024;

const OS_NAMES: Record<string, string> = { darwin: "macOS", win32: "Windows", linux: "Linux" };

/** "macOS 24.6.0", "Windows 10.0.26100": the name a user recognises plus the
 *  kernel release that tells support which build they are on. */
export function describePlatform(p: { platform: string; release: string }): string {
  return `${OS_NAMES[p.platform] ?? p.platform} ${p.release}`.trim();
}

/** The last `n` lines of `text`. A trailing newline does not count as a line. */
export function tailLines(text: string, n: number): string {
  if (text.length === 0 || n <= 0) return "";
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines.slice(-n).join("\n");
}

/**
 * The last `lines` lines of the file at `path`, reading at most `maxBytes`
 * from its end. A byte cut can land mid-line, so when the read did not start
 * at byte 0 the first (partial) line is dropped. A missing or unreadable file
 * is an empty string, never a rejection: the report must still send.
 */
export async function tailOfFile(path: string, lines: number, maxBytes: number = LOG_TAIL_MAX_BYTES): Promise<string> {
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    const { size } = await stat(path);
    if (size === 0) return "";
    const start = Math.max(0, size - maxBytes);
    const length = size - start;
    handle = await open(path, "r");
    const buf = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buf, 0, length, start);
    let text = buf.subarray(0, bytesRead).toString("utf8");
    if (start > 0) {
      const firstBreak = text.indexOf("\n");
      text = firstBreak === -1 ? "" : text.slice(firstBreak + 1);
    }
    return tailLines(text, lines);
  } catch {
    return "";
  } finally {
    await handle?.close().catch(() => {});
  }
}
