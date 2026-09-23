import * as Sentry from "@sentry/electron/main";
import { app } from "electron";
import { TRACES_SAMPLE_RATE, isSentryEnabled, releaseName, resolveDsn, scrubEvent } from "./telemetry-config";

/**
 * Main-process crash reporting (Sentry, org dosya-pty-ltd, project
 * dosya-desktop, EU region). The rules live in telemetry-config.ts.
 *
 * Must run before anything else touches Electron: the SDK starts the native
 * crashReporter (minidumps for GPU/renderer/main crashes, uploaded on next
 * launch), registers its own privileged `sentry-ipc` scheme, and wraps
 * `utilityProcess.fork` so the sync engine's SDK gets a message port. The old
 * hand-rolled `crashReporter.start({ uploadToServer: false })` is gone: those
 * minidumps only ever sat on the user's disk.
 *
 * The SDK is bundled into out/main (the package ships no node_modules), so its
 * automatic preload injection cannot find its script; src/preload/index.ts
 * imports it directly instead, and the renderer falls back to the
 * `sentry-ipc://` protocol if that ever fails (session.ts allows it in CSP).
 */
export function initSentryMain(): void {
  Sentry.init({
    dsn: resolveDsn() ?? "",
    enabled: isSentryEnabled(process.env, app.isPackaged),
    environment: app.isPackaged ? "production" : "development",
    release: releaseName(app.getVersion()),
    dataCollection: { userInfo: false, httpBodies: [] },
    includeServerName: false,
    tracesSampleRate: TRACES_SAMPLE_RATE,
    beforeSend: scrubEvent,
  });
}

/** Bounded flush for the crash-exit path; never throws. */
export function flushSentry(timeoutMs: number): Promise<boolean> {
  return Sentry.flush(timeoutMs).catch(() => false);
}
