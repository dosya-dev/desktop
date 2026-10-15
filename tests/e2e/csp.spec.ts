import { test, expect, navigateTo } from "../fixtures";

/**
 * The renderer's Content-Security-Policy, asserted in the ONE configuration
 * nothing could assert it in before.
 *
 * Until this spec existed the CSP was applied by `onHeadersReceived` in
 * src/main/session.ts under two conditions - `app.isPackaged && app://` or
 * `!app.isPackaged && http://localhost` - and there is a third real
 * configuration that matches NEITHER:
 *
 *   packaged release      isPackaged=true   app://bundle/index.html  -> packaged policy
 *   electron-vite dev     isPackaged=false  http://localhost:5174    -> dev policy
 *   built-but-unpackaged  isPackaged=false  app://bundle/index.html  -> NO POLICY
 *
 * That third row is `electron-vite preview` and it is this entire Playwright
 * suite: `electron.launch()` runs the built `out/main/index.js` from an
 * unpackaged tree, so `app.isPackaged` is false while the renderer is still
 * served from `app://bundle`. Every test in this file therefore used to be
 * impossible: no CSP was present to assert anything about, and a change that
 * silently dropped the policy from packaged builds would have shipped green.
 *
 * The fix moves the policy into the `app://` protocol handler in
 * src/main/index.ts, gated on the SCHEME rather than on `app.isPackaged`, so
 * every `app://` document carries the packaged policy in all three
 * configurations - which is what makes these assertions meaningful here and
 * what makes them a real guard for the packaged build.
 */

type FetchProbe = {
  status: number;
  headers: Record<string, string>;
};

/**
 * Read a response's headers through a same-origin fetch IN the renderer.
 *
 * The renderer's own origin is `app://bundle`, so a fetch for an `app://`
 * URL is same-origin and its headers are fully readable - no CORS filtering
 * to confuse a missing header with a hidden one. It also exercises the same
 * code path the document load itself takes: `protocol.handle` in index.ts.
 */
async function probe(page: import("@playwright/test").Page, url: string): Promise<FetchProbe> {
  return page.evaluate(async (target) => {
    const res = await fetch(target, { cache: "no-store" });
    const headers: Record<string, string> = {};
    res.headers.forEach((value, key) => {
      headers[key.toLowerCase()] = value;
    });
    // Drain the body so the stream is not left dangling in the main process.
    await res.text();
    return { status: res.status, headers };
  }, url);
}

type Violation = { directive: string; blocked: string } | null;

