// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";
import { createHash } from "node:crypto";
import { mkdtemp, open, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RemoteClient } from "./remote-client";
import { NULL_ENV } from "./env-provider";

const body = Buffer.from("the quick brown fox jumps over the lazy dog, twice. ".repeat(50));
const md5 = createHash("md5").update(body).digest("hex");

describe("download content verification", () => {
  let dir: string;
  let server: Server;
  let url: string;
  let etag: string | undefined;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "dosya-dl-hash-"));
    server = createServer((req, res) => {
      const range = /^bytes=(\d+)-$/.exec(req.headers.range ?? "");
      if (etag) res.setHeader("ETag", etag);
      if (range && req.headers["if-range"] === etag) {
        const from = Number(range[1]);
        res.statusCode = 206;
        res.setHeader("Content-Range", `bytes ${from}-${body.length - 1}/${body.length}`);
        res.setHeader("Content-Length", String(body.length - from));
        res.end(body.subarray(from));
        return;
      }
      res.statusCode = 200;
      res.setHeader("Content-Length", String(body.length));
      res.end(body);
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    url = `http://127.0.0.1:${(server.address() as { port: number }).port}/obj`;
  });
  afterEach(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    await rm(dir, { recursive: true, force: true });
  });

  it("accepts a body whose MD5 matches the ETag", async () => {
    etag = `"${md5}"`;
    const target = join(dir, "ok.bin");
    const client = new RemoteClient("https://api.dosya.dev", NULL_ENV);
    await client.downloadFromPresignedUrl(url, target, body.length);
    expect(await readFile(target)).toEqual(body);
  });

  it("rejects and discards a body whose MD5 disagrees with the ETag", async () => {
    etag = `"${"0".repeat(32)}"`;
    const target = join(dir, "bad.bin");
    const client = new RemoteClient("https://api.dosya.dev", NULL_ENV);
    await expect(client.downloadFromPresignedUrl(url, target, body.length)).rejects.toThrow(/content mismatch/i);
    await expect(stat(target)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(`${target}.dosya-sync-tmp`)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("non-MD5 ETags are not compared", async () => {
    etag = `"${md5}-2"`;
    const target = join(dir, "multipart.bin");
    const client = new RemoteClient("https://api.dosya.dev", NULL_ENV);
    await client.downloadFromPresignedUrl(url, target, body.length);
    expect(await readFile(target)).toEqual(body);
  });

  it("resumed download hashes the prefix", async () => {
    etag = `"${md5}"`;
    const target = join(dir, "resume.bin");
    // A partial from an earlier attempt plus its validator sidecar.
    await writeFile(`${target}.dosya-sync-tmp`, body.subarray(0, 1000));
    await writeFile(`${target}.dosya-sync-tmp.meta`, JSON.stringify({ etag }));
    const client = new RemoteClient("https://api.dosya.dev", NULL_ENV);
    await client.downloadFromPresignedUrl(url, target, body.length);
    expect(await readFile(target)).toEqual(body);
  });

  it("fsyncs the temp file, and does so before renaming it into place", async () => {
    etag = undefined;
    const target = join(dir, "durable.bin");
    const probe = await open(join(dir, "probe"), "w");
    const proto = Object.getPrototypeOf(probe);
    await probe.close();
    const realSync = proto.sync;
    const client = new RemoteClient("https://api.dosya.dev", NULL_ENV);
    const tmpHandles: unknown[] = [];
    const realOpen = (client as any).openDownloadSidecar.bind(client);
    const openSpy = vi.spyOn(client as any, "openDownloadSidecar").mockImplementation(
      async (...args: unknown[]) => {
        const handle = await realOpen(...args);
        if (String(args[1]).endsWith(".dosya-sync-tmp")) tmpHandles.push(handle);
        return handle;
      },
    );
    // For each sync: was it on the temp file, and did the target already exist?
    const calls: { onTemp: boolean; targetExisted: boolean }[] = [];
    const sync = vi.spyOn(proto, "sync").mockImplementation(async function (this: unknown) {
      calls.push({
        onTemp: tmpHandles.includes(this),
        targetExisted: await stat(target).then(() => true, () => false),
      });
      return realSync.call(this);
    });
    try {
      await client.downloadFromPresignedUrl(url, target, body.length);
      const tempSyncs = calls.filter((c) => c.onTemp);
      expect(tempSyncs.length).toBe(1);
      expect(tempSyncs[0].targetExisted).toBe(false);
      // The parent-directory fsync is the engine's job, once per directory
      // per batch (a per-file directory sync cost ~10 ms a download).
      expect(calls.length).toBe(1);
    } finally {
      sync.mockRestore();
      openSpy.mockRestore();
    }
  });
});
