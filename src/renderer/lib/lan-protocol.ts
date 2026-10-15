/**
 * The LAN Transfer wire protocol.
 *
 * One WebRTC data channel carries one file at a time: a JSON control frame
 * opens it, binary frames carry the bytes, a closing control frame ends it.
 * SCTP data channels are ordered and reliable by default, so the binary
 * frames need no sequence numbers and the receiver needs no reassembly
 * buffer - it can write straight through to disk as frames arrive.
 *
 * This module is deliberately free of WebRTC, React and Electron: it is the
 * part that decides what the bytes mean, so it stays testable without any of
 * them. `lan-peer.ts` owns the connection that carries it.
 */

export const PROTOCOL_VERSION = 1;

/**
 * 16 KiB per binary frame. SCTP fragments larger messages, and while modern
 * browsers handle up to 256 KiB, 16 KiB is the size every implementation
 * agrees on and it keeps the progress bar smooth on small files.
 */
export const CHUNK_BYTES = 16 * 1024;

/**
 * IPC round-trips to the main process have a fixed per-call cost that
 * swamps a 16 KiB payload: measuring the real renderer -> main -> disk path
 * showed ~109 MB/s at the wire chunk size (CHUNK_BYTES, one invoke per
 * chunk) versus ~650 MB/s once invokes carry 256 KiB
 * (desktop-audit/evidence/09-ipc-throughput.md). This is NOT the wire size -
 * CHUNK_BYTES above stays 16 KiB on the network - it is only how many wire
 * chunks `createWriteBatcher` below holds before handing them to IPC in one
 * call.
 */
export const IPC_WRITE_BYTES = 256 * 1024;

/** Stop a peer from opening a file whose declared size is absurd. */
export const MAX_FILE_BYTES = 64 * 1024 * 1024 * 1024; // 64 GiB

export type ControlFrame =
  | { v: number; t: "file-start"; id: string; name: string; size: number; mime?: string }
  | { v: number; t: "file-end"; id: string }
  | { v: number; t: "error"; id: string; message: string };

const CONTROL_TYPES = new Set(["file-start", "file-end", "error"]);

export function encodeControl(frame: ControlFrame): string {
  return JSON.stringify(frame);
}

/**
 * Parse a control frame from the peer. Returns null for anything that is not
 * a well-formed frame of this protocol version - the peer is another copy of
 * this app, but it is still the network, so nothing here throws and nothing
 * is trusted beyond its declared shape.
 */
export function decodeControl(text: string): ControlFrame | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const f = parsed as Record<string, unknown>;
  if (f.v !== PROTOCOL_VERSION) return null;
  if (typeof f.t !== "string" || !CONTROL_TYPES.has(f.t)) return null;
  if (typeof f.id !== "string" || f.id.length === 0 || f.id.length > 64) return null;

  if (f.t === "file-start") {
    if (typeof f.name !== "string" || f.name.length === 0 || f.name.length > 500) return null;
    if (typeof f.size !== "number" || !Number.isFinite(f.size) || f.size < 0 || f.size > MAX_FILE_BYTES) return null;
    if (f.mime !== undefined && typeof f.mime !== "string") return null;
    return { v: PROTOCOL_VERSION, t: "file-start", id: f.id, name: f.name, size: f.size, ...(f.mime === undefined ? {} : { mime: f.mime }) };
  }
  if (f.t === "file-end") return { v: PROTOCOL_VERSION, t: "file-end", id: f.id };
  if (typeof f.message !== "string") return null;
  return { v: PROTOCOL_VERSION, t: "error", id: f.id, message: f.message.slice(0, 500) };
}

/** The byte ranges a file of `size` is sent in, in order. */
export function* chunkOffsets(size: number): Generator<{ start: number; end: number }> {
  for (let start = 0; start < size; start += CHUNK_BYTES) {
    yield { start, end: Math.min(start + CHUNK_BYTES, size) };
  }
}

/** What `createWriteBatcher` hands back to its caller. */
export interface WriteBatcher {
  /** Queue bytes; flushes to `write` once the buffered total reaches `flushAt`. */
  push(bytes: Uint8Array): Promise<void>;
  /** Flush whatever is left under the threshold. MUST be called when the
   * caller is done pushing - skipping it silently drops the tail of every
   * file whose size is not a multiple of `flushAt`. */
  close(): Promise<void>;
  /** Drop whatever is buffered without writing it - for a transfer that is
   * being thrown away (abort), where the destination may already be gone. */
  discard(): void;
}

/**
 * Buffers writes until `flushAt` bytes have accumulated, then hands them to
 * `write` as one concatenated call. This is what lets a wire protocol keep a
 * small, network-appropriate chunk size (see CHUNK_BYTES above) while the
 * hand-off to IPC - which has its own fixed per-call cost - amortises that
 * cost over a much bigger buffer.
 *
 * Kept free of WebRTC/Electron, same as the rest of this module: it only
 * knows "accumulate, then call `write` with one buffer." `lan-transport.ts`
 * wires the real `write` to `window.electronAPI.lanRecvChunk`.
 */
