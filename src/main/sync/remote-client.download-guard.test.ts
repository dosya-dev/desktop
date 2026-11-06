// @vitest-environment node
//
// The REAL downloadFile / downloadFromPresignedUrl against a local HTTP
// server: when beforeReplace refuses, the target stays untouched, no temp or
// meta sidecar remains, the original error surfaces, and nothing is retried.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RemoteClient } from "./remote-client";
import { NULL_ENV } from "./env-provider";
import { LocalChangedDuringDownloadError } from "./download-guard";

const body = "server version v2";

describe("RemoteClient download refuses via beforeReplace", () => {
  let dir: string;
  let server: http.Server;
  let requests: number;
  let base: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "dosya-rc-guard-"));
    requests = 0;
    server = http.createServer((_req, res) => {
      requests++;
      res.writeHead(200, { "Content-Length": String(body.length), ETag: '"v2"' });
      res.end(body);
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterEach(async () => {
    await new Promise((r) => server.close(r));
    await rm(dir, { recursive: true, force: true });
  });

  function client() {
    const c = new RemoteClient(base, NULL_ENV);
    vi.spyOn(c as any, "getSessionCookie").mockResolvedValue("session=x");
    return c;
  }

  async function expectClean(target: string) {
    expect(await readFile(target, "utf8")).toBe("my edit");
    expect(await readdir(dir)).toEqual(["report.txt"]);
    expect(requests).toBe(1);
  }

  it("downloadFile: rejects with the guard error, cleans up, makes one request", async () => {
    const target = join(dir, "report.txt");
    await writeFile(target, "my edit");
    const err = new LocalChangedDuringDownloadError("report.txt");
    await expect(
      client().downloadFile("f1", target, body.length, undefined, undefined, async () => { throw err; }),
    ).rejects.toBe(err);
    await expectClean(target);
  });

  it("downloadFromPresignedUrl: rejects with the guard error and cleans up", async () => {
    const target = join(dir, "report.txt");
    await writeFile(target, "my edit");
    const err = new LocalChangedDuringDownloadError("report.txt");
    await expect(
      client().downloadFromPresignedUrl(`${base}/blob`, target, body.length, undefined, undefined, async () => { throw err; }),
    ).rejects.toBe(err);
    await expectClean(target);
  });
});
