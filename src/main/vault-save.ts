import { open as fsOpen, unlink, type FileHandle } from "fs/promises";
import { basename, join } from "path";
import { randomUUID } from "crypto";
import { createRequire } from "node:module";
import { longPath } from "./sync/paths";

/**
 * Where a file decrypted by the Vault is written.
 *
 * The renderer does the decrypting but never sees a path. It asks by NAME,
 * this process puts a save dialog in front of the user, and the path the user
 * picked is the only place bytes go. The name is untrusted - it came from a
 * Space another member may have written - so it is reduced to a leaf before it
 * can even become the dialog's suggestion. Same discipline as lan-receive.ts.
 *
 * `deps` carries the Electron pieces so this can be unit tested off Electron.
 */

/** A leaf file name safe to suggest in a dialog. Never empty, never dot-only, never a path. */
export function safeVaultFileName(name: unknown): string {
  if (typeof name !== "string") return "vault-file";
  // basename() understands the host separator only; neutralise the Windows
  // separator and drive colon first so "C:\x" cannot survive as a path anywhere.
  const leaf = basename(name.replace(/[\\:]/g, "_")).replace(/[/\\]/g, "_").replace(/^\.+/, "");
  const trimmed = leaf.slice(0, 255);
  return trimmed && trimmed !== "." && trimmed !== ".." ? trimmed : "vault-file";
}

/**
 * The incremental sink (DSK-010).
 *
 * This replaces a whole-buffer `vault:save-bytes` channel that took the
 * ENTIRE plaintext: the renderer held it in its heap, the structured clone
 * handed this process a second copy, and both stayed alive for as long as the
 * save dialog was on screen - twice the file across two processes. That
 * channel is gone rather than merely unused, so the cost cannot come back.
 *
 * It is the same shape as lan-receive.ts's sink (read that one first; this
 * deliberately does not invent a second idiom): the renderer opens a
 * destination BY NAME, the
 * dialog and the path never leave this process, and each decrypted chunk is
 * appended as it is produced. Neither process ever holds the whole file.
 *
 * Chunks are appended, so ORDER is the file's correctness. e2ee-core's
 * `PlainChunkSink` is documented to be called in manifest order, and the
 * index a caller passes is checked against the number of chunks already
 * written - a future concurrent implementation that interleaves two chunks
 * is refused loudly instead of writing a corrupt file.
 */

/** One dialog at a time is the UX; a few handles is the safety limit (same as lan-receive). */
const MAX_OPEN_VAULT_SINKS = 4;
/**
 * One decrypted chunk. e2ee-core caps a plaintext chunk at
 * CHUNK_MAX_PLAINTEXT_BYTES (4 MiB); this is 16x that, so it refuses only
 * something no manifest could have produced while leaving room for a future
 * chunker change. There is deliberately NO cap on the TOTAL: streaming
 * exists precisely so a file larger than the renderer's heap can be saved,
 * and the old whole-buffer path's 2 GiB cap would put that limit straight
 * back.
 */
const MAX_VAULT_CHUNK_BYTES = 64 * 1024 * 1024;

/** The open destination. A seam so a test can make a write fail part-way. */
export type VaultSinkFile = {
  write(bytes: Uint8Array): Promise<void>;
  close(): Promise<void>;
};

export type VaultSinkDeps = {
  showSaveDialog(opts: { title: string; defaultPath: string }): Promise<{ canceled: boolean; filePath?: string }>;
  downloadsDir(): string;
  /** Defaults to a real owner-only file; overridden only by tests. */
  open?(path: string): Promise<VaultSinkFile>;
};

export type VaultSinkOpenResult = { ok: boolean; id?: string };

type VaultSink = { file: VaultSinkFile; path: string; nextIndex: number };

const sinks = new Map<string, VaultSink>();
/**
 * Opens that have passed the limit check but have not reached `sinks.set`
 * yet - they are sitting on the save dialog, which is an unbounded wait on a
 * human. Counted against MAX_OPEN_VAULT_SINKS so the limit is a real limit;
 * see the note in `openVaultSink`.
 */
let pendingOpens = 0;

/** How many save sinks are open. Lets the quit/abort paths be asserted. */
export function openVaultSinkCount(): number {
  return sinks.size;
}

// No top-level `import { app, dialog } from "electron"` here on purpose:
// outside the Electron runtime that named import throws, which would make
// this whole file - and the save path it holds - unloadable under a plain
// Node test runner. Deferred into the default-deps factory below, so it is
// only ever reached when `openVaultSink` is called without injected deps
// (i.e. real production use, never a test). Same reasoning as lan-receive.ts.
const electronRequire = createRequire(import.meta.url);
function realVaultSinkDeps(): VaultSinkDeps {
  const { app, dialog } = electronRequire("electron") as typeof import("electron");
  return {
    showSaveDialog: (o) => dialog.showSaveDialog(o),
    downloadsDir: () => app.getPath("downloads"),
  };
}

async function realVaultSinkOpen(path: string): Promise<VaultSinkFile> {
  // Owner-only, like the whole-buffer path and file:open's temp copy: this is
  // plaintext the user chose to keep encrypted everywhere else. (The mode
  // applies on creation; overwriting a file the user picked keeps its own.)
  const handle: FileHandle = await fsOpen(longPath(path), "w", 0o600);
  return {
    write: async (bytes) => { await handle.write(bytes); },
    close: () => handle.close(),
  };
}

