import { test } from "node:test";
import assert from "node:assert/strict";
import { CHUNK_BYTES, IPC_WRITE_BYTES, chunkOffsets, createWriteBatcher } from "./lan-protocol.ts";

// The IPC hand-off for LAN Transfer receive: one `lanRecvChunk` invoke per
// 16 KiB wire chunk (CHUNK_BYTES) measured at ~109 MB/s on the real
// renderer -> main -> disk path, because the round-trip cost dominates at
// that size; batching to IPC_WRITE_BYTES (256 KiB) before the invoke
// measured ~650 MB/s instead (desktop-audit/evidence/09-ipc-throughput.md).
// `createWriteBatcher` is the pure piece that does the batching - no
// Electron, no WebRTC, just "accumulate, then call `write` once."

test("does not flush before the threshold is reached", async () => {
  const writes: Uint8Array[] = [];
  const batcher = createWriteBatcher(10, async (b) => { writes.push(b); });

  await batcher.push(new Uint8Array([1, 2, 3]));
  await batcher.push(new Uint8Array([4, 5, 6]));

  assert.deepEqual(writes, []);
});

test("flushes one concatenated buffer once the threshold is reached", async () => {
  const writes: Uint8Array[] = [];
  const batcher = createWriteBatcher(6, async (b) => { writes.push(b); });

  await batcher.push(new Uint8Array([1, 2, 3]));
  await batcher.push(new Uint8Array([4, 5, 6])); // 6 total: hits the threshold

  assert.equal(writes.length, 1);
  assert.deepEqual([...writes[0]], [1, 2, 3, 4, 5, 6]);
});

test("starts a fresh buffer after a flush rather than re-sending old bytes", async () => {
  const writes: Uint8Array[] = [];
  const batcher = createWriteBatcher(4, async (b) => { writes.push(b); });

  await batcher.push(new Uint8Array([1, 2, 3, 4])); // flush #1
  await batcher.push(new Uint8Array([5, 6]));       // under threshold, held
  await batcher.close();                             // flush #2: the remainder

  assert.equal(writes.length, 2);
  assert.deepEqual([...writes[0]], [1, 2, 3, 4]);
  assert.deepEqual([...writes[1]], [5, 6]);
});

// The regression this whole task is about: forgetting to flush the
// remainder on close silently drops the tail of every file whose size is
// not an exact multiple of the threshold.
test("flushes the remainder on close even when under the threshold", async () => {
  const writes: Uint8Array[] = [];
  const batcher = createWriteBatcher(1024, async (b) => { writes.push(b); });

  await batcher.push(new Uint8Array([9, 9, 9])); // far under 1024
  await batcher.close();

  assert.equal(writes.length, 1);
  assert.deepEqual([...writes[0]], [9, 9, 9]);
});

test("close on an empty batcher writes nothing", async () => {
  const writes: Uint8Array[] = [];
  const batcher = createWriteBatcher(1024, async (b) => { writes.push(b); });

  await batcher.close();

  assert.deepEqual(writes, []);
});

test("discard drops the pending buffer without calling write", async () => {
  const writes: Uint8Array[] = [];
  const batcher = createWriteBatcher(1024, async (b) => { writes.push(b); });

  await batcher.push(new Uint8Array([1, 2, 3]));
  batcher.discard();
  await batcher.close(); // nothing left to flush

  assert.deepEqual(writes, []);
});

test("a single push already at or over the threshold flushes immediately", async () => {
  const writes: Uint8Array[] = [];
  const batcher = createWriteBatcher(4, async (b) => { writes.push(b); });

  await batcher.push(new Uint8Array([1, 2, 3, 4, 5, 6])); // one push, over threshold

  assert.equal(writes.length, 1);
  assert.deepEqual([...writes[0]], [1, 2, 3, 4, 5, 6]);
});

test("pushes are written in order and never reordered across a flush boundary", async () => {
  const writes: Uint8Array[] = [];
  const batcher = createWriteBatcher(8, async (b) => { writes.push(b); });

  for (let i = 0; i < 20; i++) await batcher.push(new Uint8Array([i]));
  await batcher.close();

  const all = writes.flatMap((b) => [...b]);
  assert.deepEqual(all, Array.from({ length: 20 }, (_, i) => i));
});

