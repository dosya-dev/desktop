import { api } from "@/lib/api-client";
import { createWriteBatcher, IPC_WRITE_BYTES, type ReceiveSink } from "./lan-protocol";
import type { Role, SignalTransport, SignalType } from "./lan-peer";

/**
 * The two adapters that connect LanSession to this app: the signalling room
 * on the API, and the destination on disk. Both are thin on purpose - the
 * logic they serve is in lan-peer.ts and lan-protocol.ts, where it can be
 * tested without a server or a filesystem.
 */

export const signalTransport: SignalTransport = {
  async create() {
    // NOTE the casing: this endpoint answers { roomCode, hostSecret }. The
    // page used to read `room_code` off it and render an empty code, which
    // is why "Create a room" produced a blank card and nobody could join.
    const res = await api.post<{ roomCode: string; hostSecret: string }>("/api/lan-transfer/create");
    return { roomCode: res.roomCode, secret: res.hostSecret };
  },

  async join(roomCode: string) {
    const res = await api.post<{ guestSecret: string }>("/api/lan-transfer/join", { roomCode });
    return { secret: res.guestSecret };
  },

  async post(roomCode: string, secret: string, type: SignalType, data: unknown) {
    await api.post("/api/lan-transfer/signal", { roomCode, secret, type, data });
  },

  async poll(roomCode: string, secret: string, role: Role, iceCount: number) {
    const params = new URLSearchParams({ room: roomCode, role, secret, iceCount: String(iceCount) });
    return api.get<{ offer?: unknown; answer?: unknown; iceCandidates?: unknown[]; iceCount: number }>(
      `/api/lan-transfer/signal?${params.toString()}`,
    );
  },

  async cleanup(roomCode: string, secret: string) {
    await api.post("/api/lan-transfer/cleanup", { roomCode, secret });
  },
};

/**
 * One IPC round-trip per 16 KiB wire chunk (CHUNK_BYTES in lan-protocol.ts)
 * costs almost as much as one per 256 KiB - the round-trip, not the bytes,
 * dominates at that size (desktop-audit/evidence/09-ipc-throughput.md). Each
 * open sink gets its own batcher so writes for a file are buffered to
 * IPC_WRITE_BYTES before `lanRecvChunk` is actually called; `close`/`abort`
 * below settle it.
 */
const writeBatchers = new Map<string, ReturnType<typeof createWriteBatcher>>();

function batcherFor(sinkId: string): ReturnType<typeof createWriteBatcher> {
  let batcher = writeBatchers.get(sinkId);
  if (!batcher) {
    batcher = createWriteBatcher(IPC_WRITE_BYTES, (bytes) => window.electronAPI.lanRecvChunk(sinkId, bytes));
    writeBatchers.set(sinkId, batcher);
  }
  return batcher;
}

/** Writes an incoming file through the main process (which owns the dialog). */
export const ipcSink: ReceiveSink = {
  open: (name, size) => window.electronAPI.lanRecvOpen(name, size),
  write: (sinkId, bytes) => batcherFor(sinkId).push(bytes),
  close: async (sinkId) => {
    const batcher = writeBatchers.get(sinkId);
    writeBatchers.delete(sinkId);
    // Flush whatever is under the threshold BEFORE closing the sink: the
    // main process closes the file handle on `lanRecvClose`, so a flush
    // after that would write to an already-closed sink and lose the tail
    // of every file whose size is not a multiple of IPC_WRITE_BYTES.
    if (batcher) await batcher.close();
    return window.electronAPI.lanRecvClose(sinkId);
  },
  abort: async (sinkId) => {
    const batcher = writeBatchers.get(sinkId);
    writeBatchers.delete(sinkId);
    // The transfer is being thrown away and the main process deletes the
    // partial file on abort, so the buffered bytes are discarded rather
    // than flushed - flushing here would write to a sink that is about to
    // be (or already is) destroyed.
    batcher?.discard();
    return window.electronAPI.lanRecvAbort(sinkId);
  },
};