export async function openVaultSink(
  name: unknown,
  deps: VaultSinkDeps = realVaultSinkDeps(),
): Promise<VaultSinkOpenResult> {
  if (typeof name !== "string" || name.length === 0 || name.length > 500) {
    throw new Error("Invalid file name");
  }
  // Counted together with the in-flight opens, and RESERVED before the
  // dialog is awaited. This check used to sit in front of `showSaveDialog`
  // and count only `sinks.size`, which meant it bounded nothing: N download
  // clicks in a row all saw size 0, all passed, all stacked a save dialog and
  // all opened a file handle, because none of them had reached `sinks.set`
  // yet. The limit only engages if the window between the check and the set
  // is counted.
  if (sinks.size + pendingOpens >= MAX_OPEN_VAULT_SINKS) {
    throw new Error("Too many downloads in progress");
  }
  pendingOpens++;
  try {
    const safeName = safeVaultFileName(name);
    const { canceled, filePath } = await deps.showSaveDialog({
      title: "Save decrypted file",
      defaultPath: join(deps.downloadsDir(), safeName),
    });
    if (canceled || !filePath) return { ok: false };

    const file = await (deps.open ?? realVaultSinkOpen)(filePath);
    const id = randomUUID();
    sinks.set(id, { file, path: filePath, nextIndex: 0 });
    return { ok: true, id };
  } finally {
    // Released on every path - cancelled dialog, failed open, success - or
    // the reservation leaks and the limit tightens for the rest of the
    // session.
    pendingOpens--;
  }
}

/**
 * Append one decrypted chunk. `index` is the manifest index e2ee-core handed
 * the sink; it must be the next one, or the file this would produce is not
 * the file that was encrypted and the partial is removed.
 */
export async function writeVaultSink(id: unknown, bytes: unknown, index: unknown): Promise<void> {
  const sink = requireVaultSink(id);
  const buf =
    bytes instanceof Uint8Array ? bytes
    : bytes instanceof ArrayBuffer ? new Uint8Array(bytes)
    : null;
  if (!buf || buf.byteLength > MAX_VAULT_CHUNK_BYTES) throw new Error("Invalid chunk");
  if (typeof index !== "number" || !Number.isInteger(index) || index < 0) {
    throw new Error("Invalid chunk index");
  }
  if (index !== sink.nextIndex) {
    await destroyVaultSink(id as string, true);
    throw new Error(`Chunk ${index} arrived out of order (expected ${sink.nextIndex})`);
  }

  // Advanced BEFORE the write is awaited, which is what makes the
  // out-of-order check above actually refuse an interleaved caller. With the
  // increment after the await, two concurrent calls for indices 0 and 1 both
  // measured `nextIndex === 0`: the second one took the "out of order" branch
  // and unlinked the file while the first one's write was still in flight,
  // and the first then resolved successfully, reporting a chunk written to a
  // sink that no longer existed. Two calls both carrying index 0 both passed.
  //
  // Nothing interleaves today - e2ee-core's `decryptFileStreaming` awaits
  // each `sink(plain, i)` in a plain sequential loop - so this was a false
  // guarantee rather than a live corruption. It is the guarantee the check
  // was added for, so it is now true instead of documented.
  sink.nextIndex += 1;
  try {
    await sink.file.write(buf);
  } catch (e) {
    // A disk that filled up part-way through a 2 GiB decrypt must not leave a
    // truncated plaintext document that looks complete. The partial goes, and
    // the failure reaches the caller. (No need to undo the increment: this
    // sink is gone.)
    await destroyVaultSink(id as string, true);
    throw e;
  }
}

export async function closeVaultSink(id: unknown): Promise<{ path: string }> {
  const sink = requireVaultSink(id);
  try {
    await sink.file.close();
  } finally {
    // Removed whatever close() did. There is no handle left to retry with, so
    // keeping the entry on a failed close would only burn one of
    // MAX_OPEN_VAULT_SINKS for the rest of the session while also leaving an
    // id the renderer could call again.
    sinks.delete(id as string);
  }
  return { path: sink.path };
}

export async function abortVaultSink(id: unknown): Promise<void> {
  if (typeof id !== "string" || !sinks.has(id)) return; // already gone
  await destroyVaultSink(id, true);
}

/**
 * Close every open save sink and remove the partial files. Wired to the app's
 * quit path by the controller, beside lan-receive's `abortAllSinks`.
 */
export async function abortAllVaultSinks(): Promise<void> {
  for (const id of [...sinks.keys()]) await destroyVaultSink(id, true);
}

function requireVaultSink(id: unknown): VaultSink {
  if (typeof id !== "string") throw new Error("Invalid save id");
  const sink = sinks.get(id);
  if (!sink) throw new Error("No such save");
  return sink;
}

async function destroyVaultSink(id: string, removeFile: boolean): Promise<void> {
  const sink = sinks.get(id);
  if (!sink) return;
  sinks.delete(id);
  try { await sink.file.close(); } catch { /* already closed */ }
  if (removeFile) { try { await unlink(longPath(sink.path)); } catch { /* nothing to remove */ } }
}
