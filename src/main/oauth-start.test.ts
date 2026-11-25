import { test } from "node:test";
import assert from "node:assert/strict";

import { browserSignInUrl, PROD_WEB_APP_BASE } from "./oauth-start.ts";
import { WEB_APP_BASE } from "../renderer/lib/web-app-url.ts";

const bases = { apiBase: "https://api.example.test", webAppBase: "https://app.example.test" };

test("passkey starts on the web app page and carries the nonce", () => {
  assert.equal(
    browserSignInUrl("passkey", "nonce-1", bases),
    "https://app.example.test/connect/desktop-passkey?state=nonce-1",
  );
});

test("the nonce is encoded for the query string", () => {
  assert.equal(
    browserSignInUrl("passkey", "a&b=c", bases),
    "https://app.example.test/connect/desktop-passkey?state=a%26b%3Dc",
  );
});

for (const provider of ["google", "github", "apple"]) {
  test(`${provider} still starts at the API`, () => {
    assert.equal(
      browserSignInUrl(provider, "nonce-1", bases),
      `https://api.example.test/api/auth/${provider}?desktop=1&state=nonce-1`,
    );
  });
}

for (const provider of ["", "Passkey", "facebook", "passkey/../google", "constructor", "__proto__"]) {
  test(`unknown provider ${JSON.stringify(provider)} is rejected`, () => {
    assert.equal(browserSignInUrl(provider, "nonce-1", bases), null);
  });
}

test("the main process constant matches the renderer's web app base", () => {
  assert.equal(PROD_WEB_APP_BASE, WEB_APP_BASE);
});