// The byte-identity test: a size that is not a multiple of IPC_WRITE_BYTES,
// fed through the ACTUAL wire chunk size (CHUNK_BYTES via chunkOffsets),
// must arrive byte-identical once the batcher's remainder is flushed on
// close. This is the exact composition lan-transport.ts's ipcSink wires up
// live: chunkOffsets slices what goes over the wire, createWriteBatcher
// batches the IPC hand-off on the receiving side.
test("a file sized off IPC_WRITE_BYTES arrives byte-identical after batching", async () => {
  const size = IPC_WRITE_BYTES * 3 + CHUNK_BYTES * 2 + 1234; // deliberately not a multiple
  assert.notEqual(size % IPC_WRITE_BYTES, 0, "test fixture must not be a clean multiple");

  const original = new Uint8Array(size);
  for (let i = 0; i < size; i++) original[i] = (i * 2654435761) & 0xff; // deterministic, non-trivial content

  const writes: Uint8Array[] = [];
  const batcher = createWriteBatcher(IPC_WRITE_BYTES, async (b) => { writes.push(b); });

  for (const { start, end } of chunkOffsets(size)) {
    await batcher.push(original.subarray(start, end));
  }
  await batcher.close(); // the regression to fear: skipping this loses the tail

  const received = new Uint8Array(size);
  let offset = 0;
  for (const w of writes) {
    received.set(w, offset);
    offset += w.byteLength;
  }

  assert.equal(offset, size, "every byte that was sent must have been written");
  assert.deepEqual([...received], [...original], "received bytes must match the sent bytes exactly, not just in length");
});

// Guards the "batched write cannot exceed the declared total" concern: the
// batcher only ever concatenates bytes it was handed, in the order it was
// handed them - it cannot manufacture or duplicate bytes across a flush, so
// a caller that already validates each push against a declared size (as
// ReceiveAssembler.handleBinary does before calling sink.write) stays safe
// under batching too.
test("never writes more bytes in total than were pushed", async () => {
  const pushed: number[] = [1, 2, 3, 4, 5, 6, 7];
  let totalWritten = 0;
  const batcher = createWriteBatcher(3, async (b) => { totalWritten += b.byteLength; });

  for (const n of pushed) await batcher.push(new Uint8Array([n]));
  await batcher.close();

  assert.equal(totalWritten, pushed.length);
});

// ── A failed flush must end the transfer ─────────────────────────────
//
// The buffer is cleared BEFORE the write is awaited, so a rejected write
// loses that batch - deliberately, since holding bytes whose file is being
// abandoned buys nothing. What must not happen is the batcher then behaving
// as if nothing went wrong: `close()` used to find an empty buffer, have
// nothing to do, and resolve, so the receive path reported a file as received
// with the failed batch missing out of the middle of it. Batching made that
// hole 16x bigger than it was per-chunk, which is what makes it this
// change's problem.

test("close() rejects after a failed flush instead of resolving on an empty buffer", async () => {
  let calls = 0;
  const batcher = createWriteBatcher(2, async () => {
    calls++;
    throw new Error("ENOSPC: no space left on device");
  });

  await assert.rejects(() => batcher.push(new Uint8Array([1, 2])), /ENOSPC/);
  assert.equal(calls, 1);

  // The buffer is empty now. Resolving here is exactly the bug.
  await assert.rejects(() => batcher.close(), /ENOSPC/);
  // And it must not have tried to write again.
  assert.equal(calls, 1);
});

test("push() rejects after a failed flush rather than accumulating a second file's worth", async () => {
  const batcher = createWriteBatcher(2, async () => {
    throw new Error("EIO");
  });
  await assert.rejects(() => batcher.push(new Uint8Array([1, 2])), /EIO/);
  // A sender that keeps streaming must not be silently accepted into a
  // batcher whose file is already lost.
  await assert.rejects(() => batcher.push(new Uint8Array([3])), /EIO/);
});

test("the failure is sticky, and reports the original error", async () => {
  let shouldFail = true;
  const batcher = createWriteBatcher(1, async () => {
    if (shouldFail) throw new Error("first failure");
  });
  await assert.rejects(() => batcher.push(new Uint8Array([1])), /first failure/);
  // Even once the underlying write would succeed again, this batcher's file
  // already has a hole in it: it must not recover and report success.
  shouldFail = false;
  await assert.rejects(() => batcher.push(new Uint8Array([2])), /first failure/);
  await assert.rejects(() => batcher.close(), /first failure/);
});
