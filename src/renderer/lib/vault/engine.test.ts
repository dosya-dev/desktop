import { describe, it, expect, vi, beforeEach } from "vitest";

const deleteMock = vi.fn();
vi.mock("@/lib/api-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api-client")>();
  return {
    ...actual,
    apiBase: () => "http://api.test",
    api: { ...actual.api, delete: (...args: unknown[]) => deleteMock(...args) },
  };
});

const recoveryUnlock = vi.fn();
const passphraseUnlock = vi.fn();
const createWorkspace = vi.fn();
const setupIdentity = vi.fn();
vi.mock("@dosya-dev/e2ee-client", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    unlock: (...a: unknown[]) => passphraseUnlock(...a),
    createWorkspace: (...a: unknown[]) => createWorkspace(...a),
    unlockWithRecoveryKey: (...a: unknown[]) => recoveryUnlock(...a),
    setupIdentity: (...a: unknown[]) => setupIdentity(...a),
  };
});

const { defaultEngine, recoveryUnlockFrom } = await import("./engine");

const SESSION = { kek: new Uint8Array(1), identity: {} } as never;

beforeEach(() => {
  deleteMock.mockReset();
  recoveryUnlock.mockReset();
  passphraseUnlock.mockReset();
  createWorkspace.mockReset();
  setupIdentity.mockReset();
  recoveryUnlock.mockResolvedValue(SESSION);
  passphraseUnlock.mockResolvedValue(SESSION);
  createWorkspace.mockResolvedValue({} as never);
  setupIdentity.mockResolvedValue({ session: SESSION, recoveryKey: new Uint8Array([0xab, 0x12, 0x00, 0xff]) });
});

describe("defaultEngine.setup", () => {
  it("returns the recovery key as lowercase hex", async () => {
    const { recoveryKeyHex } = await defaultEngine().setup("passphrase");
    expect(recoveryKeyHex).toBe("ab1200ff");
  });
});

describe("recoveryUnlockFrom", () => {
  it("is null when the bundle has no callable export", () => {
    expect(recoveryUnlockFrom({})).toBeNull();
    expect(recoveryUnlockFrom(undefined)).toBeNull();
    expect(recoveryUnlockFrom({ unlockWithRecoveryKey: "soon" })).toBeNull();
  });
  it("hands back the function when there is one", () => {
    const fn = vi.fn();
    expect(recoveryUnlockFrom({ unlockWithRecoveryKey: fn })).toBe(fn);
  });
});

describe("defaultEngine.unlockWithRecoveryKey", () => {
  it("strips whitespace and dashes before the key reaches the library", async () => {
    await defaultEngine().unlockWithRecoveryKey("  ab12-cd34 ef56\n");
    expect(recoveryUnlock).toHaveBeenCalledTimes(1);
    expect(recoveryUnlock.mock.calls[0][1]).toBe("ab12cd34ef56");
  });
});

describe("defaultEngine.destroyIdentity", () => {
  it("DELETEs /api/e2ee/user-keys with password and totp_code through the desktop API client", async () => {
    deleteMock.mockResolvedValue(undefined);
    await defaultEngine().destroyIdentity("hunter22", "123456");
    expect(deleteMock).toHaveBeenCalledWith("/api/e2ee/user-keys", { password: "hunter22", totp_code: "123456" });
  });

  it("omits totp_code when none was given", async () => {
    deleteMock.mockResolvedValue(undefined);
    await defaultEngine().destroyIdentity("hunter22");
    expect(deleteMock).toHaveBeenCalledWith("/api/e2ee/user-keys", { password: "hunter22" });
  });

  it("keeps the unlocked session when the server refuses", async () => {
    const engine = defaultEngine();
    await engine.unlock("passphrase");
    deleteMock.mockRejectedValueOnce(new Error("Incorrect password"));
    await expect(engine.destroyIdentity("wrong")).rejects.toThrow("Incorrect password");
    await expect(engine.createWorkspace("ws_1")).resolves.toBeUndefined();
  });

  it("drops the session once the destroy succeeds", async () => {
    const engine = defaultEngine();
    await engine.unlock("passphrase");
    deleteMock.mockResolvedValueOnce(undefined);
    await engine.destroyIdentity("hunter22");
    await expect(engine.createWorkspace("ws_1")).rejects.toThrow(/locked/);
  });
});
