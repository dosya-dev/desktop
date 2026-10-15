import { test } from "node:test";
import assert from "node:assert/strict";
import { createProxyCache } from "./proxy-cache.ts";

test("resolves once per origin per TTL and re-resolves after clear()", async () => {
  let t = 0; let calls = 0;
  const c = createProxyCache(60_000, () => t);
  assert.equal(
    await c.get("https://a.example", async () => { calls++; return "http://proxy1:8080"; }),
    "http://proxy1:8080",
  );
  assert.equal(
    await c.get("https://a.example", async () => { calls++; return "http://proxy2:8080"; }),
    "http://proxy1:8080",
    "served from the window",
  );
  assert.equal(calls, 1);

  t = 60_000; // TTL elapsed
  assert.equal(
    await c.get("https://a.example", async () => { calls++; return "http://proxy2:8080"; }),
    "http://proxy2:8080",
  );
  assert.equal(calls, 2);

  c.clear();
  assert.equal(
    await c.get("https://a.example", async () => { calls++; return "http://proxy3:8080"; }),
    "http://proxy3:8080",
  );
  assert.equal(calls, 3);
});

test("different origins do not share an entry", async () => {
  let t = 0;
  const c = createProxyCache(60_000, () => t);
  const a = await c.get("https://a.example", async () => "http://proxy-a:8080");
  const b = await c.get("https://b.example", async () => "http://proxy-b:8080");
  assert.equal(a, "http://proxy-a:8080");
  assert.equal(b, "http://proxy-b:8080");
  const aAgain = await c.get("https://a.example", async () => "SHOULD_NOT_BE_SEEN");
  assert.equal(aAgain, "http://proxy-a:8080");
});

test("a rejected resolve is not cached", async () => {
  let t = 0;
  const c = createProxyCache(60_000, () => t);
  await assert.rejects(
    c.get("https://a.example", async () => { throw new Error("PAC evaluation failed"); }),
    /PAC evaluation failed/,
  );
  const value = await c.get("https://a.example", async () => "http://proxy-ok:8080");
  assert.equal(value, "http://proxy-ok:8080");
});

test("a null proxy (direct connection) is cached like any other value", async () => {
  let t = 0; let calls = 0;
  const c = createProxyCache(60_000, () => t);
  assert.equal(await c.get("https://a.example", async () => { calls++; return null; }), null);
  assert.equal(await c.get("https://a.example", async () => { calls++; return "http://should-not-be-seen"; }), null);
  assert.equal(calls, 1);
});
