// @vitest-environment node
//
// A snapshot whose paging stopped early (no usable cursor, page cap) is a
// partial list. Treating it as complete makes every file that did not arrive
// look deleted on the server, and the engine moves the local copies to the
// trash. The client must flag it, and the poller must refuse to hand a
// truncated FULL snapshot to the reconciler.
import { describe, expect, it } from "vitest";
import { RemoteClient } from "./remote-client";
import { RemotePoller } from "./remote-poller";
import { NULL_ENV } from "./env-provider";
import type { SyncPair } from "./types";

const page = (files: unknown[], hasMore: boolean, nextCursor: string | null) => ({
  status: 200, headers: {},
  json: async () => ({ ok: true, files, folders: [], hasMore, nextCursor, deleted: { files: [], folders: [] } }),
  buffer: async () => Buffer.alloc(0),
});

describe("truncated snapshots", () => {
  it("the client reports truncated when the server claims more pages but gives no cursor", async () => {
    const client = new RemoteClient("https://api.dosya.dev", NULL_ENV);
    (client as any).fetchOnce = async () => page([{ id: "f1", name: "a.txt", size_bytes: 1, mime_type: "text/plain", extension: "txt", region: "auto", folder_id: null, updated_at: 1, current_version: 1 }], true, null);
    (client as any).getSessionCookie = async () => "s=1";
    const snap = await client.fetchSnapshotFast("ws", null);
    expect(snap?.truncated).toBe(true);
    expect(snap?.files).toHaveLength(1);
  });

  it("the poller refuses a truncated full snapshot instead of returning a partial tree", async () => {
    const pair: SyncPair = {
      id: "pair", workspaceId: "ws", workspaceName: "W", remoteFolderId: null, remoteFolderName: "Root",
      localPath: "/tmp/x", selectiveFolders: [], excludedPatterns: [], region: "auto", pollIntervalMs: 60_000,
      syncMode: "two-way", conflictStrategy: "keep-both", enabled: true, createdAt: 1,
    } as SyncPair;
    const client: any = {
      fetchSnapshotFast: async () => ({ files: [], folders: [], deleted: { files: [], folders: [] }, truncated: true }),
      rateBudget: { remaining: Infinity, resetAt: 0 },
    };
    const poller = new RemotePoller(client, pair);
    await expect(poller.fetchSnapshot()).rejects.toThrow(/incomplete/i);
  });
});
