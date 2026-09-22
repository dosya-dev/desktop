// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RemoteClient } from "./remote-client";
import { NULL_ENV } from "./env-provider";

describe("RemoteClient download sidecars", () => {
  let base: string;
  let target: string;
  let outside: string;
  let server: Server;
  let url: string;
  let range: string | undefined;
  let ifRange: string | undefined;

  beforeEach(async () => {
    base = await mkdtemp(join(tmpdir(), "dosya-download-sidecar-"));
    await mkdir(join(base, "root"));
    await mkdir(join(base, "outside"));
    target = join(base, "root", "file.txt");
    outside = join(base, "outside", "sentinel.txt");
    range = undefined;
    ifRange = undefined;
    server = createServer((req, res) => {
      range = req.headers.range;
      ifRange = req.headers["if-range"];
      if (range) {
        res.writeHead(206, { "Content-Range": "bytes 2-3/4", "Content-Length": "2", ETag: '"v1"' });
        res.end("CD");
      } else {
        res.writeHead(200, { "Content-Length": "4", ETag: '"v1"' });
        res.end("ABCD");
      }
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("missing loopback port");
    url = `http://127.0.0.1:${address.port}/file`;
  });

  afterEach(async () => {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(base, { recursive: true, force: true });
  });

  it("refuses a temporary download symlink without changing its referent", async () => {
    await writeFile(outside, "");
    await symlink(outside, `${target}.dosya-sync-tmp`);
    const client = new RemoteClient("https://api.example.test", NULL_ENV);
    await expect(client.downloadFromPresignedUrl(url, target, 4)).rejects.toThrow();
    expect(await readFile(outside, "utf8")).toBe("");
  });

  it("refuses a metadata symlink without changing its referent", async () => {
    await writeFile(outside, "sentinel");
    await symlink(outside, `${target}.dosya-sync-tmp.meta`);
    const client = new RemoteClient("https://api.example.test", NULL_ENV);
    await expect(client.downloadFromPresignedUrl(url, target, 4)).rejects.toThrow();
    expect(await readFile(outside, "utf8")).toBe("sentinel");
  });

  it("preserves a validated partial download and its If-Range request", async () => {
    await writeFile(`${target}.dosya-sync-tmp`, "AB");
    await writeFile(`${target}.dosya-sync-tmp.meta`, JSON.stringify({ etag: '"v1"' }));
    const client = new RemoteClient("https://api.example.test", NULL_ENV);
    expect(await client.downloadFromPresignedUrl(url, target, 4)).toBe(4);
    expect(await readFile(target, "utf8")).toBe("ABCD");
    expect(range).toBe("bytes=2-");
    expect(ifRange).toBe('"v1"');
  });
});
