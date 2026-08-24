import { appendFile, mkdir, rename, stat } from "fs/promises";
import { join } from "path";
import { format } from "util";

/**
 * Minimal file logger for the main process.
 *
 * A packaged app's console output goes nowhere a user can find - the
 * 2026-08-20 stress-test crash left zero retrievable evidence. Every console
 * line is mirrored to <userData>/logs/main.log, rotated once at maxBytes
 * (main.log.old keeps the previous generation).
 *
 * Electron-free (the directory is injected) so node --test can load it.
 * Logging must never break the app: every fs error is swallowed.
 */

export interface FileLogger {
  write(level: string, args: unknown[]): void;
  flush(): Promise<void>;
}

export function createFileLogger(dir: string, opts?: { maxBytes?: number; fileName?: string; flushMs?: number }): FileLogger {
  const maxBytes = opts?.maxBytes ?? 5 * 1024 * 1024;
  const flushMs = opts?.flushMs ?? 250;
  const file = join(dir, opts?.fileName ?? "main.log");
  let chain: Promise<void> = mkdir(dir, { recursive: true }).then(() => {}, () => {});
  let approxSize = -1; // unknown until the first write stats the file

  // Lines are batched rather than written one at a time. A console line is
  // cheap, but an open/write/close per line is not: the app logs heavily at
  // startup, and doing that per line added seconds to every launch. One write
  // per flush window keeps the syscalls proportional to time, not to how
  // chatty the code is.
  let buffer: string[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;

  const writeBuffered = async (): Promise<void> => {
    if (buffer.length === 0) return;
    const payload = buffer.join("");
    buffer = [];
    try {
      if (approxSize < 0) approxSize = await stat(file).then((s) => s.size, () => 0);
      if (approxSize > 0 && approxSize + payload.length > maxBytes) {
        await rename(file, `${file}.old`).catch(() => {});
        approxSize = 0;
      }
      await appendFile(file, payload, "utf-8");
      approxSize += payload.length;
    } catch {
      // Logging must never break the app.
    }
  };

  const schedule = (): void => {
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      chain = chain.then(writeBuffered);
    }, flushMs);
    // Never hold the process open just to write a log line.
    timer.unref?.();
  };

  return {
    write(level: string, args: unknown[]): void {
      buffer.push(`${new Date().toISOString()} [${level}] ${format(...args)}\n`);
      schedule();
    },
    flush(): Promise<void> {
      if (timer) { clearTimeout(timer); timer = null; }
      chain = chain.then(writeBuffered);
      return chain.then(() => {}, () => {});
    },
  };
}

/** Mirror console.log/warn/error into the file logger (console still fires). */
export function installFileLogger(dir: string): { flush(): Promise<void> } {
  const logger = createFileLogger(dir);
  for (const level of ["log", "warn", "error"] as const) {
    const orig = console[level].bind(console);
    console[level] = (...args: unknown[]) => {
      orig(...args);
      logger.write(level, args);
    };
  }
  return { flush: logger.flush };
}
