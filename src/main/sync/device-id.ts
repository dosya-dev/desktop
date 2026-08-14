import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { join } from "node:path";

/**
 * A stable identity for THIS INSTALLATION of the desktop app.
 *
 * The server cannot tell that a machine has stopped syncing without one. "Sync
 * stopped" is the absence of an event, so it can only be found by comparing a
 * per-device last-seen timestamp against now - and until this file existed,
 * dosya.dev had no device identifier anywhere in the product. The id goes out
 * on the X-Dosya-Device header, POST /api/sync/commit records it against
 * `device_sync_state`, and a daily sweep notices when a device stops writing.
 *
 * Three properties, all deliberate:
 *
 *   - **Random, never derived from hardware.** A MAC address or a machine
 *     serial would be a fingerprint that survives an uninstall and identifies
 *     the person, not the installation. This is a `crypto.randomUUID()` and
 *     means nothing outside our own table. The server treats it as opaque and
 *     never parses it.
 *   - **One per installation, not one per account.** Migration 0113 keys
 *     `device_sync_state` on `(user_id, device_id)`, so a laptop with a
 *     personal and a work login gets one row per account from a single id.
 *     Splitting the id per account would instead make one machine look like
 *     two.
 *   - **Persisted beside the sync config, not inside it.** An account switch
 *     wipes pair state and empties `sync-config.json` (see index.ts's
 *     account-switch branch); the machine is still the same machine, so its id
 *     lives in its own file and survives that.
 *
 * A reinstall that loses this file produces a new id. That is fine and
 * documented: the old row simply goes quiet and ages out of the 30-day window
 * the watchdog looks at.
 */

/** Header name, spelled once. The server reads it case-insensitively. */
export const DEVICE_ID_HEADER = "X-Dosya-Device";

/** JSON rather than a bare string so a later field can join it without a format change. */
export const DEVICE_ID_FILE = "device-id.json";

/**
 * The same shape and bounds the server validates on
 * (apps/api/src/lib/sync/device-state.ts). Kept in step deliberately: an id
 * this app happily persists but the server silently ignores is a device that
 * looks like it is reporting and never is.
 */
const MIN_LENGTH = 8;
const MAX_LENGTH = 128;
const SHAPE = /^[A-Za-z0-9._:-]+$/;

export function isValidDeviceId(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const id = value.trim();
  return id.length >= MIN_LENGTH && id.length <= MAX_LENGTH && SHAPE.test(id);
}

function filePath(dir: string): string {
  return join(dir, DEVICE_ID_FILE);
}

/**
 * Write to a unique temp file, flush it, then rename - the same contract
 * config.ts uses for `sync-config.json`, and for the same reason: a crash
 * midway through a plain write leaves a 0-byte file, which here would read as
 * "no device yet" and mint a second identity for the same machine.
 *
 * Reimplemented here rather than imported from config.ts because that module
 * imports `electron`, and this one must stay runnable (and testable) outside an
 * Electron process.
 */
let tmpCounter = 0;
async function atomicWrite(path: string, data: string): Promise<void> {
  const tmpPath = `${path}.${process.pid}.${tmpCounter++}.tmp`;
  const fh = await open(tmpPath, "w");
  try {
    await fh.writeFile(data, "utf-8");
    await fh.sync();
  } finally {
    await fh.close();
  }
  try {
    await rename(tmpPath, path);
  } catch (err) {
    await unlink(tmpPath).catch(() => {});
    throw err;
  }
}

/**
 * Read the installation's id, minting and persisting one on first run.
 *
 * Never throws and never returns an empty string: the id is used to decorate
 * sync requests, and a device identity failing must never be able to stop a
 * sync. A store that cannot be read or written yields an in-memory id, so the
 * app still reports consistently for as long as it is running and simply
 * starts over next launch - the same degradation as a reinstall.
 */
export async function loadOrCreateDeviceId(dir: string): Promise<string> {
  try {
    const raw = await readFile(filePath(dir), "utf-8");
    const parsed = JSON.parse(raw) as { deviceId?: unknown };
    if (isValidDeviceId(parsed?.deviceId)) return parsed.deviceId.trim();
    // A corrupt or truncated store is replaced rather than repaired: there is
    // nothing in it to repair from, and the cost is one device row going quiet.
    console.warn("[sync] Device id file is unusable - minting a new installation id");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    // ENOENT is the ordinary first run, not a problem worth logging.
    if (code !== "ENOENT") {
      console.error("[sync] Could not read the device id file:", (err as Error)?.message);
    }
  }

  const deviceId = randomUUID();
  try {
    await mkdir(dir, { recursive: true });
    await atomicWrite(filePath(dir), `${JSON.stringify({ deviceId }, null, 2)}\n`);
  } catch (err) {
    // Sync carries on with an id that lasts as long as this process does.
    console.error("[sync] Could not persist the device id - it will not survive a restart:", (err as Error)?.message);
  }
  return deviceId;
}

/**
 * Process-wide memo. One read on first use, one value for the life of the app,
 * and concurrent callers share the same in-flight promise so two requests
 * racing at startup cannot mint two ids and have the loser overwrite the file.
 */
let inFlight: Promise<string> | null = null;
let resolved: string | null = null;

export async function ensureDeviceId(dir: string): Promise<string> {
  if (resolved) return resolved;
  if (!inFlight) {
    inFlight = loadOrCreateDeviceId(dir).then((id) => {
      resolved = id;
      return id;
    });
  }
  return inFlight;
}

/**
 * The id if it has already been loaded, otherwise null.
 *
 * For the two upload paths that build their headers inside a Promise executor
 * and cannot await. They run long after the first API call has resolved the id,
 * so in practice this is never null there - and omitting the header on a raw
 * byte upload costs nothing anyway, since only /api/sync/commit reads it.
 */
export function currentDeviceId(): string | null {
  return resolved;
}
