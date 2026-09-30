import { describe, it, expect, vi, afterEach, beforeAll } from "vitest";
import { buildE2eeClient, normalizeRecoveryKey } from "./client";
import { primeApiBase } from "@/lib/api-client";

// A valid base64 encoding of 32 zero bytes - it only has to decode cleanly so
// oprfPublicKey() resolves; the key material is irrelevant here.
const ZERO_KEY_B64 = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";

beforeAll(async () => {
  // api-client reads the base over IPC once at bootstrap; stand in for main.
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    getApiBase: async () => "http://api.test",
  };
  await primeApiBase();
});

afterEach(() => vi.unstubAllGlobals());

describe("buildE2eeClient", () => {
  it("API calls go to the primed base with the session cookie (credentials: include)", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ publicKey: ZERO_KEY_B64 }), {
        status: 200, headers: { "Content-Type": "application/json" },
      }));
    vi.stubGlobal("fetch", fetchMock);

    const { api } = buildE2eeClient();
    await api.oprfPublicKey();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [RequestInfo | URL, RequestInit | undefined];
    expect(String(url)).toBe("http://api.test/api/e2ee/oprf-public-key");
    expect(init?.credentials).toBe("include");
  });

  it("chunk transport requests carry no credentials (the presigned URL is the credential)", async () => {
    const fetchMock = vi.fn(async () => new Response(new Uint8Array([1, 2, 3]), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const { transport } = buildE2eeClient();
    await transport.getChunk("https://example.r2.cloudflarestorage.com/e2ee/ws/chunk?sig=abc");

    const [, init] = fetchMock.mock.calls[0] as unknown as [RequestInfo | URL, RequestInit | undefined];
    expect(init?.credentials).toBeUndefined();
  });
});

describe("normalizeRecoveryKey", () => {
  it("drops every kind of whitespace and dash a paste can carry", () => {
    expect(normalizeRecoveryKey("  ab12-cd34 ef56\n")).toBe("ab12cd34ef56");
    expect(normalizeRecoveryKey("ab12\tcd34\r\nef56")).toBe("ab12cd34ef56");
    expect(normalizeRecoveryKey("ab12 - cd34 - ef56")).toBe("ab12cd34ef56");
  });

  it("changes nothing else - the key is hex and case is not ours to touch", () => {
    expect(normalizeRecoveryKey("AB12cd34")).toBe("AB12cd34");
    expect(normalizeRecoveryKey("")).toBe("");
  });
});
