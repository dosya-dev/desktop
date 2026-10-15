import { test, expect } from "vitest";
import { ipcSink } from "./lan-transport";
import { IPC_WRITE_BYTES } from "./lan-protocol";

/**
 * `ipcSink` (not just the pure `createWriteBatcher` it wires up) - the
 * close/abort ORDERING is the thing at risk: "flush then close" silently
 * becoming "close then flush" would lose the tail of every file, and
 * nothing short of exercising the real `ipcSink` against a stubbed
 * `window.electronAPI` would catch that. Runs under the default jsdom
 * environment (lan-peer.test.ts opts out, into a node environment, via its
 * own file-level directive comment, because it never touches `window`),
 * because this is the one lan-* suite that actually needs `window` to
 * exist, to stand in for the preload bridge.
 */

type RecordedCall = "lanRecvChunk" | "lanRecvClose" | "lanRecvAbort";

function stubElectronAPI() {
  const calls: RecordedCall[] = [];
  const chunks: Uint8Array[] = [];

  window.electronAPI = {
    lanRecvOpen: async () => ({ ok: true, id: "sink-1" }),
    lanRecvChunk: async (_id: string, bytes: Uint8Array) => {
      calls.push("lanRecvChunk");
      chunks.push(bytes);
    },
    lanRecvClose: async (_id: string) => {
      calls.push("lanRecvClose");
      return { path: "/tmp/x" };
    },
    lanRecvAbort: async (_id: string) => {
      calls.push("lanRecvAbort");
    },
  } as unknown as Window["electronAPI"];

  return { calls, chunks };
}

/** Deterministic, non-repeating-enough-to-catch-reordering content. */
function patterned(size: number, seed: number): Uint8Array {
  const bytes = new Uint8Array(size);
  for (let i = 0; i < size; i++) bytes[i] = (i + seed) & 0xff;
  return bytes;
}

function concatAll(arrays: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(arrays.reduce((n, a) => n + a.byteLength, 0));
  let offset = 0;
  for (const a of arrays) {
    out.set(a, offset);
    offset += a.byteLength;
  }
  return out;
}

/**
 * A plain loop rather than `expect([...a]).toEqual([...b])`: spreading a
 * six-figure-length Uint8Array into a plain array and deep-comparing it
 * element by element is slow enough under load to blow past the default
 * test timeout, for no better a check than this loop already gives.
 */
function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  for (let i = 0; i < a.byteLength; i++) if (a[i] !== b[i]) return false;
  return true;
}

test("close flushes the pending remainder BEFORE lanRecvClose, byte-identical to what was pushed", async () => {
  const { calls, chunks } = stubElectronAPI();
  const sinkId = "sink-close-1";
  const pushed = patterned(1234, 7); // well under IPC_WRITE_BYTES, so this is the "remainder"

  await ipcSink.write(sinkId, pushed);
  await ipcSink.close(sinkId);

  // ORDER matters: the flush must be recorded before the close.
  expect(calls).toEqual(["lanRecvChunk", "lanRecvClose"]);
  expect(chunks.length).toBe(1);
  expect([...chunks[0]]).toEqual([...pushed]);
});

test("abort discards the pending remainder without EVER calling lanRecvChunk", async () => {
  const { calls } = stubElectronAPI();
  const sinkId = "sink-abort-1";

  await ipcSink.write(sinkId, patterned(500, 3)); // held under threshold
  await ipcSink.abort(sinkId);

  // No flush at all - a flush here would write to a sink the main process
  // is about to destroy.
  expect(calls).toEqual(["lanRecvAbort"]);
});

test("writes that cross IPC_WRITE_BYTES flush in order, with no byte reordered across flush boundaries", async () => {
  const { calls, chunks } = stubElectronAPI();
  const sinkId = "sink-order-1";

  const pushes = [
    patterned(200_000, 0),
    patterned(100_000, 1), // 300,000 total: crosses IPC_WRITE_BYTES (262,144) -> flush #1
    patterned(200_000, 2),
    patterned(100_000, 3), // another 300,000: crosses again -> flush #2
    patterned(50, 4), // remainder, held until close
  ];
  for (const p of pushes) await ipcSink.write(sinkId, p);
  await ipcSink.close(sinkId);

  // Three flushes (two threshold crossings + the close remainder), then the
  // close itself, all in that order.
  expect(calls).toEqual(["lanRecvChunk", "lanRecvChunk", "lanRecvChunk", "lanRecvClose"]);

  const reassembled = concatAll(chunks);
  const expected = concatAll(pushes);
  expect(sameBytes(reassembled, expected)).toBe(true);
});

test("a second close for the same sink id is harmless: no extra flush, no throw", async () => {
  const { calls } = stubElectronAPI();
  const sinkId = "sink-double-close-1";

  await ipcSink.write(sinkId, patterned(10, 1));
  await ipcSink.close(sinkId); // flush the remainder, then close
  await ipcSink.close(sinkId); // the batcher is already gone; must not flush or throw

  expect(calls).toEqual(["lanRecvChunk", "lanRecvClose", "lanRecvClose"]);
});
