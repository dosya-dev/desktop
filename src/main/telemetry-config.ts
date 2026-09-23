/**
 * Crash-reporting configuration shared by the three desktop processes (main,
 * renderer, sync-engine utility process). Pure: no Electron, no SDK import,
 * so it runs under Node's test runner and every rule here is testable.
 *
 * Before this the desktop app had NO off-machine error signal. The main
 * process wrote minidumps to disk with `uploadToServer: false`, the renderer
 * boundary logged to a file nobody could reach, and a packaged crash was
 * invisible until a user wrote in.
 *
 * Only the main process talks to Sentry. The renderer and the utility process
 * hand their events to main over IPC, so the DSN and the on/off decision live
 * here and are read by main alone. The DSN is a public write-only key, so a
 * checked-in default is fine (the mobile app does the same); DOSYA_SENTRY_DSN
 * overrides it for another project and an EMPTY value turns reporting off.
 *
 * Off in unpackaged (dev) runs by default: a dev session's exceptions would
 * drown the dashboard and the terminal already shows them. DOSYA_SENTRY_DEV=1
 * exercises the pipeline from `npm run dev`.
 */

export const DEFAULT_SENTRY_DSN =
  "https://c8555c486cf5bf58dace9640a66c2be2@o4512130123825152.ingest.de.sentry.io/4512130519072848";

/** Sample rate for performance traces. Errors are always sent. */
export const TRACES_SAMPLE_RATE = 0.1;

/** Release name shared by the SDK and the source-map upload (see electron.vite.config.ts). */
export function releaseName(version: string): string {
  return `dosya-desktop@${version}`;
}

/** The variables read, from `process.env` or a test's stand-in. */
export type SentryEnv = Record<string, string | undefined>;

/** The DSN to report to; `null` when reporting is switched off. */
export function resolveDsn(env: SentryEnv = process.env): string | null {
  const configured = env["DOSYA_SENTRY_DSN"];
  if (configured === undefined) return DEFAULT_SENTRY_DSN;
  const trimmed = configured.trim();
  return trimmed === "" ? null : trimmed;
}

/** Whether events should leave the machine for this build. */
export function isSentryEnabled(env: SentryEnv, packaged: boolean): boolean {
  if (resolveDsn(env) === null) return false;
  if (packaged) return true;
  return env["DOSYA_SENTRY_DEV"] === "1";
}

/** The slice of a Sentry event the scrubber touches. */
interface Scrubbable {
  user?: { id?: string | number } & Record<string, unknown>;
  /** The Node SDK's os.hostname() ("Firats-MacBook-Pro") - a name, so it goes. */
  server_name?: string;
}

/**
 * Drops personal fields an integration may have attached. The opaque account
 * id set by the renderer survives; email, username, IP and the machine's
 * hostname do not. `sendDefaultPii` is off as well, so this is belt and braces.
 */
export function scrubEvent<E extends Scrubbable>(event: E): E {
  if (event.user) {
    const { id } = event.user;
    event.user = id === undefined ? undefined : { id };
  }
  delete event.server_name;
  return event;
}