test.describe("Renderer Content-Security-Policy", () => {
  test("the app:// document response carries the packaged policy", async ({ appPage }) => {
    const { status, headers } = await probe(appPage, "app://bundle/index.html");

    expect(status).toBe(200);
    const csp = headers["content-security-policy"];
    // The failure before the fix is exactly this: the header is absent
    // (undefined), because nothing in a built-but-unpackaged run ever set it.
    expect(csp, "app://bundle/index.html must carry a Content-Security-Policy").toBeTruthy();

    // It must be the PACKAGED policy even though app.isPackaged is false
    // here - the handler gates on the scheme, not on isPackaged. These three
    // are the packaged policy's teeth, and the first two are also what tells
    // the packaged policy apart from the dev one (which carries both
    // 'unsafe-inline' and 'unsafe-eval' in script-src for Vite's HMR).
    expect(csp).toContain("script-src 'self' 'wasm-unsafe-eval'");
    expect(csp).not.toContain("'unsafe-eval'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("base-uri 'self'");
  });

  test("the reconstructed document response keeps its status and Content-Type", async ({ appPage }) => {
    // `net.fetch` returns a Response whose headers cannot be mutated, so the
    // handler builds a NEW Response to add the policy. Losing Content-Type in
    // that copy does not fail loudly - Chromium sniffs, decides the body is
    // not HTML, and renders the whole app as plain text. Assert the header
    // survived, and assert the document really parsed as HTML.
    const { status, headers } = await probe(appPage, "app://bundle/index.html");
    expect(status).toBe(200);
    expect(headers["content-type"]).toMatch(/text\/html/);

    // The live document: if Content-Type had been dropped, `document` would
    // be a text/plain wrapper with a single <pre> and no app root.
    expect(await appPage.evaluate(() => document.contentType)).toBe("text/html");
    await expect(appPage.locator("#root")).toHaveCount(1);
  });

  test("the ebook reader document carries the policy too", async ({ appPage }) => {
    // `BookViewer.tsx` iframes `/reader/index.html`, which this handler serves
    // as its own app:// document. It is the frame that renders UNTRUSTED input
    // - foliate-js plus the book's own stylesheets, fonts and media as
    // blob/data URLs - so it is the last document that should be allowed to
    // run without a policy.
    //
    // It was. The hook this handler replaced matched on the scheme and so
    // covered every app:// response including this subframe; a first pass at
    // the handler tested `filePath === indexPath` instead, which silently
    // excluded exactly this file in packaged builds. No probe of
    // index.html can catch that, which is why this case names the reader.
    const { status, headers } = await probe(appPage, "app://bundle/reader/index.html");

    expect(status).toBe(200);
    expect(
      headers["content-security-policy"],
      "app://bundle/reader/index.html must carry a Content-Security-Policy",
    ).toBeTruthy();
    expect(headers["content-security-policy"]).toContain("object-src 'none'");
    expect(headers["content-security-policy"]).toContain("base-uri 'self'");
    expect(headers["content-type"]).toMatch(/text\/html/);
  });

  test("the client-routing fallback document also carries the policy", async ({ appPage }) => {
    // An unknown path falls back to index.html so the hash router resolves.
    // That fallback is a document too and must not be the one hole in the
    // policy - it is reachable by navigation, which is the case that matters.
    const { status, headers } = await probe(appPage, "app://bundle/not-a-real-asset-path");
    expect(status).toBe(200);
    expect(headers["content-security-policy"], "the routing fallback must carry the policy too").toBeTruthy();
    expect(headers["content-type"]).toMatch(/text\/html/);
  });

  test("a renderer asset is NOT given a policy of its own", async ({ appPage }) => {
    // A stylesheet or a script chunk carries no policy - a CSP on one is
    // inert noise, and putting it on every asset response would mean
    // rebuilding every single Response the handler serves. The policy belongs
    // on the document only.
    const assetUrl = await appPage.evaluate(() => {
      const el = document.querySelector<HTMLScriptElement>("script[src]");
      return el ? el.src : null;
    });
    expect(assetUrl, "expected the built document to reference a script asset").toBeTruthy();
    expect(assetUrl!.startsWith("app://bundle/")).toBe(true);

    const { status, headers } = await probe(appPage, assetUrl!);
    expect(status).toBe(200);
    expect(headers["content-security-policy"]).toBeUndefined();
  });

  test("the policy is enforced on the loaded document: a foreign image is refused", async ({ appPage }) => {
    // Asserting the EFFECT, not just the header: this proves the policy
    // reached the document Chromium actually committed, not merely a fetch of
    // it. A resource load is used rather than eval() on purpose - a
    // CDP-driven `page.evaluate` is allowed to generate code from strings
    // regardless of script-src, so an eval-based probe would pass with or
    // without a CSP and prove nothing.
    //
    // .invalid is reserved by RFC 2606 and never resolves, so this cannot
    // reach the network even if the policy were missing.
    const violation = await appPage.evaluate<Violation>(
      () =>
        new Promise((resolve) => {
          const timer = setTimeout(() => resolve(null), 5000);
          document.addEventListener(
            "securitypolicyviolation",
            (event) => {
              clearTimeout(timer);
              resolve({ directive: event.violatedDirective, blocked: event.blockedURI });
            },
            { once: true },
          );
          const img = document.createElement("img");
          img.style.display = "none";
          img.src = "https://blocked.invalid/pixel.png";
          document.body.appendChild(img);
        }),
    );

    expect(violation, "no violation event means the document has no enforced CSP").not.toBeNull();
    expect(violation!.directive).toMatch(/^img-src/);
  });

  test("the policy is enforced on the loaded document: an injected inline script never runs", async ({ appPage }) => {
    // The directive that matters most: `script-src 'self' 'wasm-unsafe-eval'`
    // has no 'unsafe-inline', so an injected inline <script> must be refused
    // outright. This is the one that would have caught a silently-dropped
    // policy in a packaged build.
    const violation = await appPage.evaluate<Violation>(
      () =>
        new Promise((resolve) => {
          const timer = setTimeout(() => resolve(null), 5000);
          document.addEventListener(
            "securitypolicyviolation",
            (event) => {
              clearTimeout(timer);
              resolve({ directive: event.violatedDirective, blocked: event.blockedURI });
            },
            { once: true },
          );
          const script = document.createElement("script");
          script.textContent = "window.__cspInlineScriptRan = true;";
          document.body.appendChild(script);
        }),
    );

    expect(violation, "no violation event means the document has no enforced CSP").not.toBeNull();
    expect(violation!.directive).toMatch(/^script-src/);
    // The assertion with the real teeth: the inline script did not execute.
    expect(await appPage.evaluate(() => (window as unknown as Record<string, unknown>).__cspInlineScriptRan)).toBeUndefined();
  });

  test("the app's own startup and core routes are refused nothing", async ({ appPage }) => {
    // Applying a policy in a configuration that previously had none can
    // surface a LATENT violation no spec ever exercised, so this watches the
    // app load and move around under the new policy and asserts nothing was
    // refused. Two channels, because neither alone is sufficient:
    //
    // 1. The `securitypolicyviolation` events. The collector is installed via
    //    addInitScript so it is listening BEFORE the document's own scripts
    //    run on the reload below - the only way to see a startup violation.
    //    One class of event has to be excluded, and it is NOT an app problem:
    //    Playwright reconstitutes every page function it sends by calling
    //    `window.eval` on its source inside the page
    //    (`eval(expression) { return this.window.eval(expression); }` in
    //    node_modules/playwright-core/lib/generated/injectedScriptSource.js),
    //    and a CDP evaluation carries `allowUnsafeEvalBlockedByCSP`, so that
    //    eval is PERMITTED while still dispatching a violation event. It
    //    reports `{ violatedDirective: "script-src", blockedURI: "eval" }`
    //    with no source file and nothing refused - every other spec in this
    //    file, and the whole suite, keeps working. Verified: no built renderer
    //    chunk contains an eval at the reported line, and a genuinely blocked
    //    eval always logs to the console, which this one does not.
    // 2. The console. A CSP that actually REFUSES something always logs
    //    "Refused to ..." - and that is exactly what channel 1's excluded
    //    event does not do, so app code that really did get its eval blocked
    //    would still be caught here rather than hidden by the exclusion.
    await appPage.addInitScript(() => {
      (window as unknown as Record<string, unknown>).__cspViolations = [];
      document.addEventListener("securitypolicyviolation", (event) => {
        (
          (window as unknown as Record<string, unknown>).__cspViolations as unknown[]
        ).push({
          directive: event.violatedDirective,
          blocked: event.blockedURI,
          source: event.sourceFile,
          line: event.lineNumber,
        });
      });
    });

    const refusals: string[] = [];
    appPage.on("console", (msg) => {
      if (/Refused to/.test(msg.text())) refusals.push(msg.text().slice(0, 400));
    });

    await appPage.reload();
    await appPage.waitForLoadState("domcontentloaded");
    await expect(appPage.locator("#root")).not.toBeEmpty();
    await appPage.waitForTimeout(1500);

    for (const route of ["/files", "/settings", "/dashboard"]) {
      await navigateTo(appPage, route);
    }

    const violations = (await appPage.evaluate(
      () => (window as unknown as Record<string, unknown>).__cspViolations as unknown[],
    )) as { directive: string; blocked: string }[];

    // Everything except the harness's own permitted eval (see above). Any
    // resource the app loads - a blob: worker, a blob: iframe, a font, an
    // ONLYOFFICE script, an API connection - lands here if it is refused.
    const appViolations = violations.filter(
      (v) => !(v.blocked === "eval" && v.directive.startsWith("script-src")),
    );
    expect(appViolations, "a startup or core-route load was refused by the CSP").toEqual([]);
    expect(refusals, "the renderer logged a CSP refusal").toEqual([]);
  });
});
