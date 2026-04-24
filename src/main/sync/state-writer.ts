/**
 * State serialization helper using a real worker thread.
 *
 * JSON.stringify on 400K entries takes ~200-500ms synchronously.
 * Moving it to a worker thread prevents blocking the main thread
 * where IPC, watcher events, and UI updates need to flow.
 *
 * Uses an inline worker script (via data URL) to avoid needing a
 * separate file that the bundler must handle specially.
 */

import { Worker } from "worker_threads";

// Inline worker script: receives objects, stringifies them, posts back JSON.
const WORKER_SCRIPT = `
const { parentPort } = require("worker_threads");
parentPort.on("message", (msg) => {
  try {
    const json = JSON.stringify(msg.data);
    parentPort.postMessage({ id: msg.id, json });
  } catch (err) {
    parentPort.postMessage({ id: msg.id, json: null, error: err.message });
  }
});
`;

let worker: Worker | null = null;
let nextId = 0;
const pending = new Map<number, { resolve: (json: string) => void; reject: (err: Error) => void }>();

function getWorker(): Worker {
  if (worker) return worker;

  // Create worker from inline script using data URL
  worker = new Worker(WORKER_SCRIPT, { eval: true });

  worker.on("message", (msg: { id: number; json: string | null; error?: string }) => {
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    if (msg.json != null) {
      p.resolve(msg.json);
    } else {
      p.reject(new Error(msg.error ?? "Worker stringify failed"));
    }
  });

  worker.on("error", (err) => {
    for (const [, p] of pending) {
      p.reject(err);
    }
    pending.clear();
    worker = null;
  });

  worker.on("exit", () => {
    worker = null;
  });

  worker.unref();

  return worker;
}

/**
 * Serialize state to JSON in a worker thread.
 * Falls back to synchronous stringify if the worker fails.
 */
export function stringifyOffThread(state: unknown): Promise<string> {
  return new Promise((resolve, reject) => {
    try {
      const w = getWorker();
      const id = nextId++;
      pending.set(id, { resolve, reject });

      // Structured clone transfer to worker — typically ~20ms for 50K entries,
      // vs 200-500ms for JSON.stringify on the main thread.
      w.postMessage({ id, data: state });
    } catch {
      // Worker creation failed — fall back to sync stringify
      try {
        const json = JSON.stringify(state);
        resolve(json);
      } catch (err: any) {
        reject(err);
      }
    }
  });
}

export function terminateStateWriter(): void {
  if (worker) {
    worker.terminate().catch(() => {});
    worker = null;
  }
  for (const [, p] of pending) {
    p.reject(new Error("State writer terminated"));
  }
  pending.clear();
}
