import { app, session } from "electron";

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
    if (details.url.startsWith(apiBase)) {
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
            // blob: throughout for the ebook reader: foliate-js renders the
            // book inside a blob iframe and hands it the book's OWN stylesheets,
            // fonts and media as blob/data URLs. Without these the reader loads
            // and then quietly drops the book's typography and images.
            "style-src 'self' 'unsafe-inline' blob:",
            `img-src 'self' data: blob: ${apiBase} ${docsBase}`,
            `connect-src 'self' ${apiBase} ${docsBase}`,
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
            "style-src 'self' 'unsafe-inline' blob:",
            `img-src 'self' data: blob: http://localhost:* ${apiBase} ${docsBase}`,
            `connect-src 'self' http://localhost:* ws://localhost:* ${apiBase} ${docsBase}`,
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
    if (details.url.startsWith(apiBase)) {
      const setCookies = responseHeaders["set-cookie"] || responseHeaders["Set-Cookie"] || [];
      for (const raw of setCookies) {
        if (!raw.startsWith("dosya_session=")) continue;
        const value = raw.split(";")[0].split("=").slice(1).join("=");
        if (!value) {
          // Empty value = cookie cleared (logout). Remove it from the store.
          ses.cookies.remove(apiBase, "dosya_session").catch(() => {});
        } else {
          ses.cookies.set({
            url: apiBase,
            name: "dosya_session",
            value,
            httpOnly: true,
            secure: true,
            sameSite: "no_restriction",
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
    if (removed || cookie.name !== "dosya_session") return;
    const needsSameSiteFix = cookie.sameSite !== "no_restriction";
    const needsExpiryFix = !cookie.expirationDate;
    if (needsSameSiteFix || needsExpiryFix) {
      ses.cookies.set({
        url: apiBase,
        name: cookie.name,
        value: cookie.value,
        httpOnly: cookie.httpOnly,
        secure: true,
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
    if (cookie.name === "dosya_session") {
      await session.defaultSession.cookies.remove(url, cookie.name);
    }
  }
  // Clear all cached data to prevent cross-account leakage
  await session.defaultSession.clearStorageData();
  await session.defaultSession.clearCache();
}
