// apps/desktop/src/renderer/lib/upload-in-parts.test.ts
//
// The renderer's manual upload flows (Upload page, file browser drag-drop,
// "upload new version") used to send the whole file as ONE request body.
// Cloudflare refuses any body over 100 MB at the edge, before the API runs,
// so every large upload died with a bare "Network error". These tests pin
// the replacement: small files stay a single PUT, large files go through
// the server's resumable part API the same way the sync engine does.
//
// node --test resolves imports literally: the ".ts" extension is required.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  uploadFileInParts,
  PART_CONCURRENCY,
  PART_ATTEMPTS,
  type Transport,
  type InitResponse,
  type PutOptions,
} from "./upload-in-parts.ts";

type PutCall = { path: string; bytes: Uint8Array; headers: Record<string, string> };
type PostCall = { path: string; headers: Record<string, string> };

interface FakeOptions {
  init?: Partial<InitResponse>;
  /** Decide each PUT's outcome; default is a 200 `{ok:true}`. */
  onPut?: (call: PutCall, attempt: number) => Promise<{ status: number; data: unknown }> | { status: number; data: unknown };
  /** Awaited before each PUT resolves - lets a test hold parts in flight. */
  gate?: (call: PutCall) => Promise<void>;
}

function fakeTransport(opts: FakeOptions = {}) {
  const puts: PutCall[] = [];
  const posts: PostCall[] = [];
  const attempts = new Map<string, number>();
  const transport: Transport = {
    async init() {
      return {
        ok: true,
        session_id: "s1",
        upload_url: "/api/upload/s1",
        resumable: null,
        ...opts.init,
      } as InitResponse;
    },
    async put(p: PutOptions) {
      const bytes = new Uint8Array(await p.body.arrayBuffer());
      const call = { path: p.path, bytes, headers: p.headers ?? {} };
      puts.push(call);
      const n = (attempts.get(p.path) ?? 0) + 1;
      attempts.set(p.path, n);
      if (opts.gate) await opts.gate(call);
      p.onProgress?.(bytes.length);
      return opts.onPut ? await opts.onPut(call, n) : { status: 200, data: { ok: true, etag: `e${n}` } };
    },
    async post(path, headers) {
      posts.push({ path, headers: headers ?? {} });
      return { status: 200, data: { ok: true, file: { id: "f-complete", current_version: 2 } } };
    },
    async sleep() {},
  };
  return { transport, puts, posts };
}

function blobOf(size: number): Blob {
  const bytes = new Uint8Array(size);
  for (let i = 0; i < size; i++) bytes[i] = i % 251;
  return new Blob([bytes]);
}

const resumable10 = {
  resumable: {
    part_size: 4,
    total_parts: 3,
    part_upload_url: "/api/upload/s1/part",
    complete_url: "/api/upload/s1/complete",
    status_url: "/api/upload/s1/status",
  },
};

function request(file: Blob, extra: Partial<Parameters<typeof uploadFileInParts>[0]> = {}) {
  return {
    file,
    fileName: "big.bin",
    mimeType: "application/octet-stream",
    workspaceId: "ws1",
    folderId: null,
    lastModifiedMs: 1_700_000_000_000,
    ...extra,
  };
}

