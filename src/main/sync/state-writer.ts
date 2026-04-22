/**
 * Worker-thread JSON serializer for sync state.
 *
 * JSON.stringify on a 50K-entry state object blocks the main thread for
 * 50-200ms. This module runs the serialization in a worker thread so the
 * event loop stays responsive (IPC, UI updates, watcher events all keep
 * flowing while the state is being serialized).
 */

import { Worker, isMainThread, parentPort, workerData } from "worker_threads";

// ── Worker side (runs in a separate thread) ────────────────────────
if (!isMainThread && parentPort) {
  parentPort.on("message", (state: unknown) => {
    try {
      const json = JSON.stringify(state);
      parentPort!.postMessage({ ok: true, json });
    } catch (err: any) {
      parentPort!.postMessage({ ok: false, error: err.message });
    }
  });
}

// ── Main-thread API ────────────────────────────────────────────────

let worker: Worker | null = null;
let pending: { resolve: (json: string) => void; reject: (err: Error) => void } | null = null;

function getWorker(): Worker {
  if (!worker) {
    worker = new Worker(__filename);
    worker.on("message", (msg: { ok: boolean; json?: string; error?: string }) => {
      if (!pending) return;
      const { resolve, reject } = pending;
      pending = null;
      if (msg.ok) resolve(msg.json!);
      else reject(new Error(msg.error ?? "Serialization failed"));
    });
    worker.on("error", (err) => {
      if (pending) {
        pending.reject(err);
        pending = null;
      }
      // Recreate worker on next call
      worker = null;
    });
    worker.unref(); // Don't keep the process alive for this worker
  }
  return worker;
}

/**
 * Serialize a state object to JSON off the main thread.
 * Falls back to synchronous JSON.stringify if the worker is busy
 * (only one serialization at a time per worker to keep it simple).
 */
export function stringifyOffThread(state: unknown): Promise<string> {
  // If worker is already busy, fall back to sync (don't queue — the caller
  // already serializes via safeSaveState, so this is rare).
  if (pending) {
    return Promise.resolve(JSON.stringify(state));
  }

  return new Promise<string>((resolve, reject) => {
    pending = { resolve, reject };
    try {
      getWorker().postMessage(state);
    } catch {
      // Worker failed to accept message (e.g., state too large for structured clone)
      pending = null;
      resolve(JSON.stringify(state));
    }
  });
}

/** Clean up the worker (call on app quit). */
export function terminateStateWriter(): void {
  if (worker) {
    worker.terminate();
    worker = null;
  }
}
