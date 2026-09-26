import {
  CHUNK_BYTES,
  PROTOCOL_VERSION,
  ReceiveAssembler,
  chunkOffsets,
  encodeControl,
  type ReceiveSink,
} from "./lan-protocol";

/**
 * LAN Transfer: the peer connection and the signalling that sets it up.
 *
 * The server is only a letterbox. It holds a room for ten minutes so the two
 * machines can swap an SDP offer/answer and their ICE candidates; the file
 * itself never touches it - the bytes go straight between the two peers over
 * a WebRTC data channel.
 *
 * NO ICE SERVERS ARE CONFIGURED, deliberately. With none, Chromium offers
 * only host candidates, which on this network are mDNS names (`<uuid>.local`)
 * that resolve on the local segment and nowhere else. That is exactly the
 * promise the feature makes - "directly between devices on the same network"
 * - and it means no STUN/TURN infrastructure, no relay bills, and no path for
 * the bytes to leave the LAN. Two machines on different networks simply fail
 * to connect, which is the honest outcome rather than a silent relay.
 *
 * WebRTC is injected (`createPeerConnection`) so the handshake, the framing
 * and the routing can be tested without a browser.
 */

/** The room API in apps/api/src/pages/api/lan-transfer/. */
export interface SignalTransport {
  create(): Promise<{ roomCode: string; secret: string }>;
  join(roomCode: string): Promise<{ secret: string }>;
  post(roomCode: string, secret: string, type: SignalType, data: unknown): Promise<void>;
  poll(
    roomCode: string,
    secret: string,
    role: Role,
    iceCount: number,
  ): Promise<{ offer?: unknown; answer?: unknown; iceCandidates?: unknown[]; iceCount: number }>;
  cleanup(roomCode: string, secret: string): Promise<void>;
}

export type Role = "host" | "guest";
export type SignalType = "offer" | "answer" | "host-ice" | "guest-ice";
export type LanState = "waiting" | "connecting" | "connected" | "closed" | "failed";

export interface LanSessionOptions {
  transport: SignalTransport;
  sink: ReceiveSink;
  createPeerConnection?: () => RTCPeerConnection;
  pollIntervalMs?: number;
}

/** Stop pushing once this much is queued; resume when it drains. */
const HIGH_WATER_BYTES = 8 * 1024 * 1024;
const LOW_WATER_BYTES = 1 * 1024 * 1024;
const CHANNEL_LABEL = "dosya-lan";

const defaultPeerFactory = (): RTCPeerConnection =>
  new RTCPeerConnection({ iceServers: [] });

export class LanSession {
  readonly roomCode: string;
  readonly role: Role;

  onState?: (state: LanState) => void;
  onFileReceived?: (file: { name: string; path: string }) => void;
  onReceiveProgress?: (id: string, received: number, size: number) => void;
  onSendProgress?: (sent: number, total: number) => void;
  onError?: (message: string) => void;

  private readonly transport: SignalTransport;
  private readonly secret: string;
  private readonly peer: RTCPeerConnection;
  private readonly assembler: ReceiveAssembler;
  private readonly pollIntervalMs: number;
  private channel: RTCDataChannel | null = null;
  private channelReady: Promise<void>;
  private markChannelReady: () => void = () => {};
  private polling = true;
  private remoteDescriptionSet = false;
  private pendingIce: unknown[] = [];
  private iceCount = 0;
  private closed = false;

  private constructor(opts: LanSessionOptions, role: Role, roomCode: string, secret: string) {
    this.transport = opts.transport;
    this.role = role;
    this.roomCode = roomCode;
    this.secret = secret;
    this.pollIntervalMs = opts.pollIntervalMs ?? 1000;
    this.peer = (opts.createPeerConnection ?? defaultPeerFactory)();
    this.assembler = new ReceiveAssembler(opts.sink);
    this.assembler.onProgress = (id, received, size) => this.onReceiveProgress?.(id, received, size);
    this.channelReady = new Promise<void>((resolve) => { this.markChannelReady = resolve; });

    this.peer.onicecandidate = (e: { candidate: unknown }) => {
      if (!e.candidate) return; // null marks the end of gathering
      const type: SignalType = role === "host" ? "host-ice" : "guest-ice";
      void this.transport
        .post(this.roomCode, this.secret, type, e.candidate)
        .catch(() => { /* a lost candidate is survivable; others still arrive */ });
    };
    this.peer.onconnectionstatechange = () => {
      const state = this.peer.connectionState;
      if (state === "connected") this.onState?.("connected");
      else if (state === "failed") this.onState?.("failed");
      else if (state === "disconnected" || state === "closed") this.onState?.("closed");
    };
  }

  static async host(opts: LanSessionOptions): Promise<LanSession> {
    const { roomCode, secret } = await opts.transport.create();
    const session = new LanSession(opts, "host", roomCode, secret);
    // The host owns the channel: it is created before the offer so the
    // channel is part of the SDP the guest answers.
    session.attachChannel(session.peer.createDataChannel(CHANNEL_LABEL));
    const offer = await session.peer.createOffer();
    await session.peer.setLocalDescription(offer);
    await opts.transport.post(roomCode, secret, "offer", offer);
    session.onState?.("waiting");
    void session.pollLoop();
    return session;
  }

  static async join(opts: LanSessionOptions, roomCode: string): Promise<LanSession> {
    const { secret } = await opts.transport.join(roomCode);
    const session = new LanSession(opts, "guest", roomCode, secret);
    // The guest does not create a channel - it takes the host's.
    session.peer.ondatachannel = (e: { channel: RTCDataChannel }) => session.attachChannel(e.channel);
    session.onState?.("connecting");
    void session.pollLoop();
    return session;
  }

