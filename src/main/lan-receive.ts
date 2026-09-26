import { app, dialog } from "electron";
import { open as fsOpen, unlink, type FileHandle } from "fs/promises";
import { basename, join } from "path";
import { randomUUID } from "crypto";
import { longPath } from "./sync/paths";

/**
 * Where a file arriving over LAN Transfer is written.
 *
 * The renderer holds the WebRTC channel but never the destination: it asks to
 * open a file BY NAME, this process puts a save dialog in front of the user,
 * and the handle stays here. So a peer on the network cannot choose where its
 * bytes land, cannot name a path at all, and cannot write anywhere the user
 * did not pick in a dialog. The name it suggests is reduced to its basename
 * first, so "../../../.ssh/authorized_keys" arrives as a suggested filename
 * and nothing more.
 *
 * Bytes are appended as they arrive rather than buffered: a LAN transfer is
 * as large as the sender's disk, and holding it in the renderer's heap first
 * would cap the feature at whatever Chromium allows.
 */

/** Refuse a peer that declares (or streams) something implausible. */
const MAX_FILE_BYTES = 64 * 1024 * 1024 * 1024; // 64 GiB
/** One dialog at a time is the UX; a few handles is the safety limit. */
const MAX_OPEN_SINKS = 4;

interface Sink {
  handle: FileHandle;
  path: string;
  written: number;
  limit: number;
}

const sinks = new Map<string, Sink>();

export interface LanOpenResult {
  ok: boolean;
  id?: string;
}

export async function openSink(name: unknown, size: unknown): Promise<LanOpenResult> {
  if (typeof name !== "string" || name.length === 0 || name.length > 500) {
    throw new Error("Invalid file name");
  }
  const declared = typeof size === "number" && Number.isFinite(size) && size >= 0 ? size : 0;
  if (declared > MAX_FILE_BYTES) throw new Error("File too large");
  if (sinks.size >= MAX_OPEN_SINKS) throw new Error("Too many transfers in progress");

  // Reduce to a leaf name, then strip anything that could still steer a path.
  const safeName = basename(name).replace(/[/\\]/g, "_").replace(/^\.+/, "") || "received-file";

  const { canceled, filePath } = await dialog.showSaveDialog({
    title: "Save file from the other device",
    defaultPath: join(app.getPath("downloads"), safeName),
  });
  if (canceled || !filePath) return { ok: false };

  const handle = await fsOpen(longPath(filePath), "w");
  const id = randomUUID();
  // The limit is the declared size where there is one: a sender that keeps
  // streaming past what it announced is stopped by the write path too, not
  // only by the renderer's own accounting.
  sinks.set(id, { handle, path: filePath, written: 0, limit: declared || MAX_FILE_BYTES });
  return { ok: true, id };
}

export async function writeSink(id: unknown, bytes: unknown): Promise<void> {
  const sink = requireSink(id);
  const buf =
    bytes instanceof Uint8Array ? bytes
    : bytes instanceof ArrayBuffer ? new Uint8Array(bytes)
    : null;
  if (!buf) throw new Error("Invalid chunk");
  if (sink.written + buf.byteLength > sink.limit) {
    await destroySink(id as string, true);
    throw new Error("Transfer exceeded the size the sender declared");
  }
  await sink.handle.write(buf);
  sink.written += buf.byteLength;
}

export async function closeSink(id: unknown): Promise<{ path: string }> {
  const sink = requireSink(id);
  await sink.handle.close();
  sinks.delete(id as string);
  return { path: sink.path };
}

export async function abortSink(id: unknown): Promise<void> {
  if (typeof id !== "string" || !sinks.has(id)) return; // already gone
  await destroySink(id, true);
}

/** Close every open sink and remove the partial files - used at shutdown. */
export async function abortAllSinks(): Promise<void> {
  for (const id of [...sinks.keys()]) await destroySink(id, true);
}

function requireSink(id: unknown): Sink {
  if (typeof id !== "string") throw new Error("Invalid transfer id");
  const sink = sinks.get(id);
  if (!sink) throw new Error("No such transfer");
  return sink;
}

async function destroySink(id: string, removeFile: boolean): Promise<void> {
  const sink = sinks.get(id);
  if (!sink) return;
  sinks.delete(id);
  try { await sink.handle.close(); } catch { /* already closed */ }
  // A half-written file must not be left looking like a real one.
  if (removeFile) { try { await unlink(longPath(sink.path)); } catch { /* nothing to remove */ } }
}
