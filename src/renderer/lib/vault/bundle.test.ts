import { describe, it, expect } from "vitest";
import * as client from "@dosya-dev/e2ee-client";
import { toHex } from "@dosya-dev/e2ee-core";

/**
 * The renderer builds against the VENDORED bundles (vendor/e2ee-*), not the
 * monorepo packages. This pins that the alias resolves and that the exports
 * the store relies on exist in the vendored copy - a stale re-vendor that
 * drops one would fail here, not on a user's first unlock.
 */
describe("vendored e2ee bundles", () => {
  it("exposes the engine entry points the store uses", () => {
    for (const name of [
      "createFetchApiClient", "createFetchChunkTransport", "setupIdentity", "unlock",
      "unlockWithRecoveryKey", "createWorkspace", "openWorkspace", "listFolder",
      "uploadFile", "downloadFile", "grantAccess", "revokeAccess", "listMembers",
    ]) {
      expect(typeof (client as Record<string, unknown>)[name], name).toBe("function");
    }
  });

  it("carries e2ee-core helpers", () => {
    expect(toHex(new Uint8Array([0xab, 0x12]))).toBe("ab12");
  });
});