describe("uploadFileInParts", () => {
  it("sends a small file as one PUT to the session url", async () => {
    const { transport, puts, posts } = fakeTransport({
      onPut: () => ({ status: 201, data: { ok: true, file: { id: "f-single", current_version: 1 } } }),
    });
    const file = blobOf(10);

    const out = await uploadFileInParts(request(file), transport);

    assert.equal(puts.length, 1);
    assert.equal(puts[0].path, "/api/upload/s1");
    assert.equal(puts[0].bytes.length, 10);
    assert.deepEqual(posts, []);
    assert.equal(out.fileId, "f-single");
  });

  it("splits a large file into parts and completes the session", async () => {
    const { transport, puts, posts } = fakeTransport({ init: resumable10 });
    const file = blobOf(10);
    const whole = new Uint8Array(await file.arrayBuffer());

    const out = await uploadFileInParts(request(file), transport);

    assert.deepEqual(
      puts.map((p) => p.path).sort(),
      ["/api/upload/s1/part/1", "/api/upload/s1/part/2", "/api/upload/s1/part/3"],
    );
    const byPath = new Map(puts.map((p) => [p.path, p.bytes]));
    assert.deepEqual(byPath.get("/api/upload/s1/part/1"), whole.slice(0, 4));
    assert.deepEqual(byPath.get("/api/upload/s1/part/2"), whole.slice(4, 8));
    assert.deepEqual(byPath.get("/api/upload/s1/part/3"), whole.slice(8, 10));
    assert.equal(posts.length, 1);
    assert.equal(posts[0].path, "/api/upload/s1/complete");
    assert.equal(posts[0].headers["X-Dosya-Source-Mtime"], "1700000000");
    assert.equal(out.fileId, "f-complete");
  });

  it("sends the first part alone, then fans out no wider than PART_CONCURRENCY", async () => {
    const started: string[] = [];
    let inFlight = 0;
    let peak = 0;
    let firstDone = false;
    let startedAfterFirst = 0;
    const release: Array<() => void> = [];
    const { transport } = fakeTransport({
      init: { resumable: { ...resumable10.resumable, part_size: 1, total_parts: 10 } },
      gate: (call) => new Promise<void>((resolve) => {
        started.push(call.path);
        inFlight++;
        peak = Math.max(peak, inFlight);
        if (firstDone) startedAfterFirst++;
        else assert.equal(call.path, "/api/upload/s1/part/1", "no part may start before part 1 finished");
        release.push(() => {
          inFlight--;
          if (call.path.endsWith("/part/1")) firstDone = true;
          resolve();
        });
      }),
    });

    const done = uploadFileInParts(request(blobOf(10)), transport);
    // Drain: release whatever is gated, let the pool refill, repeat.
    while (started.length < 10 || release.length > 0) {
      await new Promise((r) => setTimeout(r, 0));
      const r = release.shift();
      if (r) r();
    }
    await done;

    assert.equal(started.length, 10);
    assert.equal(startedAfterFirst, 9);
    assert.ok(peak <= PART_CONCURRENCY, `peak ${peak} exceeded ${PART_CONCURRENCY}`);
  });

  it("retries a part that fails on the network and still completes", async () => {
    const { transport, puts, posts } = fakeTransport({
      init: resumable10,
      onPut: (call, attempt) => {
        if (call.path.endsWith("/part/2") && attempt === 1) throw new Error("Network error");
        return { status: 200, data: { ok: true } };
      },
    });

    await uploadFileInParts(request(blobOf(10)), transport);

    assert.equal(puts.filter((p) => p.path.endsWith("/part/2")).length, 2);
    assert.equal(posts.length, 1);
  });

  it("gives up on a part after PART_ATTEMPTS and never completes the session", async () => {
    const { transport, puts, posts } = fakeTransport({
      init: resumable10,
      onPut: (call) => {
        if (call.path.endsWith("/part/3")) return { status: 500, data: { ok: false, error: "R2 hiccup" } };
        return { status: 200, data: { ok: true } };
      },
    });

    await assert.rejects(uploadFileInParts(request(blobOf(10)), transport), /R2 hiccup/);

    assert.equal(puts.filter((p) => p.path.endsWith("/part/3")).length, PART_ATTEMPTS);
    assert.deepEqual(posts, []);
  });

  it("stops sending parts once the signal aborts", async () => {
    const controller = new AbortController();
    const { transport, puts, posts } = fakeTransport({
      init: resumable10,
      onPut: (call) => {
        if (call.path.endsWith("/part/1")) controller.abort();
        return { status: 200, data: { ok: true } };
      },
    });

    await assert.rejects(
      uploadFileInParts(request(blobOf(10), { signal: controller.signal }), transport),
      /Cancelled/,
    );

    assert.equal(puts.length, 1, "no further part after the abort");
    assert.deepEqual(posts, []);
  });

  it("reports cumulative progress that ends at the file size", async () => {
    const seen: number[] = [];
    const { transport } = fakeTransport({ init: resumable10 });

    await uploadFileInParts(request(blobOf(10), { onProgress: (b) => seen.push(b) }), transport);

    assert.ok(seen.length > 0);
    for (let i = 1; i < seen.length; i++) assert.ok(seen[i] >= seen[i - 1], "progress never goes backwards");
    assert.equal(seen[seen.length - 1], 10);
  });

  it("leaves folder_id out of a new-version init so the file stays in its folder", async () => {
    const inits: Record<string, unknown>[] = [];
    const { transport } = fakeTransport();
    transport.init = async (body) => { inits.push(body); return { ok: true, session_id: "s1", upload_url: "/api/upload/s1", resumable: null }; };

    await uploadFileInParts({ ...request(blobOf(3)), folderId: undefined, fileId: "f-old" }, transport);

    assert.equal(inits.length, 1);
    assert.equal(inits[0].file_id, "f-old");
    assert.ok(!("folder_id" in inits[0]), "folder_id must be absent, not null");
  });

  it("surfaces the server's init refusal as the error message", async () => {
    const { transport, puts } = fakeTransport({ init: { ok: false, error: "File exceeds maximum size of 1 GB" } });

    await assert.rejects(uploadFileInParts(request(blobOf(10)), transport), /File exceeds maximum size of 1 GB/);
    assert.deepEqual(puts, []);
  });

  it("turns a single-PUT HTTP failure into the server's message without retrying", async () => {
    const { transport, puts } = fakeTransport({
      onPut: () => ({ status: 413, data: { ok: false, error: "quota exceeded" } }),
    });

    await assert.rejects(uploadFileInParts(request(blobOf(10)), transport), /quota exceeded/);
    assert.equal(puts.length, 1);
  });
});
