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

  // Spoof Origin header so the API sees requests as same-origin.
  ses.webRequest.onBeforeSendHeaders((details, callback) => {
    if (details.url.startsWith(apiBase)) {
      details.requestHeaders["Origin"] = apiBase;
    }
    callback({ requestHeaders: details.requestHeaders });
  });

  // Set CSP in production to restrict what the renderer can load/execute.
  // Skipped in dev because Vite injects inline scripts for HMR.
  ses.webRequest.onHeadersReceived((details, callback) => {
    const responseHeaders = { ...details.responseHeaders };

    if (app.isPackaged && details.resourceType === "mainFrame" && details.url.startsWith("file://")) {
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