  // ── Signalling ────────────────────────────────────────────────────

  private async pollLoop(): Promise<void> {
    while (this.polling) {
      try {
        const res = await this.transport.poll(this.roomCode, this.secret, this.role, this.iceCount);
        if (!this.polling) break;

        if (this.role === "host" && res.answer && !this.remoteDescriptionSet) {
          await this.peer.setRemoteDescription(res.answer as RTCSessionDescriptionInit);
          this.remoteDescriptionSet = true;
          await this.flushPendingIce();
          this.onState?.("connecting");
        }

        if (this.role === "guest" && res.offer && !this.remoteDescriptionSet) {
          await this.peer.setRemoteDescription(res.offer as RTCSessionDescriptionInit);
          this.remoteDescriptionSet = true;
          const answer = await this.peer.createAnswer();
          await this.peer.setLocalDescription(answer);
          await this.transport.post(this.roomCode, this.secret, "answer", answer);
          await this.flushPendingIce();
        }

        if (res.iceCandidates?.length) {
          this.iceCount = res.iceCount;
          for (const candidate of res.iceCandidates) {
            // A candidate that arrives before the remote description cannot
            // be added yet; hold it rather than dropping it.
            if (!this.remoteDescriptionSet) this.pendingIce.push(candidate);
            else await this.peer.addIceCandidate(candidate as RTCIceCandidateInit).catch(() => {});
          }
        } else if (typeof res.iceCount === "number") {
          this.iceCount = res.iceCount;
        }
      } catch (err) {
        // The room expires after ten minutes; a poll failing then is normal
        // and only matters if we never connected.
        if (this.peer.connectionState !== "connected") {
          this.onError?.(err instanceof Error ? err.message : "Signalling failed");
        }
      }
      if (!this.polling) break;
      await new Promise((r) => setTimeout(r, this.pollIntervalMs));
    }
  }

  private async flushPendingIce(): Promise<void> {
    const queued = this.pendingIce;
    this.pendingIce = [];
    for (const c of queued) {
      await this.peer.addIceCandidate(c as RTCIceCandidateInit).catch(() => {});
    }
  }

  // ── Channel ───────────────────────────────────────────────────────

  private attachChannel(channel: RTCDataChannel): void {
    this.channel = channel;
    channel.binaryType = "arraybuffer";
    channel.bufferedAmountLowThreshold = LOW_WATER_BYTES;
    channel.onopen = () => { this.markChannelReady(); this.onState?.("connected"); };
    channel.onclose = () => { this.onState?.("closed"); void this.assembler.reset(); };
    channel.onerror = () => this.onError?.("The transfer connection failed");
    channel.onmessage = (e: MessageEvent) => { void this.handleMessage(e.data); };
  }

  private async handleMessage(data: unknown): Promise<void> {
    try {
      if (typeof data === "string") {
        const outcome = await this.assembler.handleControl(data);
        if (outcome.kind === "complete") this.onFileReceived?.({ name: outcome.name, path: outcome.path });
        else if (outcome.kind === "declined") this.onError?.(`"${outcome.name}" was not saved`);
        return;
      }
      const bytes =
        data instanceof ArrayBuffer ? new Uint8Array(data)
        : ArrayBuffer.isView(data) ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
        : null;
      if (!bytes) return;
      await this.assembler.handleBinary(bytes);
    } catch (err) {
      this.onError?.(err instanceof Error ? err.message : "Transfer failed");
    }
  }

  // ── Sending ───────────────────────────────────────────────────────

  async sendFile(file: File): Promise<void> {
    await this.channelReady;
    const channel = this.channel;
    if (!channel || channel.readyState !== "open") throw new Error("The other device is not connected");

    const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    channel.send(encodeControl({
      v: PROTOCOL_VERSION, t: "file-start", id, name: file.name, size: file.size, mime: file.type,
    }));

    let sent = 0;
    try {
      for (const { start, end } of chunkOffsets(file.size)) {
        await this.waitForDrain(channel);
        if (channel.readyState !== "open") throw new Error("The connection closed mid-transfer");
        const slice = await file.slice(start, end).arrayBuffer();
        channel.send(slice);
        sent += end - start;
        this.onSendProgress?.(sent, file.size);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : "Transfer failed";
      if (channel.readyState === "open") {
        channel.send(encodeControl({ v: PROTOCOL_VERSION, t: "error", id, message }));
      }
      throw err;
    }
    channel.send(encodeControl({ v: PROTOCOL_VERSION, t: "file-end", id }));
  }

  /**
   * Hold off while the channel's send buffer is above the high-water mark.
   * Without this, a multi-gigabyte file is pushed into memory as fast as the
   * disk can read it and the tab dies long before the network catches up.
   */
  private waitForDrain(channel: RTCDataChannel): Promise<void> {
    if (channel.bufferedAmount <= HIGH_WATER_BYTES) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const onLow = () => { channel.removeEventListener("bufferedamountlow", onLow); resolve(); };
      channel.addEventListener("bufferedamountlow", onLow);
    });
  }

  // ── Teardown ──────────────────────────────────────────────────────

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.polling = false;
    try { this.channel?.close(); } catch { /* already gone */ }
    try { this.peer.close(); } catch { /* already gone */ }
    await this.assembler.reset().catch(() => {});
    // Drop the room so its SDP/ICE (which name this machine on the LAN) does
    // not sit in the table for the rest of its ten minutes.
    await this.transport.cleanup(this.roomCode, this.secret).catch(() => {});
    this.onState?.("closed");
  }
}

export { CHUNK_BYTES };
