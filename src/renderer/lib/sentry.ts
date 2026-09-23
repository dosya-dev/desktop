import { browserTracingIntegration, captureException, init, setUser } from "@sentry/electron/renderer";
import { TRACES_SAMPLE_RATE } from "../../main/telemetry-config";

/**
 * Renderer-side crash reporting. No DSN here: the renderer SDK hands every
 * event to the main process over the IPC bridge the preload exposes
 * (src/preload/index.ts), and main decides whether it leaves the machine
 * (src/main/telemetry.ts). Unhandled exceptions and rejections are captured
 * by the SDK's defaults; ErrorBoundary reports what it catches via
 * `reportError`.
 */
export function initSentryRenderer(): void {
  init({
    integrations: [browserTracingIntegration()],
    tracesSampleRate: TRACES_SAMPLE_RATE,
    dataCollection: { userInfo: false, httpBodies: [] },
  });
}

/** Attach (or clear, with null) the signed-in account's opaque id. Synced to main. */
export function setSentryUser(userId: string | null): void {
  setUser(userId ? { id: userId } : null);
}

/** Report an error the app caught itself (boundaries, swallowed catches). */
export function reportError(error: unknown, extra?: Record<string, unknown>): void {
  captureException(error, extra ? { extra } : undefined);
}
