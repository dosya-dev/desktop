import { app, session } from "electron";

/**
 * Configure Electron's session for the desktop app:
 * 1. Spoof the Origin header so the API sees requests as same-origin.
 * 2. Fix the session cookie's SameSite + expiry for cross-origin fetch.
 * 3. Set a Content Security Policy in production.
 *
 * CORS is handled by webSecurity:false on the BrowserWindow. The main
 * attack surface that opens (malicious page navigation) is locked down
 * by will-navigate, setWindowOpenHandler, and the CSP below.
 */
export function setupSession(apiBase: string): void {
  const ses = session.defaultSession;

  // Spoof Origin header so the API sees requests as same-origin,
  // and add a client identifier so the server can distinguish desktop vs web.
  ses.webRequest.onBeforeSendHeaders((details, callback) => {
    if (details.url.startsWith(apiBase)) {
      details.requestHeaders["Origin"] = apiBase;
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
  ses.webRequest.onHeadersReceived((details, callback) => {
    const responseHeaders = { ...details.responseHeaders };

    // Apply CSP to all frames (mainFrame + subFrame) from file:// in production.
    // Previously only mainFrame was covered, leaving iframes unprotected.
    if (app.isPackaged && (details.resourceType === "mainFrame" || details.resourceType === "subFrame") && details.url.startsWith("file://")) {
      responseHeaders["Content-Security-Policy"] = [
        [
          "default-src 'self'",
          "script-src 'self'",
          "style-src 'self' 'unsafe-inline'",
          "img-src 'self' data: blob:",
          `connect-src 'self' ${apiBase}`,
          "font-src 'self' data:",
          "object-src 'none'",
          "base-uri 'self'",
        ].join("; "),
      ];
    }

    // Capture dosya_session from Set-Cookie and store it manually.
    // This is the primary mechanism for cookie storage — the cookies.on("changed")
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