export function createWriteBatcher(
  flushAt: number,
  write: (bytes: Uint8Array) => Promise<void>,
): WriteBatcher {
  let pending: Uint8Array[] = [];
  let pendingBytes = 0;
  /**
   * Set once a flush has failed. The batch it was carrying is gone - the
   * buffer is cleared before the await, because holding bytes whose file is
   * being abandoned buys nothing - so this batcher can no longer produce a
   * correct file and must never again behave as though it had.
   *
   * Without it, `close()` after a failed flush found an EMPTY buffer, had
   * nothing to do, and resolved: the receive path then reported the file as
   * received, with the failed batch missing from the middle of it. (The main
   * process destroys the sink on a write error too, so either layer alone
   * closes that hole; both do, because the consequence is a file the user is
   * told is complete.)
   */
  let failed: Error | null = null;

  function concat(): Uint8Array {
    if (pending.length === 1) return pending[0];
    const out = new Uint8Array(pendingBytes);
    let offset = 0;
    for (const chunk of pending) {
      out.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return out;
  }

  async function flushPending(): Promise<void> {
    if (failed) throw failed;
    if (pendingBytes === 0) return;
    const batch = concat();
    pending = [];
    pendingBytes = 0;
    try {
      await write(batch);
    } catch (err) {
      failed = err instanceof Error ? err : new Error(String(err));
      throw failed;
    }
  }

  return {
    async push(bytes: Uint8Array): Promise<void> {
      if (failed) throw failed;
      pending.push(bytes);
      pendingBytes += bytes.byteLength;
      if (pendingBytes >= flushAt) await flushPending();
    },
    async close(): Promise<void> {
      // Rejects rather than resolving on an empty buffer if a flush has
      // already failed - that silent resolve is what let a truncated file be
      // reported as received.
      await flushPending();
    },
    discard(): void {
      pending = [];
      pendingBytes = 0;
    },
  };
}

/**
 * Strip every directory component a peer might have put in the name. The
 * receiving side hands this to a save dialog, so "../../../etc/passwd" must
 * arrive as "passwd" - the user picks the directory, the sender never does.
 */
export function safeFileName(name: string): string {
  const base = name.split(/[/\\]/).pop() ?? "";
  const cleaned = base.replace(/^\.+$/, "").trim();
  return cleaned || "received-file";
}

/** Where received bytes go. The renderer implements this over IPC. */
export interface ReceiveSink {
  /** Ask the user where to put `name`. `ok:false` means they declined. */
  open(name: string, size: number): Promise<{ ok: boolean; id?: string }>;
  write(sinkId: string, bytes: Uint8Array): Promise<void>;
  close(sinkId: string): Promise<{ path: string }>;
  abort(sinkId: string): Promise<void>;
}

export type ReceiveOutcome =
  | { kind: "complete"; id: string; name: string; path: string }
  | { kind: "declined"; id: string; name: string }
  | { kind: "none" };

interface OpenFile {
  id: string;
  name: string;
  size: number;
  received: number;
  sinkId: string | null; // null once declined - bytes are dropped
}

/**
 * The receiving half: a state machine over the frames above, writing through
 * to a sink instead of holding the file in memory.
 */
export class ReceiveAssembler {
  private current: OpenFile | null = null;
  onProgress?: (id: string, received: number, size: number) => void;

  // Declared explicitly rather than as a constructor parameter property:
  // these tests run on node:test, which strips types without transforming
  // and rejects that syntax (see the note in vitest.config.ts).
  private readonly sink: ReceiveSink;

  constructor(sink: ReceiveSink) {
    this.sink = sink;
  }

  async handleControl(text: string): Promise<ReceiveOutcome> {
    const frame = decodeControl(text);
    if (!frame) return { kind: "none" };

    if (frame.t === "file-start") {
      // A second file-start while one is open means the peer lost track;
      // drop the partial rather than interleaving two files into one sink.
      if (this.current?.sinkId) await this.sink.abort(this.current.sinkId);
      const name = safeFileName(frame.name);
      const opened = await this.sink.open(name, frame.size);
      this.current = { id: frame.id, name, size: frame.size, received: 0, sinkId: opened.ok ? opened.id ?? null : null };
      return opened.ok ? { kind: "none" } : { kind: "declined", id: frame.id, name };
    }

    if (frame.t === "file-end") {
      const open = this.current;
      this.current = null;
      if (!open || open.id !== frame.id) return { kind: "none" };
      if (!open.sinkId) return { kind: "declined", id: open.id, name: open.name };
      const { path } = await this.sink.close(open.sinkId);
      return { kind: "complete", id: open.id, name: open.name, path };
    }

    // error: the sender gave up. Drop whatever is on disk so a partial file
    // is never left looking like a real one.
    const open = this.current;
    this.current = null;
    if (open?.sinkId) await this.sink.abort(open.sinkId);
    return { kind: "none" };
  }

  async handleBinary(bytes: Uint8Array): Promise<void> {
    const open = this.current;
    if (!open) throw new Error("LAN transfer: bytes arrived when no file is open");
    // Declined: the sender was already streaming when the user said no, so
    // its bytes keep arriving for a moment. Dropping them is the whole
    // handling - it is not an error on either side.
    if (!open.sinkId) return;

    if (open.received + bytes.byteLength > open.size) {
      const sinkId = open.sinkId;
      this.current = null;
      await this.sink.abort(sinkId);
      throw new Error("LAN transfer: peer sent more bytes than declared");
    }

    await this.sink.write(open.sinkId, bytes);
    open.received += bytes.byteLength;
    this.onProgress?.(open.id, open.received, open.size);
  }

  /** Drop any in-progress file, e.g. when the connection goes away. */
  async reset(): Promise<void> {
    const open = this.current;
    this.current = null;
    if (open?.sinkId) await this.sink.abort(open.sinkId);
  }
}
