import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * The renderer's native Apple sign-in helper: what each main-process outcome
 * and each server answer becomes for the page. The pages only switch on
 * `kind`, so these are the cases that matter.
 */

const post = vi.fn();
vi.mock("./api-client", () => ({ api: { post: (...a: unknown[]) => post(...a) } }));

import { runNativeAppleSignIn, nativeAppleSignInAvailable } from "./apple-sign-in";

type Api = { appleSignInAvailable?: () => Promise<boolean>; appleSignIn?: () => Promise<unknown> };
const setApi = (api: Api) => {
  (window as unknown as { electronAPI: Api }).electronAPI = api;
};
const proof = { identity_token: "jwt", nonce: "n".repeat(64), authorization_code: "c", name: "Mac User" };

describe("runNativeAppleSignIn", () => {
  // Braces matter: mockReset() returns the mock, and a hook that returns a
  // function hands vitest a teardown to call - which would invoke the mock.
  beforeEach(() => {
    post.mockReset();
  });
  afterEach(() => {
    delete (window as unknown as { electronAPI?: Api }).electronAPI;
  });

  it("is unavailable where the IPC is missing, so the pages fall back to the browser", async () => {
    setApi({});
    expect(await nativeAppleSignInAvailable()).toBe(false);
    expect(await runNativeAppleSignIn()).toEqual({ kind: "unavailable" });
    expect(post).not.toHaveBeenCalled();
  });

  it("is unavailable when the build has no sheet, without ever opening one", async () => {
    const appleSignIn = vi.fn();
    setApi({ appleSignInAvailable: async () => false, appleSignIn });
    expect(await runNativeAppleSignIn()).toEqual({ kind: "unavailable" });
    expect(appleSignIn).not.toHaveBeenCalled();
  });

  it("posts the sheet's proof and reports a signed-in session", async () => {
    setApi({ appleSignInAvailable: async () => true, appleSignIn: async () => ({ status: "ok", proof }) });
    post.mockResolvedValue({ ok: true });
    expect(await runNativeAppleSignIn()).toEqual({ kind: "signed-in" });
    expect(post).toHaveBeenCalledWith("/api/auth/desktop/apple", proof);
  });

  it("hands a 2FA challenge to the page with its method", async () => {
    setApi({ appleSignInAvailable: async () => true, appleSignIn: async () => ({ status: "ok", proof }) });
    post.mockResolvedValue({ ok: false, requires_2fa: true, method: "email" });
    expect(await runNativeAppleSignIn()).toEqual({ kind: "2fa", method: "email" });
  });

  it("treats a dismissed or already-open sheet as nothing to report", async () => {
    setApi({ appleSignInAvailable: async () => true, appleSignIn: async () => ({ status: "canceled" }) });
    expect(await runNativeAppleSignIn()).toEqual({ kind: "dismissed" });
    setApi({ appleSignInAvailable: async () => true, appleSignIn: async () => ({ status: "busy" }) });
    expect(await runNativeAppleSignIn()).toEqual({ kind: "dismissed" });
    expect(post).not.toHaveBeenCalled();
  });

  it("falls back to the browser when the sheet itself says it is unavailable", async () => {
    setApi({ appleSignInAvailable: async () => true, appleSignIn: async () => ({ status: "unavailable" }) });
    expect(await runNativeAppleSignIn()).toEqual({ kind: "unavailable" });
  });

  it("reports a failed sheet as a failure carrying Apple's message", async () => {
    setApi({ appleSignInAvailable: async () => true, appleSignIn: async () => ({ status: "failed", message: "code 1002" }) });
    const sheet = await runNativeAppleSignIn();
    expect(sheet.kind).toBe("failed");
    if (sheet.kind === "failed") expect((sheet.error as Error).message).toBe("code 1002");
    expect(post).not.toHaveBeenCalled();
  });

  it("reports a thrown IPC as a failure", async () => {
    setApi({ appleSignInAvailable: async () => true, appleSignIn: async () => { throw new Error("ipc down"); } });
    const out = await runNativeAppleSignIn();
    expect(out.kind).toBe("failed");
    if (out.kind === "failed") expect((out.error as Error).message).toBe("ipc down");
  });

  it("reports a refusing server as a failure carrying the thrown error", async () => {
    setApi({ appleSignInAvailable: async () => true, appleSignIn: async () => ({ status: "ok", proof }) });
    post.mockImplementation(async () => { throw new Error("401"); });
    const refused = await runNativeAppleSignIn();
    expect(refused.kind).toBe("failed");
    if (refused.kind === "failed") expect((refused.error as Error).message).toBe("401");
  });
});
