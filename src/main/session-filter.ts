/**
 * Chromium match-pattern filter for BOTH webRequest hooks in session.ts:
 * `onBeforeSendHeaders` (the desktop client tag) and `onHeadersReceived`
 * (the session-cookie capture, plus the dev-only CSP).
 *
 * Those hooks used to register with NO filter at all, so their callbacks ran
 * for EVERY request the app makes: fonts, R2 chunk uploads, map tiles,
 * ONLYOFFICE assets, everything (~738 callbacks over one ordinary library
 * workload: 2 hooks x 369 requests). Each callback's work is gated on
 * `originAllowed(details.url, [apiBase])` or on a localhost renderer URL -
 * neither does anything for any other origin - so a filter naming only
 * those two is exactly equivalent and loses nothing.
 *
 * WHAT THIS FILTER DOES NOT BUY, measured. The audit that raised this
 * attributed +0.239 ms per request to the two hooks by comparing
 * `defaultSession` against a fresh partition session. Those two sessions
 * differ in far more than hooks - a persistent on-disk cache, a populated
 * cookie jar, proxy configuration - so that number is an upper bound on hook
 * cost and not a measurement of it. Measured instead within ONE session, by
 * removing the app's own listeners mid-run and re-sampling
 * (`desktop-audit/specs/17-hook-marginal-cost.spec.ts`, 400 samples a row,
 * mean, for an origin this filter excludes):
 *
 *   no listener on the session at all             0.265 ms
 *   ONE listener whose filter matches NOTHING     0.351 ms
 *   the app as shipped                            0.403 ms
 *
 * A listener whose filter can never match still costs ~0.086 ms per request.
 * Electron installs its proxying URL loader factory for the whole session as
 * soon as ANY listener exists, and evaluates `urls` only after the request
 * has been handed to the browser process - so a filter cannot avoid that
 * round trip, only the callback body. And the callback body is cheap: for an
 * origin outside the filter the app's hooks cost 0.147 ms unfiltered and
 * 0.138 ms filtered, a ~0.01 ms saving that sits inside this measurement's
 * own noise.
 *
 * So this filter is kept because it makes the intent explicit and stops two
 * callbacks running for origins they ignore - NOT because it removes the
 * per-request cost. Removing that would mean not registering the hooks at
 * all: the client tag would move into the fetch wrapper, and the
 * `Set-Cookie` capture would need a mechanism that is not a webRequest hook.
 *
 * One more thing the bundle will show you: `@sentry/electron` also calls
 * `onHeadersReceived` with no filter, from its `addHeaderToSession`, for the
 * js-profiling and crash-report-call-stack integrations. Electron keeps only
 * the LAST listener registered for an event on a session, so if either of
 * those integrations is ever enabled it would silently replace the listener
 * below - and the symptom is the one described above: login appears to
 * succeed and then every request 401s. Neither is enabled today
 * (`telemetry.ts` passes no `integrations` and no profiling option), so that
 * code is inert.
 *
 * Two patterns, and why each is needed:
 *
 * 1. The API origin. `onBeforeSendHeaders` tags requests to it;
 *    `onHeadersReceived` captures `Set-Cookie` from it. Dropping this
 *    pattern does not crash anything - login appears to succeed and then
 *    every later request 401s, because the session cookie was never stored.
 *    `tests/e2e/auth.spec.ts` is the guard for that.
 *
 * 2. `http://localhost:*` - the `electron-vite dev` renderer (port 5174).
 *    That document is served by Vite over http, never by the app: protocol
 *    handler, so `onHeadersReceived` is still the only place its (looser,
 *    HMR-friendly) CSP can be attached. Any port, because the dev server
 *    will fall back off 5174 and because a dev apiBase is on localhost too.
 *
 * Deliberately absent: any custom scheme. Chromium's match-pattern parser
 * rejects one outright - an app: scheme pattern (any host, any path) throws
 * "Wrong scheme type" at registration, verified against the real Electron
 * 43.4.0 binary this app ships - and registration happens inside
 * `app.whenReady()`, so the throw would stop the window from ever being
 * created. That restriction used to be the reason `onHeadersReceived` could
 * not be filtered at all: it was where the packaged `app://` CSP was set.
 * The policy now lives in the app: protocol handler in index.ts, which sees
 * that scheme without going through webRequest, so this hook no longer
 * needs to see app: documents and can finally be filtered.
 * (A literal app-scheme pattern is deliberately not spelled out in this
 * comment: it ends in a star-slash, which would close this very comment
 * block early. See the dedicated test in session-filter.test.ts for the
 * exact string.)
 *
 * This is a coarse PRE-gate only, not a replacement for the authorization
 * check. Both hooks still call `originAllowed()` (trusted-origins.ts)
 * before doing anything API-scoped, because Chromium match patterns are
 * themselves a wildcard/prefix test - the same class of bug `originAllowed`
 * exists to close for a `startsWith` comparison - and must never be trusted
 * as the security boundary.
 *
 * Deliberately excluded: the ONLYOFFICE document-server origin (`docsBase`
 * in session.ts, `process.env.ONLYOFFICE_SERVER_URL || "https://docs.dosya.dev"`).
 * It is named in the CSP's *policy text* (script-src/frame-src, so the
 * editor iframe and its api.js are allowed to load) but neither hook reads
 * or writes anything scoped to a request to or from it - they only ever
 * check `apiBase`. Adding it would only buy back an IPC round trip on every
 * ONLYOFFICE asset request for zero behavioural change - exactly the cost
 * this filter exists to remove.
 */
export type WebRequestFilter = { urls: string[] };

/**
 * The dev renderer's origin, any port. `http://localhost:*` registers fine
 * (http is a special scheme); only custom schemes are rejected.
 */
const DEV_RENDERER_PATTERN = "http://localhost:*/*";

export function webRequestFilter(apiBase: string): WebRequestFilter {
  // New URL(...).origin, never string concatenation: apiBase carries a port
  // in dev (http://localhost:4322) and dropping it would silently take the
  // dev API's own origin OUT of the filter, which `url.host`-style string
  // slicing or a bare `apiBase + "/*"` on an unexpected input both risk.
  //
  // Parsed inside a try only to improve the error. This runs during
  // `setupSession()`, inside `app.whenReady()` and before the window is
  // created, so a bare "Invalid URL" from an unparseable API_BASE would leave
  // the user with no window and no explanation. Before this filter existed a
  // malformed value merely made `originAllowed` reject, which failed later
  // and more legibly; this says what is wrong instead of taking that back.
  let apiOrigin: string;
  try {
    apiOrigin = new URL(apiBase).origin;
  } catch {
    throw new Error(
      `API_BASE is not a valid absolute URL: ${JSON.stringify(apiBase)}. ` +
        `It must look like "https://api.dosya.dev" or "http://localhost:4322".`,
    );
  }
  const apiPattern = `${apiOrigin}/*`;

  // Deduplicated rather than subsumption-checked: a dev apiBase on localhost
  // is already covered by the wildcard-port pattern, but only by exact string
  // equality is that safe to assume - "http://localhost:4322/*" and
  // "http://localhost:*/*" are different strings, and Chromium is perfectly
  // happy to be handed both.
  const urls = apiPattern === DEV_RENDERER_PATTERN ? [apiPattern] : [apiPattern, DEV_RENDERER_PATTERN];

  return { urls };
}
