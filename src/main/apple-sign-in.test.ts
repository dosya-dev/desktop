import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { appleSignInAvailable, makeAppleNonce, runAppleSignIn, type AppleSignInNative } from "./apple-sign-in.ts";

const fixedBytes = (n: number) => Buffer.alloc(n, 7);

test("the nonce Apple sees is the SHA-256 of the one the server receives", () => {
  const { raw, hashed } = makeAppleNonce(fixedBytes);
  assert.equal(raw, "07".repeat(32));
  assert.equal(hashed, createHash("sha256").update(raw).digest("hex"));
  assert.notEqual(makeAppleNonce().raw, makeAppleNonce().raw, "a real nonce is fresh every time");
});

test("availability needs macOS, an addon with the sheet, and the entitlement", () => {
  const entitled: AppleSignInNative = { appleSignInAvailable: () => true, signInWithApple: async () => credential() };
  assert.equal(appleSignInAvailable(entitled, "darwin"), true);
  assert.equal(appleSignInAvailable(entitled, "win32"), false, "no sheet exists off macOS");
  assert.equal(appleSignInAvailable(null, "darwin"), false, "no addon, no sheet");
  assert.equal(appleSignInAvailable({}, "darwin"), false, "an addon built before the sheet existed");
  assert.equal(appleSignInAvailable({ appleSignInAvailable: () => false }, "darwin"), false, "not entitled: the dev run, the direct download");
  assert.equal(appleSignInAvailable({ appleSignInAvailable: () => { throw new Error("x"); } }, "darwin"), false);
});

function credential(over: Partial<Awaited<ReturnType<NonNullable<AppleSignInNative["signInWithApple"]>>>> = {}) {
  return { identityToken: "jwt", authorizationCode: "code", user: "001.x", name: "", email: "", ...over };
}

test("a completed sheet becomes the server's body: token, raw nonce, and the extras Apple sent", async () => {
  const asked: string[] = [];
  const native: AppleSignInNative = {
    appleSignInAvailable: () => true,
    signInWithApple: async (hash) => { asked.push(hash); return credential({ name: "Mac User" }); },
  };
  const out = await runAppleSignIn(native, { platform: "darwin", randomBytes: fixedBytes });
  assert.deepEqual(out, {
    status: "ok",
    proof: { identity_token: "jwt", nonce: "07".repeat(32), authorization_code: "code", name: "Mac User" },
  });
  assert.deepEqual(asked, [createHash("sha256").update("07".repeat(32)).digest("hex")], "Apple was given the hash, never the raw nonce");
});

test("empty extras are left out of the body rather than sent as empty strings", async () => {
  const native: AppleSignInNative = { appleSignInAvailable: () => true, signInWithApple: async () => credential({ authorizationCode: "", name: "" }) };
  const out = await runAppleSignIn(native, { platform: "darwin" });
  assert.equal(out.status, "ok");
  if (out.status === "ok") assert.deepEqual(Object.keys(out.proof).sort(), ["identity_token", "nonce"]);
});

test("the addon's exact messages become statuses; anything else is a described failure", async () => {
  const failing = (message: string): AppleSignInNative => ({
    appleSignInAvailable: () => true,
    signInWithApple: async () => { throw new Error(message); },
  });
  assert.deepEqual(await runAppleSignIn(failing("canceled"), { platform: "darwin" }), { status: "canceled" });
  assert.deepEqual(await runAppleSignIn(failing("unavailable"), { platform: "darwin" }), { status: "unavailable" });
  assert.deepEqual(await runAppleSignIn(failing("busy"), { platform: "darwin" }), { status: "busy" });
  assert.deepEqual(await runAppleSignIn(failing("Sign in with Apple failed (com.apple.AuthenticationServices.AuthorizationError 1002)"), { platform: "darwin" }), {
    status: "failed",
    message: "Sign in with Apple failed (com.apple.AuthenticationServices.AuthorizationError 1002)",
  });
});

test("a sheet that answers without a token is a failure, not a sign-in attempt", async () => {
  const native: AppleSignInNative = { appleSignInAvailable: () => true, signInWithApple: async () => credential({ identityToken: "" }) };
  const out = await runAppleSignIn(native, { platform: "darwin" });
  assert.equal(out.status, "failed");
});

test("without the sheet the outcome is unavailable and the addon is never asked", async () => {
  let asked = 0;
  const native: AppleSignInNative = { appleSignInAvailable: () => false, signInWithApple: async () => { asked += 1; return credential(); } };
  assert.deepEqual(await runAppleSignIn(native, { platform: "darwin" }), { status: "unavailable" });
  assert.deepEqual(await runAppleSignIn(null, { platform: "darwin" }), { status: "unavailable" });
  assert.equal(asked, 0);
});
