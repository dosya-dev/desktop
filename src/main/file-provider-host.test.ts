import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { addonPath, readPreference, writePreference, mintLinkedSession } from "./file-provider-host.ts";

test("addonPath points into Resources when packaged and into out/ in dev", () => {
  assert.equal(
    addonPath({ packaged: true, resourcesPath: "/A/dosya.app/Contents/Resources", appRoot: "/src" }),
    "/A/dosya.app/Contents/Resources/dosya-file-provider.node",
  );
  // A dev run has no Resources directory; the build script writes next to the
  // bundles electron-vite produces.
  assert.equal(
    addonPath({ packaged: false, resourcesPath: "/ignored", appRoot: "/src" }),
    "/src/out/dosya-file-provider.node",
  );
});

test("the preference defaults to on and survives a round trip", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dosya-pref-"));
  assert.equal(await readPreference(dir), true, "a Finder location is the point of the feature");
  await writePreference(dir, false);
  assert.equal(await readPreference(dir), false);
  await writePreference(dir, true);
  assert.equal(await readPreference(dir), true);
});

test("an unreadable preference reads as on", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dosya-pref-"));
  await writeFile(join(dir, "file-provider.json"), "{not json");
  assert.equal(await readPreference(dir), true);
  await writeFile(join(dir, "file-provider.json"), JSON.stringify({ enabled: "yes" }));
  assert.equal(await readPreference(dir), true, "anything but a stored false means on");
});

test("mintLinkedSession asks the route with the cookie and returns the pair", async () => {
  const seen: { url?: string; init?: RequestInit } = {};
  const session = await mintLinkedSession("http://api.test", {
    cookieHeader: async () => "dosya_session=abc",
    fetch: async (url: string, init?: RequestInit) => {
      seen.url = url;
      seen.init = init;
      return new Response(
        JSON.stringify({ ok: true, access_token: "at", refresh_token: "rt" }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    },
  });
  assert.equal(seen.url, "http://api.test/api/auth/desktop/linked-session");
  assert.equal(seen.init?.method, "POST");
  assert.equal((seen.init?.headers as Record<string, string>).Cookie, "dosya_session=abc");
  assert.deepEqual(JSON.parse(String(seen.init?.body)), { purpose: "files-macos" });
  assert.deepEqual(session, { access: "at", refresh: "rt", apiBaseUrl: "http://api.test" });
});

test("mintLinkedSession refuses without a session cookie", async () => {
  await assert.rejects(
    mintLinkedSession("http://api.test", {
      cookieHeader: async () => null,
      fetch: async () => new Response("{}", { status: 200 }),
    }),
    /not signed in/i,
  );
});

test("mintLinkedSession reports a refusal rather than storing nothing", async () => {
  await assert.rejects(
    mintLinkedSession("http://api.test", {
      cookieHeader: async () => "dosya_session=abc",
      fetch: async () => new Response(JSON.stringify({ error: "Too many requests" }), { status: 429 }),
    }),
    /429/,
  );
  // A 200 whose body is missing a token is a refusal too: writing it would give
  // the extension a session it can never use.
  await assert.rejects(
    mintLinkedSession("http://api.test", {
      cookieHeader: async () => "dosya_session=abc",
      fetch: async () => new Response(JSON.stringify({ ok: true, access_token: "at" }), { status: 200 }),
    }),
    /token/i,
  );
});
