import { test } from "node:test";
import assert from "node:assert/strict";
import { E2EE_CHUNK_ORIGINS, chunkOrigins, devCsp, packagedCsp } from "./csp.ts";

const inputs = {
  apiBase: "https://api.dosya.dev",
  docsBase: "https://docs.dosya.dev",
  chunkOrigins: E2EE_CHUNK_ORIGINS,
};

/** The source list of one directive, or null if the policy lacks it. */
function directive(policy: string, name: string): string[] | null {
  const part = policy.split("; ").find((d) => d.startsWith(name + " "));
  return part ? part.slice(name.length + 1).split(" ") : null;
}

test("packaged policy lets libsodium instantiate WebAssembly and nothing more in script-src", () => {
  assert.deepEqual(directive(packagedCsp(inputs), "script-src"), [
    "'self'", "'wasm-unsafe-eval'", "https://docs.dosya.dev",
  ]);
});

test("packaged connect-src names the API, docs and BOTH R2 chunk endpoints", () => {
  assert.deepEqual(directive(packagedCsp(inputs), "connect-src"), [
    "'self'", "sentry-ipc:", "https://api.dosya.dev", "https://docs.dosya.dev",
    "https://0b25394b353c95a526538e19706809e8.r2.cloudflarestorage.com",
    "https://0b25394b353c95a526538e19706809e8.eu.r2.cloudflarestorage.com",
  ]);
});

test("dev policy keeps HMR allowances and adds the same two things", () => {
  const dev = devCsp({ ...inputs, apiBase: "http://localhost:4322" });
  assert.deepEqual(directive(dev, "script-src"), [
    "'self'", "'unsafe-inline'", "'unsafe-eval'", "'wasm-unsafe-eval'", "https://docs.dosya.dev",
  ]);
  const connect = directive(dev, "connect-src")!;
  assert.ok(connect.includes("ws://localhost:*"));
  for (const origin of E2EE_CHUNK_ORIGINS) assert.ok(connect.includes(origin), origin);
});

test("everything else in the packaged policy is unchanged", () => {
  const p = packagedCsp(inputs);
  assert.deepEqual(directive(p, "default-src"), ["'self'"]);
  assert.deepEqual(directive(p, "worker-src"), ["'self'", "blob:"]);
  assert.deepEqual(directive(p, "style-src"), ["'self'", "'unsafe-inline'", "blob:"]);
  assert.deepEqual(directive(p, "img-src"), ["'self'", "data:", "blob:", "https://api.dosya.dev", "https://docs.dosya.dev"]);
  assert.deepEqual(directive(p, "media-src"), ["'self'", "blob:", "data:", "https://api.dosya.dev"]);
  assert.deepEqual(directive(p, "frame-src"), ["'self'", "blob:", "https://api.dosya.dev", "https://docs.dosya.dev"]);
  assert.deepEqual(directive(p, "font-src"), ["'self'", "data:", "blob:"]);
  assert.deepEqual(directive(p, "object-src"), ["'none'"]);
  assert.deepEqual(directive(p, "base-uri"), ["'self'"]);
  assert.equal(p.split("; ").length, 11);
});

test("chunkOrigins: the built-in list by default, an env override split on commas and whitespace, blanks dropped", () => {
  assert.deepEqual(chunkOrigins(undefined), [...E2EE_CHUNK_ORIGINS]);
  assert.deepEqual(chunkOrigins(""), [...E2EE_CHUNK_ORIGINS]);
  assert.deepEqual(
    chunkOrigins(" https://a.example,https://b.example ,  ,https://c.example\n"),
    ["https://a.example", "https://b.example", "https://c.example"],
  );
  assert.deepEqual(chunkOrigins(" , , "), [...E2EE_CHUNK_ORIGINS]);
});
