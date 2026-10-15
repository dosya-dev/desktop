import { test } from "node:test";
import assert from "node:assert/strict";

import { webRequestFilter } from "./session-filter.ts";

/**
 * Run with `npm run test:unit` - Node's own test runner, no Electron.
 *
 * `session.ts` imports `electron` at module scope, which `node --test`
 * cannot load. The pure filter builder lives here in its own module so it
 * can be tested without Electron, and `session.ts` imports it.
 *
 * This filter is applied to BOTH webRequest hooks in session.ts:
 * `onBeforeSendHeaders` (client tag) and `onHeadersReceived` (session-cookie
 * capture + the dev CSP). Filtering the second one only became possible once
 * the packaged `app://` CSP moved into the app: protocol handler in
 * index.ts: Chromium's match-pattern parser rejects a custom scheme outright
 * - an app-scheme filter pattern throws an "Invalid url pattern ... Wrong
 * scheme type" error at registration, verified against the real Electron
 * 43.4.0 binary this app ships, which is inside `app.whenReady()` and so
 * would stop the window from ever being created. No test over generated
 * pattern STRINGS can catch that class of bug by itself - the string is
 * well-formed, only Chromium's own parser rejects it - which is exactly why
 * the "no custom scheme" test below exists: it is a standing reminder, not
 * a substitute for checking new patterns against the real thing. (The exact
 * pattern string is not spelled out in this comment block: it ends in a
 * star-slash, which would close the block early - see the test body below.)
 */

const PROD_API = "https://api.dosya.dev";
const DEV_API = "http://localhost:4322";

test("names the API origin, any path, derived from a prod apiBase", () => {
  const { urls } = webRequestFilter(PROD_API);
  assert.deepEqual(urls, ["https://api.dosya.dev/*", "http://localhost:*/*"]);
});

test("names the API origin, any path, derived from a dev apiBase - keeps the port", () => {
  const { urls } = webRequestFilter(DEV_API);
  // The bug this guards: string concatenation like `apiBase + "/*"` on a
  // bare host (no scheme/port parsing) or `url.host`-style slicing done
  // wrong can silently drop the port, which would turn this into
  // "http://localhost/*" and the dev API's own origin would fall OUTSIDE
  // the filter.
  assert.deepEqual(urls, ["http://localhost:4322/*", "http://localhost:*/*"]);
});

test("the API origin is ALWAYS in the filter - it is what the cookie capture needs", () => {
  // The regression this guards is not a crash. onHeadersReceived stores the
  // API's Set-Cookie into Electron's cookie store by hand (Chromium discards
  // it in the renderer as a third-party cookie). Drop the API origin from the
  // filter and the hook never runs for the login response: the user appears
  // to sign in, lands on the dashboard, and every request after that 401s.
  for (const base of [PROD_API, DEV_API]) {
    const expected = `${new URL(base).origin}/*`;
    assert.ok(webRequestFilter(base).urls.includes(expected));
  }
});

test("names the dev renderer origin on any port - that is where the dev CSP is attached", () => {
  // `electron-vite dev` serves the renderer from Vite over http, so the app:
  // protocol handler never sees it and onHeadersReceived is still the only
  // place devCsp() can be attached. Wildcard port: the dev server falls back
  // off 5174 when it is taken.
  assert.ok(webRequestFilter(PROD_API).urls.includes("http://localhost:*/*"));
});

test("returns no duplicate patterns", () => {
  for (const base of [PROD_API, DEV_API, "http://localhost"]) {
    const { urls } = webRequestFilter(base);
    assert.equal(new Set(urls).size, urls.length, `duplicate pattern for ${base}`);
  }
});

test("never contains a custom scheme - app:// is rejected by Chromium's own parser, not just unwanted", () => {
  // The regression this guards is a launch crash, not a latency miss:
  // registering `{ urls: ["app://*/*"] }` (or any app:// pattern) throws
  // `Invalid url pattern ...: Wrong scheme type` inside `app.whenReady()`,
  // so the window is never created. Verified against the real Electron
  // 43.4.0 binary. http/https special schemes are fine; app: is not.
  //
  // Now that this filter is applied to onHeadersReceived too, the temptation
  // to add an app: pattern is real: that hook used to be where the packaged
  // CSP was set. It is not any more - index.ts's protocol handler sets it on
  // the document it already serves - and adding the pattern here would
  // trade a working app for nothing.
  const urls = [
    ...webRequestFilter(PROD_API).urls,
    ...webRequestFilter(DEV_API).urls,
  ];
  assert.ok(!urls.some((pattern) => pattern.startsWith("app:")));
  // Every pattern is an http(s) scheme - the only kind Chromium's parser
  // accepts here - rather than just "not app:".
  assert.ok(urls.every((pattern) => /^https?:\/\//.test(pattern)));
});

test("excludes an unrelated origin - the filter is NOT <all_urls>", () => {
  const { urls } = webRequestFilter(PROD_API);
  assert.ok(!urls.includes("<all_urls>"));
  assert.ok(!urls.some((pattern) => pattern.includes("evil.example")));
  assert.ok(!urls.some((pattern) => pattern.includes("docs.dosya.dev")));
});
