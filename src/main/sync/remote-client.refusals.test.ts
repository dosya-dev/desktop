// @vitest-environment node
//
// Runs on vitest for the same reason remote-client.maintenance.test.ts does:
// remote-client.ts uses TS parameter properties and extensionless imports
// that Node's own test runner cannot load. See vitest.config.ts's include list.
import { describe, expect, it } from "vitest";
import { RemoteClient, RemoteRefusedError } from "./remote-client";
import { NULL_ENV } from "./env-provider";

type FakeResponse = { status: number; body: unknown };

/** A client whose transport answers each call from `answers`, in order, and records the request bodies. */
function clientAnswering(answers: FakeResponse[]) {
  const client = new RemoteClient("https://api.dosya.dev", NULL_ENV);
  const bodies: unknown[] = [];
  (client as unknown as { fetchOnce: unknown }).fetchOnce = async (_path: string, opts: { body?: string }) => {
    bodies.push(opts?.body ? JSON.parse(opts.body) : undefined);
    const next = answers.shift();
    if (!next) throw new Error("test: no answer left");
    return {
      status: next.status,
      headers: {},
      json: async () => next.body,
      buffer: async () => Buffer.alloc(0),
    };
  };
  return { client, bodies };
}

describe("RemoteClient refusals carry the server's status and message", () => {
  it("deleteFilesBatch throws on a 403 instead of reading it as success", async () => {
    const { client } = clientAnswering([{ status: 403, body: { ok: false, error: "No delete permission" } }]);

    let caught: unknown;
    try {
      await client.deleteFilesBatch("ws1", ["a", "b"]);
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(RemoteRefusedError);
    expect((caught as RemoteRefusedError).status).toBe(403);
    expect((caught as RemoteRefusedError).message).toBe("No delete permission");
  });

  it("deleteFilesBatch returns the server's deleted count and ids accumulated over chunks", async () => {
    const ids = Array.from({ length: 501 }, (_, i) => `f${i}`);
    const firstChunkIds = ids.slice(0, 499);
    const { client, bodies } = clientAnswering([
      { status: 200, body: { ok: true, deleted: 499, deleted_ids: firstChunkIds, folders_deleted: 0 } },
      { status: 200, body: { ok: true, deleted: 1, deleted_ids: ["f500"], folders_deleted: 0 } },
    ]);

    const result = await client.deleteFilesBatch("ws1", ids);

    expect(result.deleted).toBe(500);
    expect(result.deletedIds).toEqual([...firstChunkIds, "f500"]);
    expect(bodies.map((b) => (b as { file_ids: string[] }).file_ids.length)).toEqual([500, 1]);
  });

  it("deleteFilesBatch reports a 2xx shortfall as exactly the ids the server listed", async () => {
    const { client } = clientAnswering([
      { status: 200, body: { ok: true, deleted: 1, deleted_ids: ["a"], folders_deleted: 0 } },
    ]);

    const result = await client.deleteFilesBatch("ws1", ["a", "b"]);

    expect(result.deleted).toBe(1);
    expect(result.deletedIds).toEqual(["a"]);
  });

  it("deleteFilesBatch still reports a dead session as SESSION_EXPIRED", async () => {
    const { client } = clientAnswering([{ status: 401, body: { ok: false, error: "Not authenticated" } }]);
    await expect(client.deleteFilesBatch("ws1", ["a"])).rejects.toThrow("SESSION_EXPIRED");
  });

  it("deleteFile, moveFile and renameFile throw RemoteRefusedError on a 403", async () => {
    const { client } = clientAnswering([
      { status: 403, body: { error: "You don't have permission to delete this file" } },
      { status: 403, body: { error: "You don't have permission to move files" } },
      { status: 403, body: { error: "You don't have permission to rename files" } },
    ]);

    for (const call of [
      () => client.deleteFile("f1"),
      () => client.moveFile("f1", "folder"),
      () => client.renameFile("f1", "new.txt"),
    ]) {
      let caught: unknown;
      try { await call(); } catch (err) { caught = err; }
      expect(caught).toBeInstanceOf(RemoteRefusedError);
      expect((caught as RemoteRefusedError).status).toBe(403);
      expect((caught as RemoteRefusedError).message).toMatch(/permission/);
    }
  });

  it("deleteFile keeps treating 404 as already gone", async () => {
    const { client } = clientAnswering([{ status: 404, body: { error: "File not found" } }]);
    await expect(client.deleteFile("f1")).resolves.toBeUndefined();
  });
});
