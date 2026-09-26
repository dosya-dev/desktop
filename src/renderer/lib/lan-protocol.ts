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
