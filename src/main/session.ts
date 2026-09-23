import { app, session } from "electron";
import { originAllowed } from "./trusted-origins";
import {
  parseSessionCookieHeaders,
  isSessionCookieName,
  HOST_SESSION_COOKIE,
  LEGACY_SESSION_COOKIE,
} from "./session-cookie";

/**
 * Configure Electron's session for the desktop app:
 * 1. Spoof the Origin header so the API sees requests as same-origin.
 * 2. Fix the session cookie's SameSite + expiry for cross-origin fetch.
 * 3. Set a Content Security Policy in production.
 *
 * The window runs with webSecurity ENABLED: the renderer has a real origin
 * (app://bundle packaged, http://localhost:5174 dev) that the API allows via
 * CORS, so credentialed cross-origin fetch works without disabling security.
 * Navigation is further locked down by will-navigate, setWindowOpenHandler,
 * and the CSP below.
 */
export function setupSession(apiBase: string): void {
  const ses = session.defaultSession;

  // Tag desktop requests so the server can distinguish desktop vs web.
  // We deliberately do NOT spoof the Origin header anymore: with webSecurity
  // enabled the browser enforces CORS against the renderer's REAL origin
  // (app://bundle in packaged builds, http://localhost:5174 in dev). The API
  // allows those origins via CORS_ALLOWED_ORIGINS, so overwriting Origin here
  // would break the Access-Control-Allow-Origin match.
  ses.webRequest.onBeforeSendHeaders((details, callback) => {
    if (originAllowed(details.url, [apiBase])) {
      details.requestHeaders["X-Dosya-Client"] = `desktop/${app.getVersion()}`;
    }
    callback({ requestHeaders: details.requestHeaders });
  });

  // Set CSP in production and manually capture the session cookie.
  //
  // Chromium 120+ blocks third-party cookies by default. Since the renderer
  // (file:// or localhost) and the API (dosya.dev) are different origins,
  // Set-Cookie headers from API responses are silently discarded by the
  // renderer. We intercept the response headers here in the main process
  // and manually store the cookie via Electron's cookies API, which bypasses
  // the renderer-level third-party cookie restrictions.
  // ONLYOFFICE Document Server. The editor loads its api.js from here and then
  // iframes the editor itself, so BOTH script-src and frame-src have to name it
  // - a strict 'self' policy blocks the script silently and the page just never
  // becomes an editor. Overridable for a self-hosted document server.
  const docsBase = process.env.ONLYOFFICE_SERVER_URL || "https://docs.dosya.dev";

  ses.webRequest.onHeadersReceived((details, callback) => {
    const responseHeaders = { ...details.responseHeaders };

    // Apply a Content-Security-Policy to the renderer document (mainFrame +
    // subFrame). Packaged builds load from app:// and get a strict policy; dev
    // loads from Vite on localhost and gets a policy loose enough for HMR
    // (inline/eval + ws) while still locking down object-src/base-uri.
    const isRendererDoc =
      details.resourceType === "mainFrame" || details.resourceType === "subFrame";
    if (isRendererDoc) {
      if (app.isPackaged && details.url.startsWith("app://")) {
        responseHeaders["Content-Security-Policy"] = [
          [
            "default-src 'self'",
            `script-src 'self' ${docsBase}`,
            // MapLibre builds its render worker from a blob: URL. worker-src
            // has no policy of its own here, so it falls back to script-src,
            // which does not allow blob: - the worker was refused, MapLibre
            // threw inside a React effect, and the whole renderer unmounted to
            // a white window. Kept separate from script-src on purpose: this
            // permits a worker built from a blob, not inline script anywhere.
            "worker-src 'self' blob:",
            // blob: throughout for the ebook reader: foliate-js renders the
            // book inside a blob iframe and hands it the book's OWN stylesheets,
            // fonts and media as blob/data URLs. Without these the reader loads
            // and then quietly drops the book's typography and images.
            "style-src 'self' 'unsafe-inline' blob:",
            `img-src 'self' data: blob: ${apiBase} ${docsBase}`,
            // sentry-ipc: is the crash reporter's renderer-to-main fallback
            // (a fetch to a privileged in-process scheme, never the network)
            // used only if the preload's IPC bridge is unavailable.
            `connect-src 'self' sentry-ipc: ${apiBase} ${docsBase}`,
            // In-app file viewer: <video>/<audio> stream from the API, and the
            // PDF preview loads /raw in an <iframe>. Without these, media falls
            // back to default-src 'self' and gets blocked.
            `media-src 'self' blob: data: ${apiBase}`,
            `frame-src 'self' blob: ${apiBase} ${docsBase}`,
            "font-src 'self' data: blob:",
            "object-src 'none'",
            "base-uri 'self'",
          ].join("; "),
        ];
      } else if (!app.isPackaged && details.url.startsWith("http://localhost")) {
        responseHeaders["Content-Security-Policy"] = [
          [
            "default-src 'self' http://localhost:* ws://localhost:*",
            `script-src 'self' 'unsafe-inline' 'unsafe-eval' ${docsBase}`,
            // Same as the packaged policy: the map's worker comes from a blob.
            "worker-src 'self' blob: http://localhost:*",
            "style-src 'self' 'unsafe-inline' blob:",
            `img-src 'self' data: blob: http://localhost:* ${apiBase} ${docsBase}`,
            `connect-src 'self' sentry-ipc: http://localhost:* ws://localhost:* ${apiBase} ${docsBase}`,
            `media-src 'self' blob: data: http://localhost:* ${apiBase}`,
            `frame-src 'self' blob: http://localhost:* ${apiBase} ${docsBase}`,
            "font-src 'self' data: blob:",
            "object-src 'none'",
            "base-uri 'self'",
          ].join("; "),
        ];
      }
    }

    // Capture dosya_session from Set-Cookie and store it manually.
    // This is the primary mechanism for cookie storage - the cookies.on("changed")
    // listener below is a safety net for cookies that Chromium does store natively.
    // Gate on the parsed origin, NOT a prefix match. `startsWith(apiBase)` was
    // satisfied by an attacker-registered `api.dosya.dev.evil.example`, whose
    // Set-Cookie was then written into the real store scoped to apiBase -
    // letting attacker content fixate the victim's session.
    if (originAllowed(details.url, [apiBase])) {
      for (const update of parseSessionCookieHeaders(responseHeaders)) {
        if (update.action === "clear") {
          // Logout clears whichever name(s) the store might hold.
          ses.cookies.remove(apiBase, HOST_SESSION_COOKIE).catch(() => {});
          ses.cookies.remove(apiBase, LEGACY_SESSION_COOKIE).catch(() => {});
        } else {
          ses.cookies.set({
            url: apiBase,
            // Store under the name the API issued - it validates that exact
            // name. `path: "/"` (plus secure + no domain) is what lets Chromium
            // accept a `__Host-`-prefixed cookie; without it the set is rejected.
            name: update.name,
            value: update.value,
            httpOnly: true,
            secure: true,
            sameSite: "no_restriction",
            path: "/",
            expirationDate: Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60,
          }).catch(() => {});
        }
      }
    }

    callback({ responseHeaders });
  });

  // Ensure the session cookie works for cross-origin fetch requests.
  //
  // The renderer (file:// or localhost:5174) and the API (dosya.dev or
  // localhost:4321) are different origins. For `credentials: 'include'` to
  // send the cookie, it must be SameSite=None + Secure=true.
  //
  // Chromium exempts localhost from the HTTPS requirement for Secure cookies,
  // so this works in both dev (http://localhost) and production (https://dosya.dev).
  //
  // We also persist the cookie across restarts by setting expirationDate.
  // Without it, Electron treats it as a session cookie deleted on close.
  ses.cookies.on("changed", (_event, cookie, _cause, removed) => {
    if (removed || !isSessionCookieName(cookie.name)) return;
    const needsSameSiteFix = cookie.sameSite !== "no_restriction";
    const needsExpiryFix = !cookie.expirationDate;
    if (needsSameSiteFix || needsExpiryFix) {
      ses.cookies.set({
        url: apiBase,
        name: cookie.name,
        value: cookie.value,
        httpOnly: cookie.httpOnly,
        secure: true,
        // Preserve Path=/ so a __Host- cookie stays valid on re-set.
        path: "/",
        expirationDate: cookie.expirationDate || Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60,
        sameSite: "no_restriction",
      }).catch(() => {});
    }
  });
}

/**
 * Clear the dosya session cookie and all cached data (used on logout).
 * Removes cookies, localStorage, IndexedDB, Cache API, and HTTP cache
 * to prevent cross-account data leakage.
 */
export async function clearSessionCookie(apiBase: string): Promise<void> {
  const url = apiBase;
  const cookies = await session.defaultSession.cookies.get({ url });
  for (const cookie of cookies) {
    if (isSessionCookieName(cookie.name)) {
      await session.defaultSession.cookies.remove(url, cookie.name);
    }
  }
  // Clear all cached data to prevent cross-account leakage
  await session.defaultSession.clearStorageData();
  await session.defaultSession.clearCache();
}
