import { api } from "@/lib/api-client";
import type { ReceiveSink } from "./lan-protocol";
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

/** Writes an incoming file through the main process (which owns the dialog). */
export const ipcSink: ReceiveSink = {
  open: (name, size) => window.electronAPI.lanRecvOpen(name, size),
  write: (sinkId, bytes) => window.electronAPI.lanRecvChunk(sinkId, bytes),
  close: (sinkId) => window.electronAPI.lanRecvClose(sinkId),
  abort: (sinkId) => window.electronAPI.lanRecvAbort(sinkId),
};
