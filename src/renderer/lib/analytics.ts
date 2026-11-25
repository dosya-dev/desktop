/**
 * The renderer's side of usage analytics: it names what happened, with the
 * shared catalogue, and hands the name to the main process. It never sends
 * anything itself and never knows whether the person agreed; main holds the
 * answer and drops everything unless it is yes (main/analytics.ts).
 *
 * What can be named is fixed by @dosya-dev/shared's analytics catalogue: an
 * event and a few category parameters. A file name, an id or a search term
 * has no way in.
 */
import { activityFromApi, cleanRelayEvent, sanitizeAppPath, sizeBand } from "@dosya-dev/shared";

type Params = Record<string, string | number | boolean>;

function send(name: string, params?: Params): void {
  const clean = cleanRelayEvent(name, params);
  if (!clean) return;
  try {
    // Optional all the way down: a preload older than this API, or a test
    // without a bridge, has no analytics and must not throw.
    window.electronAPI?.analytics?.track?.(clean.name, clean.params);
  } catch {
    /* analytics is never a reason for anything else to fail */
  }
}

/** Any catalogue event. Unknown names and parameters are dropped. */
export function trackEvent(name: string, params?: Params): void {
  send(name, params);
}

/** Called by apiRequest after a request succeeds; a no-op for reads. */
export function recordApiActivity(method: string | undefined, path: string): void {
  const activity = activityFromApi(method, path);
  if (activity) send(activity.name, activity.params);
}

/** The screen in front, by route with its ids replaced. The About window is not a screen of the app. */
export function trackScreen(pathname: string): void {
  if (pathname === "/about" || pathname.startsWith("/about/")) return;
  send("page_view", { screen: sanitizeAppPath(pathname) });
}

/** A finished upload, by size band only. */
export function trackUpload(bytes: number): void {
  send("file_upload", { size_band: sizeBand(bytes) });
}
