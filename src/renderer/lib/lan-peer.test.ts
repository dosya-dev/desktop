import { test, expect } from "vitest";
import { LanSession, type SignalTransport } from "./lan-peer";
import { CHUNK_BYTES, PROTOCOL_VERSION, decodeControl } from "./lan-protocol";

// @vitest-environment node
//
// The connection half. WebRTC itself is injected, so these run without a
// browser: what is under test is the handshake ORDER (who writes which
// signal, and when), the framing of a send, and the routing of what arrives.

// ── Fakes ───────────────────────────────────────────────────────────

class FakeChannel {
  readyState = "open";
  bufferedAmount = 0;
  bufferedAmountLowThreshold = 0;
  binaryType = "arraybuffer";
  sent: (string | ArrayBuffer)[] = [];
  onmessage: ((e: { data: string | ArrayBuffer }) => void) | null = null;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  private lowListeners: (() => void)[] = [];

  send(data: string | ArrayBuffer) {
    this.sent.push(data);
    if (typeof data !== "string") this.bufferedAmount += data.byteLength;
  }
  close() { this.readyState = "closed"; this.onclose?.(); }
  addEventListener(type: string, fn: () => void) { if (type === "bufferedamountlow") this.lowListeners.push(fn); }
  removeEventListener(type: string, fn: () => void) {
    if (type === "bufferedamountlow") this.lowListeners = this.lowListeners.filter((f) => f !== fn);
  }
  /** Pretend the network drained the buffer. */
  drain() { this.bufferedAmount = 0; for (const fn of [...this.lowListeners]) fn(); }
}

