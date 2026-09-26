import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CHUNK_BYTES,
  PROTOCOL_VERSION,
  chunkOffsets,
  decodeControl,
  encodeControl,
  ReceiveAssembler,
} from "./lan-protocol.ts";

// The wire protocol for LAN transfer. One data channel, one file at a time:
// a JSON control frame opens the file, binary frames carry its bytes in
// order (SCTP is ordered and reliable, so no sequence numbers are needed),
// and a closing control frame ends it. Keeping the framing this small is
// what lets the receiver be a plain state machine with no buffering of the
// whole file.

// control frames
test("round-trips a file-start frame", () => {
  const frame = { v: PROTOCOL_VERSION, t: "file-start" as const, id: "t1", name: "a.txt", size: 12, mime: "text/plain" };
  assert.deepEqual(decodeControl(encodeControl(frame)), frame);
});

test("rejects a frame from a different protocol version", () => {
  const wrong = JSON.stringify({ v: PROTOCOL_VERSION + 1, t: "file-start", id: "t1", name: "a.txt", size: 1 });
  assert.equal(decodeControl(wrong), null);
});

test("rejects malformed JSON rather than throwing at the peer", () => {
  assert.equal(decodeControl("{not json"), null);
});

test("rejects a frame with an unknown type", () => {
  assert.equal(decodeControl(JSON.stringify({ v: PROTOCOL_VERSION, t: "rm -rf", id: "t1" })), null);
});

// chunkOffsets
test("splits a file into chunk-sized slices covering every byte exactly once", () => {
  const size = CHUNK_BYTES * 2 + 5;
  const slices = [...chunkOffsets(size)];
  assert.deepEqual(slices, [
    { start: 0, end: CHUNK_BYTES },
    { start: CHUNK_BYTES, end: CHUNK_BYTES * 2 },
    { start: CHUNK_BYTES * 2, end: size },
  ]);
});

test("emits nothing for an empty file, which the control frames still bracket", () => {
  assert.deepEqual([...chunkOffsets(0)], []);
});

test("emits a single short slice for a file smaller than one chunk", () => {
  assert.deepEqual([...chunkOffsets(3)], [{ start: 0, end: 3 }]);
});

// ReceiveAssembler
const start = (id: string, name: string, size: number) =>
  encodeControl({ v: PROTOCOL_VERSION, t: "file-start", id, name, size, mime: "application/octet-stream" });

test("reports progress as chunks land and completes on the closing frame", async () => {
  const written: Uint8Array[] = [];
  const progress: number[] = [];
  const asm = new ReceiveAssembler({
    open: async () => ({ ok: true, id: "sink-1" }),
    write: async (_sink, bytes) => { written.push(bytes); },
    close: async () => ({ path: "/tmp/a.txt" }),
    abort: async () => {},
  });
  asm.onProgress = (_id, received) => progress.push(received);

  await asm.handleControl(start("t1", "a.txt", 6));
  await asm.handleBinary(new Uint8Array([1, 2, 3]));
  await asm.handleBinary(new Uint8Array([4, 5, 6]));
  const done = await asm.handleControl(encodeControl({ v: PROTOCOL_VERSION, t: "file-end", id: "t1" }));

  assert.deepEqual(written.map((b) => [...b]), [[1, 2, 3], [4, 5, 6]]);
  assert.deepEqual(progress, [3, 6]);
  assert.deepEqual(done, { kind: "complete", id: "t1", name: "a.txt", path: "/tmp/a.txt" });
});

test("refuses bytes that arrive with no open file", async () => {
  const asm = new ReceiveAssembler({
    open: async () => ({ ok: true, id: "sink-1" }),
    write: async () => { throw new Error("must not write"); },
    close: async () => ({ path: "/tmp/x" }),
    abort: async () => {},
  });
  await assert.rejects(() => asm.handleBinary(new Uint8Array([1])), /no file is open/i);
});

test("aborts the sink when the sender overruns the size it declared", async () => {
  // A peer that keeps sending past `size` is either broken or hostile, and
  // the receiver is writing to a path the user chose - so it stops at the
  // declared length instead of letting the file grow without bound.
  let aborted = false;
  const asm = new ReceiveAssembler({
    open: async () => ({ ok: true, id: "sink-1" }),
    write: async () => {},
    close: async () => ({ path: "/tmp/a.txt" }),
    abort: async () => { aborted = true; },
  });

  await asm.handleControl(start("t1", "a.txt", 2));
  await assert.rejects(() => asm.handleBinary(new Uint8Array([1, 2, 3])), /more bytes than declared/i);
  assert.equal(aborted, true);
});

test("abandons the partial file when the user declines the save dialog", async () => {
  const asm = new ReceiveAssembler({
    open: async () => ({ ok: false }),
    write: async () => { throw new Error("must not write"); },
    close: async () => ({ path: "/tmp/x" }),
    abort: async () => {},
  });

  const res = await asm.handleControl(start("t1", "a.txt", 4));

  assert.deepEqual(res, { kind: "declined", id: "t1", name: "a.txt" });
  // Bytes for a declined transfer are dropped, not written and not fatal:
  // the sender has already started streaming by the time the user clicks.
  await asm.handleBinary(new Uint8Array([1, 2, 3, 4]));
});

test("sanitises a name that tries to escape the chosen directory", async () => {
  const names: string[] = [];
  const asm = new ReceiveAssembler({
    open: async (name) => { names.push(name); return { ok: true, id: "sink-1" }; },
    write: async () => {},
    close: async () => ({ path: "/tmp/evil" }),
    abort: async () => {},
  });

  await asm.handleControl(start("t1", "../../../etc/passwd", 1));

  assert.deepEqual(names, ["passwd"]);
});
