/**
 * State serialization helper.
 *
 * Previous version used a worker_threads Worker for off-thread JSON.stringify.
 * That caused severe memory bloat: postMessage does a structured clone of the
 * entire state object (~30MB) into the worker's V8 heap, the worker stringifies
 * it (~15MB), then postMessage clones the result back. That's 3 copies per save
 * across 2 V8 heaps that never shrink. Over 760 saves during a 38K-file sync,
 * memory grew to 2.5GB.
 *
 * Now we just stringify synchronously. It takes ~50ms for 50K entries — acceptable
 * since it only runs every 50 file operations (STATE_SAVE_INTERVAL).
 */

export function stringifyOffThread(state: unknown): Promise<string> {
  return Promise.resolve(JSON.stringify(state));
}

export function terminateStateWriter(): void {
  // No-op — no worker to terminate
}