class FakePeer {
  connectionState = "new";
  localDescription: unknown = null;
  remoteDescription: unknown = null;
  addedIce: unknown[] = [];
  channels: FakeChannel[] = [];
  onicecandidate: ((e: { candidate: unknown }) => void) | null = null;
  ondatachannel: ((e: { channel: FakeChannel }) => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;

  createDataChannel(_label: string) { const c = new FakeChannel(); this.channels.push(c); return c; }
  async createOffer() { return { type: "offer", sdp: "OFFER-SDP" }; }
  async createAnswer() { return { type: "answer", sdp: "ANSWER-SDP" }; }
  async setLocalDescription(d: unknown) { this.localDescription = d; }
  async setRemoteDescription(d: unknown) { this.remoteDescription = d; }
  async addIceCandidate(c: unknown) { this.addedIce.push(c); }
  close() { this.connectionState = "closed"; }
}

function fakeTransport(overrides: Partial<SignalTransport> = {}) {
  const posted: { type: string; data: unknown }[] = [];
  const base: SignalTransport = {
    create: async () => ({ roomCode: "482917", secret: "host-secret" }),
    join: async () => ({ secret: "guest-secret" }),
    post: async (_room, _secret, type, data) => { posted.push({ type, data }); },
    poll: async () => ({ iceCount: 0 }),
    cleanup: async () => {},
    ...overrides,
  };
  return { transport: base, posted };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

// ── Handshake ───────────────────────────────────────────────────────

test("hosting creates a room and publishes an offer under the host role", async () => {
  const peer = new FakePeer();
  const { transport, posted } = fakeTransport();
  const session = await LanSession.host({
    transport,
    createPeerConnection: () => peer as unknown as RTCPeerConnection,
    sink: stubSink(),
  });

  expect(session.roomCode).toBe("482917");
  // The offer must be published before anyone can answer it.
  expect(posted.map((p) => p.type)).toEqual(["offer"]);
  expect(peer.localDescription).toEqual({ type: "offer", sdp: "OFFER-SDP" });
  // The host opens the channel; the guest receives it via ondatachannel.
  expect(peer.channels.length).toBe(1);
  await session.close();
});

test("the host applies the guest's answer and trickled candidates", async () => {
  const peer = new FakePeer();
  let polls = 0;
  const { transport } = fakeTransport({
    poll: async () => {
      polls++;
      if (polls === 1) return { answer: { type: "answer", sdp: "ANSWER-SDP" }, iceCount: 0 };
      if (polls === 2) return { iceCandidates: [{ candidate: "cand-1" }], iceCount: 1 };
      return { iceCount: 1 };
    },
  });
  const session = await LanSession.host({
    transport,
    createPeerConnection: () => peer as unknown as RTCPeerConnection,
    sink: stubSink(),
    pollIntervalMs: 1,
  });

  await waitFor(() => peer.addedIce.length === 1);

  expect(peer.remoteDescription).toEqual({ type: "answer", sdp: "ANSWER-SDP" });
  expect(peer.addedIce).toEqual([{ candidate: "cand-1" }]);
  await session.close();
});

test("joining answers the offer it polled, under the guest role", async () => {
  const peer = new FakePeer();
  const { transport, posted } = fakeTransport({
    poll: async () => ({ offer: { type: "offer", sdp: "OFFER-SDP" }, iceCount: 0 }),
  });
  const session = await LanSession.join({
    transport,
    createPeerConnection: () => peer as unknown as RTCPeerConnection,
    sink: stubSink(),
    pollIntervalMs: 1,
  }, "482917");

  await waitFor(() => posted.some((p) => p.type === "answer"));

  expect(peer.remoteDescription).toEqual({ type: "offer", sdp: "OFFER-SDP" });
  expect(peer.localDescription).toEqual({ type: "answer", sdp: "ANSWER-SDP" });
  // A guest must never publish an offer - the API rejects it by role, and
  // publishing one would overwrite the host's.
  expect(posted.some((p) => p.type === "offer")).toBe(false);
  await session.close();
});

test("local ICE candidates are published under the sending peer's own role", async () => {
  const peer = new FakePeer();
  const { transport, posted } = fakeTransport();
  const session = await LanSession.host({
    transport,
    createPeerConnection: () => peer as unknown as RTCPeerConnection,
    sink: stubSink(),
  });

  peer.onicecandidate?.({ candidate: { candidate: "host-cand" } });
  await flush();

  expect(posted.filter((p) => p.type === "host-ice").map((p) => p.data)).toEqual([{ candidate: "host-cand" }]);
  await session.close();
});

// ── Sending ─────────────────────────────────────────────────────────

test("sending a file brackets its chunks with control frames", async () => {
  const peer = new FakePeer();
  const { transport } = fakeTransport();
  const session = await LanSession.host({
    transport,
    createPeerConnection: () => peer as unknown as RTCPeerConnection,
    sink: stubSink(),
  });
  const channel = peer.channels[0];
  channel.onopen?.();

  await session.sendFile(fileOf("notes.txt", CHUNK_BYTES + 10));

  const frames = channel.sent;
  const first = decodeControl(frames[0] as string);
  expect({ t: first?.t, name: (first as { name: string }).name, size: (first as { size: number }).size }).toEqual({ t: "file-start", name: "notes.txt", size: CHUNK_BYTES + 10 },);
  expect((frames[1] as ArrayBuffer).byteLength).toBe(CHUNK_BYTES);
  expect((frames[2] as ArrayBuffer).byteLength).toBe(10);
  expect(decodeControl(frames[3] as string)?.t).toBe("file-end");
  await session.close();
});

test("a send waits for the buffer to drain instead of flooding the channel", async () => {
  const peer = new FakePeer();
  const { transport } = fakeTransport();
  const session = await LanSession.host({
    transport,
    createPeerConnection: () => peer as unknown as RTCPeerConnection,
    sink: stubSink(),
  });
  const channel = peer.channels[0];
  channel.onopen?.();
  // Wedge the buffer above the high-water mark before the send starts.
  channel.bufferedAmount = 64 * 1024 * 1024;

  let settled = false;
  const sending = session.sendFile(fileOf("big.bin", CHUNK_BYTES * 3)).then(() => { settled = true; });
  await flush();
  expect(settled).toBe(false, "must not push the whole file into a full buffer");

  channel.drain();
  await sending;
  expect(settled).toBe(true);
  await session.close();
});

// ── Receiving ───────────────────────────────────────────────────────

test("an incoming file is written through the sink and reported once complete", async () => {
  const peer = new FakePeer();
  const { transport } = fakeTransport();
  const written: number[] = [];
  const received: { name: string; path: string }[] = [];
  const session = await LanSession.host({
    transport,
    createPeerConnection: () => peer as unknown as RTCPeerConnection,
    sink: {
      open: async () => ({ ok: true, id: "sink-1" }),
      write: async (_id, bytes) => { written.push(...bytes); },
      close: async () => ({ path: "/Users/me/Downloads/in.txt" }),
      abort: async () => {},
    },
  });
  session.onFileReceived = (f) => received.push(f);
  const channel = peer.channels[0];
  channel.onopen?.();

  channel.onmessage?.({ data: JSON.stringify({ v: PROTOCOL_VERSION, t: "file-start", id: "t1", name: "in.txt", size: 3 }) });
  await flush();
  channel.onmessage?.({ data: new Uint8Array([7, 8, 9]).buffer });
  await flush();
  channel.onmessage?.({ data: JSON.stringify({ v: PROTOCOL_VERSION, t: "file-end", id: "t1" }) });
  await waitFor(() => received.length === 1);

  expect(written).toEqual([7, 8, 9]);
  expect(received).toEqual([{ name: "in.txt", path: "/Users/me/Downloads/in.txt" }]);
  await session.close();
});

// ── Helpers ─────────────────────────────────────────────────────────

function stubSink() {
  return {
    open: async () => ({ ok: true, id: "sink-1" }),
    write: async () => {},
    close: async () => ({ path: "/tmp/x" }),
    abort: async () => {},
  };
}

function fileOf(name: string, size: number): File {
  const bytes = new Uint8Array(size);
  for (let i = 0; i < size; i++) bytes[i] = i % 256;
  return new File([bytes], name, { type: "application/octet-stream" });
}

async function waitFor(pred: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for condition");
    await new Promise((r) => setTimeout(r, 2));
  }
}
