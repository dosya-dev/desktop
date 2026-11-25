/**
 * Where a browser sign-in starts. Pure so the allow-list and URL shape can be
 * tested without Electron; the caller mints the nonce and owns the state.
 *
 * Google, GitHub and Apple start at the API. A passkey cannot run in the app's
 * own window (it loads from a custom scheme, which WebAuthn refuses), so it
 * starts on a web app page instead. Every route ends at the same
 * dosya://auth/callback?token=...&state=... and passes the same nonce check.
 */

/**
 * The production web app. Same value as WEB_APP_BASE in
 * renderer/lib/web-app-url.ts, which this process cannot import because the
 * main and renderer builds are separate TypeScript projects. A test keeps the
 * two equal.
 */
export const PROD_WEB_APP_BASE = "https://app.dosya.dev";

const API_PROVIDERS: ReadonlySet<string> = new Set(["google", "github", "apple"]);

export interface BrowserSignInBases {
  apiBase: string;
  webAppBase: string;
}

/** The URL that starts a sign-in, or null for a provider we do not offer. */
export function browserSignInUrl(provider: string, nonce: string, bases: BrowserSignInBases): string | null {
  const state = encodeURIComponent(nonce);
  if (provider === "passkey") return `${bases.webAppBase}/connect/desktop-passkey?state=${state}`;
  if (API_PROVIDERS.has(provider)) return `${bases.apiBase}/api/auth/${provider}?desktop=1&state=${state}`;
  return null;
}
