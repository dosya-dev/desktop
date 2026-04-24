/**
 * State serialization helper.
 *
 * JSON.stringify on 400K entries takes ~200-500ms synchronously.
 * We can't avoid the stringify cost, but we yield to the event loop
 * after it completes so IPC/UI updates aren't starved.
 */

export function stringifyOffThread(state: unknown): Promise<string> {
  const json = JSON.stringify(state);
  // Yield to event loop after the synchronous stringify so pending
  // IPC messages, watcher events, and UI updates can process.
  return new Promise(resolve => setImmediate(() => resolve(json)));
}

export function terminateStateWriter(): void {
  // No-op
}
