// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RemoteClient } from "./remote-client";
import { NULL_ENV } from "./env-provider";

describe("presigned PUT refuses a file that changed underneath it", () => {
  let dir: string;
  let server: Server;
  let url: string;
  let onBody: (() => Promise<void>) | null = null;
  let replyEtag: string | undefined;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "dosya-put-guard-"));
    server = createServer((req, res) => {
      req.on("data", () => {});
      req.on("end", async () => {
        await onBody?.();
        res.statusCode = 200;
        if (replyEtag) res.setHeader("ETag", replyEtag);
        res.end();
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as { port: number }).port;
    url = `http://127.0.0.1:${port}/object`;
  });
  afterEach(async () => {
    onBody = null;
    replyEtag = undefined;
    await new Promise<void>((r) => server.close(() => r()));
    await rm(dir, { recursive: true, force: true });
  });

  it("rejects when the file was rewritten in place to the same size during the PUT", async () => {
    const file = join(dir, "same-size.txt");
    await writeFile(file, "AAAAAAAAAA");
    const before = await stat(file);
    // Rewrite to the same byte count while the server is still "receiving".
    onBody = async () => { await writeFile(file, "BBBBBBBBBB"); };
    const client = new RemoteClient("https://api.dosya.dev", NULL_ENV);
    await expect(
      client.uploadToPresignedUrl(url, file, before.size, "text/plain", { expect: { size: before.size, mtimeMs: before.mtimeMs } }),
    ).rejects.toThrow(/changed during upload/);
  });

  it("resolves for an untouched file", async () => {
    const file = join(dir, "still.txt");
    await writeFile(file, "AAAAAAAAAA");
    const before = await stat(file);
    const client = new RemoteClient("https://api.dosya.dev", NULL_ENV);
    const result = await client.uploadToPresignedUrl(url, file, before.size, "text/plain", { expect: { size: before.size, mtimeMs: before.mtimeMs } });
    expect(result.md5).toMatch(/^[0-9a-f]{32}$/);
  });

  it("returns the MD5 of what it sent and accepts a matching ETag", async () => {
    const file = join(dir, "hashed.txt");
    await writeFile(file, "hello hash");
    const before = await stat(file);
    const { createHash } = await import("node:crypto");
    const md5 = createHash("md5").update("hello hash").digest("hex");
    replyEtag = `"${md5}"`;
    const client = new RemoteClient("https://api.dosya.dev", NULL_ENV);
    const result = await client.uploadToPresignedUrl(url, file, before.size, "text/plain");
    expect(result).toEqual({ md5 });
  });

  it("rejects when the server's ETag disagrees with the bytes sent", async () => {
    const file = join(dir, "corrupt.txt");
    await writeFile(file, "hello hash");
    const before = await stat(file);
    replyEtag = `"${"f".repeat(32)}"`;
    const client = new RemoteClient("https://api.dosya.dev", NULL_ENV);
    await expect(client.uploadToPresignedUrl(url, file, before.size, "text/plain")).rejects.toThrow(/content mismatch/i);
  });
});
