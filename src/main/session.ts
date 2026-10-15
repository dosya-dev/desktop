import { app, session } from "electron";
import { originAllowed } from "./trusted-origins";
import {
  parseSessionCookieHeaders,
  isSessionCookieName,
  HOST_SESSION_COOKIE,
  LEGACY_SESSION_COOKIE,
} from "./session-cookie";
import { chunkOrigins, packagedCsp, devCsp, type CspInputs } from "./csp";
import { webRequestFilter } from "./session-filter";

/** The ONLYOFFICE document server the editor loads from. Overridable for a
 * self-hosted one; both policies have to name it or the editor silently
 * never becomes an editor. */
function onlyofficeBase(): string {
  return process.env.ONLYOFFICE_SERVER_URL || "https://docs.dosya.dev";
}

/** The inputs both policies are built from. */
function cspInputsFor(apiBase: string): CspInputs {
  return {
    apiBase,
    docsBase: onlyofficeBase(),
    chunkOrigins: chunkOrigins(process.env.E2EE_CHUNK_ORIGINS),
  };
}

/**
 * The policy for an `app://` document, for registerAppProtocol() in index.ts.
 *
 * Lives here rather than in index.ts so the policy's inputs - the API origin,
 * the ONLYOFFICE origin and its env override, the E2EE chunk origins - are
 * resolved in exactly one place, and the dev policy set in `setupSession`
 * below cannot drift from the packaged one set at the protocol handler.
 *
 * It is the PACKAGED policy unconditionally, gated on the scheme by the
 * caller and never on `app.isPackaged`. That is deliberate: there are three
 * real configurations, and `app.isPackaged` does not separate them -
 *
 *   packaged release      isPackaged=true   app://bundle/index.html
 *   electron-vite dev     isPackaged=false  http://localhost:5174
 *   built-but-unpackaged  isPackaged=false  app://bundle/index.html
 *
 * - so the old `app.isPackaged && app://` condition left the third one with
 * no policy at all. That third configuration is `electron-vite preview` and
 * every Playwright run, i.e. the only configuration any automated test can
 * observe, which is why nothing could verify the CSP until it moved here.
 * The scheme alone decides: an `app://` document is the built bundle,
 * whoever built it, and the strict policy is correct for all of them.
 */
export function appDocumentCsp(apiBase: string): string {
  return packagedCsp(cspInputsFor(apiBase));
}

/**
 * Configure Electron's session for the desktop app:
 * 1. Tag desktop requests with X-Dosya-Client.
 * 2. Fix the session cookie's SameSite + expiry for cross-origin fetch.
 * 3. Set the Content Security Policy for a `electron-vite dev` renderer.
 *    (An `app://` document gets its policy from registerAppProtocol() in
 *    index.ts instead - see `appDocumentCsp` above.)
 *
 * The window runs with webSecurity ENABLED: the renderer has a real origin
 * (app://bundle packaged, http://localhost:5174 dev) that the API allows via
 * CORS, so credentialed cross-origin fetch works without disabling security.
 * Navigation is further locked down by will-navigate, setWindowOpenHandler,
 * and the CSP (here for dev, in the app: protocol handler for the bundle).
 */
export function setupSession(apiBase: string): void {
  const ses = session.defaultSession;

  // BOTH hooks below get this filter (see session-filter.ts for the full
  // reasoning, including why the ONLYOFFICE docs origin is NOT in it). With
  // no filter Electron ran them - a blocking main-process round trip - for
  // every request the app made; an audit measured +0.239ms mean latency per
  // request and ~738 blocking callbacks over one ordinary workload. What
  // each hook actually does is gated on `originAllowed(details.url,
  // [apiBase])` or on a localhost renderer URL, and the filter names exactly
  // those two, so it is behaviourally equivalent.
  const filter = webRequestFilter(apiBase);

  // Tag desktop requests so the server can distinguish desktop vs web.
  // We deliberately do NOT spoof the Origin header anymore: with webSecurity
  // enabled the browser enforces CORS against the renderer's REAL origin
  // (app://bundle in packaged builds, http://localhost:5174 in dev). The API
  // allows those origins via CORS_ALLOWED_ORIGINS, so overwriting Origin here
  // would break the Access-Control-Allow-Origin match.
  ses.webRequest.onBeforeSendHeaders(filter, (details, callback) => {
    if (originAllowed(details.url, [apiBase])) {
      details.requestHeaders["X-Dosya-Client"] = `desktop/${app.getVersion()}`;
    }
    callback({ requestHeaders: details.requestHeaders });
  });

  // Set the dev CSP and manually capture the session cookie.
  //
  // Chromium 120+ blocks third-party cookies by default. Since the renderer
  // (app://bundle or localhost) and the API (dosya.dev) are different
  // origins, Set-Cookie headers from API responses are silently discarded by
  // the renderer. We intercept the response headers here in the main process
  // and manually store the cookie via Electron's cookies API, which bypasses
  // the renderer-level third-party cookie restrictions.
  const cspInputs = cspInputsFor(apiBase);

  // Now filtered, like onBeforeSendHeaders above. It could not be until the
  // packaged CSP moved out of it: this hook used to be what applied the
  // policy to `app://` documents, and Chromium's webRequest match-pattern
  // parser rejects a custom scheme outright - `{ urls: ["app://*/*"] }`
  // throws `Invalid url pattern app://*/*: Wrong scheme type` at
  // registration time (verified against this app's real Electron 43.4.0
  // binary - a unit test over the generated pattern STRINGS cannot catch
  // this, since the string looks fine; only Chromium's own parser rejects
  // it), and that throw is inside `app.whenReady()`, so it would stop the
  // window from ever being created. `registerAppProtocol()` in index.ts
  // serves every `app://` document and now attaches the policy there, which
  // needs no webRequest filter at all - and, unlike the branch that used to
  // live here, covers the built-but-unpackaged configuration (`app://` with
  // `app.isPackaged === false`: `electron-vite preview` and the whole
  // Playwright suite) that matched neither of this hook's old conditions.
  ses.webRequest.onHeadersReceived(filter, (details, callback) => {
    const responseHeaders = { ...details.responseHeaders };

    // Apply the DEV Content-Security-Policy to the renderer document
    // (mainFrame + subFrame). This branch is now the only one here: an
    // `app://` document is served by registerAppProtocol() in index.ts,
    // which attaches the packaged policy itself, so there is nothing left
    // for this hook to do for that scheme. What remains is `electron-vite
    // dev`, where Vite serves the renderer over http on localhost and the
    // protocol handler never sees it; that policy is loose enough for HMR
    // (inline/eval + ws) while still locking down object-src/base-uri.
    const isRendererDoc =
      details.resourceType === "mainFrame" || details.resourceType === "subFrame";
    if (isRendererDoc && !app.isPackaged && details.url.startsWith("http://localhost")) {
      responseHeaders["Content-Security-Policy"] = [devCsp(cspInputs)];
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
