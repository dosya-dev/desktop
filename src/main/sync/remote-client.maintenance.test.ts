// @vitest-environment node
//
// remote-client.ts uses TypeScript parameter properties and extensionless
// relative imports (the "moduleResolution": "bundler" style electron-vite
// bundles it with) - Node's own strip-only type stripping cannot load either
// (upload-doors.test.ts documents the same limitation: "The real RemoteClient
// cannot be loaded here"). Vitest's esbuild transform handles both, so this
// one file runs there instead of the node:test convention every other
// src/main/sync/*.test.ts file uses - see vitest.config.ts's include list.
import { describe, expect, it } from "vitest";
import { RemoteClient, MaintenanceError } from "./remote-client";
import { NULL_ENV } from "./env-provider";

/**
 * A platform switch turned off answers every gated request with HTTP 503 and
 * `{ code: "surface_disabled", ... }`. The transport has to recognise that
 * shape specifically (a generic 5xx would otherwise trigger the normal
 * exponential-backoff retry inside fetch() - up to 3 extra attempts over
 * ~12s, per request, for a condition retrying cannot fix) and surface it as a
 * typed error the sync engine can pause a pair on.
 */
describe("RemoteClient maintenance handling", () => {
  it("rejects with MaintenanceError and is never retried", async () => {
    const client = new RemoteClient("https://api.dosya.dev", NULL_ENV);
    let calls = 0;
    (client as unknown as { fetchOnce: unknown }).fetchOnce = async () => {
      calls++;
      return {
        status: 503,
        headers: {},
        json: async () => ({ code: "surface_disabled", surface: "desktop", message: "brb" }),
        buffer: async () => Buffer.alloc(0),
      };
    };

    let caught: unknown;
    try {
      await client.getWorkspaceRegion("ws");
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(MaintenanceError);
    expect((caught as MaintenanceError).message).toBe("brb");
    expect((caught as MaintenanceError).surface).toBe("desktop");
    expect(calls).toBe(1);
  });

  it("falls back to a default message when the server sends none", async () => {
    const client = new RemoteClient("https://api.dosya.dev", NULL_ENV);
    (client as unknown as { fetchOnce: unknown }).fetchOnce = async () => ({
      status: 503,
      headers: {},
      json: async () => ({ code: "surface_disabled", surface: "web" }),
      buffer: async () => Buffer.alloc(0),
    });

    let caught: unknown;
    try {
      await client.getWorkspaceRegion("ws");
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(MaintenanceError);
    expect((caught as MaintenanceError).message).toBe("Paused for maintenance");
    expect((caught as MaintenanceError).surface).toBe("web");
  });
});
