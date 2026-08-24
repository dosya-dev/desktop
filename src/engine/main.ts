/**
 * Entry point for the isolated sync engine.
 *
 * This file runs inside `utilityProcess.fork` - plain Node with Electron's
 * runtime, but no `app`, no `session`, no `BrowserWindow`. It owns the
 * SyncEngine and its SQLite index, and does nothing else: all it does is
 * translate messages into method calls and events back into messages. Keeping
 * it this thin is what makes it safe to have no unit test of its own; the
 * behavior worth testing lives in SyncEngine, engine-protocol and
 * restart-policy, which all have their own.
 *
 * CRITICAL: nothing reachable from here may import `electron`. `electron-env.ts`
 * is the one module that does, and this process must never load it - the
 * engine takes its EnvProvider from `createParentEnv` instead. A stray
 * transitive import shows up as an instant startup crash, not a type error, so
 * that is the first thing to check if the child dies immediately.
 */
import { SyncEngine } from "../main/sync";
import { setSyncDataDir } from "../main/sync/config";
import { createParentEnv, type HostCall } from "./parent-env";
import {
  isParentToChild,
  errorText,
  ENGINE_RPC_METHODS,
  type EngineRpcMethod,
  type HostMethod,
} from "../main/sync/engine-protocol";
import type { SyncConfig, SyncPair } from "../main/sync/types";

type Resolver = { resolve: (v: unknown) => void; reject: (e: Error) => void };

const parentPort = process.parentPort;

let engine: SyncEngine | null = null;
let nextHostId = 1;
const pendingHostCalls = new Map<number, Resolver>();

function post(msg: unknown): void {
  parentPort.postMessage(msg);
}

/** Ask the parent for something only it can do (cookies, proxy). */
const callHost: HostCall = (method: HostMethod, args: unknown[]) =>
  new Promise((resolve, reject) => {
    const id = nextHostId++;
    pendingHostCalls.set(id, { resolve, reject });
    post({ t: "host", id, method, args });
  });

/**
 * The dispatch table.
 *
 * Explicitly enumerated rather than `(engine as any)[method](...)`: a lookup
 * on the instance would let any string that survives validation reach anything
 * on the prototype chain. Typing it as a total Record over EngineRpcMethod
 * means adding a method to the protocol without adding it here is a compile
 * error rather than a runtime "not a function" the user sees as a hung button.
 */
function buildHandlers(e: SyncEngine): Record<EngineRpcMethod, (args: unknown[]) => unknown> {
  return {
    start: () => e.start(),
    stop: () => e.stop(),
    getConfig: () => e.getConfig(),
    saveGlobalConfig: (a) => e.saveGlobalConfig(a[0] as Partial<SyncConfig>),
    addPair: (a) => e.addPair(a[0] as SyncPair),
    removePair: (a) => e.removePair(a[0] as string),
    updatePair: (a) => e.updatePair(a[0] as string, a[1] as Partial<SyncPair>),
    pausePair: (a) => e.pausePair(a[0] as string),
    resumePair: (a) => e.resumePair(a[0] as string),
    pauseAll: () => e.pauseAll(),
    pauseAllFor: (a) => e.pauseAllFor(a[0] as number),
    resumeAll: () => e.resumeAll(),
    pauseAllTransient: () => e.pauseAllTransient(),
    resumeAllTransient: () => e.resumeAllTransient(),
    syncNow: (a) => e.syncNow(a[0] as string),
    resolveConflict: (a) =>
      e.resolveConflict(a[0] as string, a[1] as "keep-local" | "keep-remote" | "keep-both"),
    setAppVisible: (a) => e.setAppVisible(a[0] as boolean),
    notifyNetworkOnline: () => e.notifyNetworkOnline(),
    getFolderTree: (a) => e.getFolderTree(a[0] as string),
  };
}

let handlers: Record<EngineRpcMethod, (args: unknown[]) => unknown> | null = null;

function init(apiBase: string, userDataDir: string, isDev: boolean): void {
  if (engine) return; // a duplicate init would open a second index on the same file

  // Must happen before anything touches a path: config.ts still has an
  // `app.getPath` fallback for the in-process engine, and reaching it here
  // would throw because there is no `app` in this process.
  setSyncDataDir(userDataDir);

  const env = createParentEnv(callHost, { userDataDir, isDev });
  engine = new SyncEngine(apiBase, env);
  handlers = buildHandlers(engine);

  engine.on("status-changed", (data) => post({ t: "event", name: "status-changed", data }));
  engine.on("conflict-detected", (data) => post({ t: "event", name: "conflict-detected", data }));
  engine.on("error", (data) => post({ t: "event", name: "error", data: serializable(data) }));

  post({ t: "ready" });
}

/**
 * Everything crossing the port goes through structured clone, which throws on
 * an Error instance in some paths and silently drops its message in others.
 * Engine errors are emitted as plain objects so the Issues tab shows text
 * rather than `{}`.
 */
function serializable(data: unknown): unknown {
  if (data instanceof Error) return { message: errorText(data) };
  return data;
}

parentPort.on("message", (e) => {
  const msg = e.data;
  if (!isParentToChild(msg)) return; // untrusted input: drop it, never throw

  switch (msg.t) {
    case "init":
      init(msg.apiBase, msg.userDataDir, msg.isDev);
      return;

    case "rpc": {
      const id = msg.id;
      if (!handlers) {
        post({ t: "rpc-res", id, ok: false, error: "The sync engine is not initialized." });
        return;
      }
      // Promise.resolve wraps the void methods (syncNow, setAppVisible) so
      // both shapes reply exactly once and the caller never has to know which
      // kind it invoked.
      Promise.resolve()
        .then(() => handlers![msg.method](msg.args))
        .then((value) => post({ t: "rpc-res", id, ok: true, value: value ?? null }))
        .catch((err) => post({ t: "rpc-res", id, ok: false, error: errorText(err) }));
      return;
    }

    case "host-res": {
      const pending = pendingHostCalls.get(msg.id);
      if (!pending) return;
      pendingHostCalls.delete(msg.id);
      if (msg.ok) pending.resolve(msg.value);
      else pending.reject(new Error(msg.error));
      return;
    }
  }
});

/**
 * A crash here is survivable now, which is the entire point of Phase 6 - but
 * only if we actually die. Swallowing the exception would leave a half-dead
 * engine that the supervisor believes is healthy, which is strictly worse than
 * the pre-Phase-6 behavior. Report, then exit so the restart path runs.
 */
process.on("uncaughtException", (err) => {
  console.error("[sync-engine] uncaught exception:", err);
  try {
    post({ t: "event", name: "error", data: { message: errorText(err) } });
  } catch {
    // The port may already be gone; exiting is what matters.
  }
  process.exit(1);
});

process.on("unhandledRejection", (err) => {
  console.error("[sync-engine] unhandled rejection:", err);
  try {
    post({ t: "event", name: "error", data: { message: errorText(err) } });
  } catch {
    // As above.
  }
  process.exit(1);
});

// Sanity check that the table and the protocol agree. Cheap, runs once, and
// turns a whole class of "the button does nothing" into a startup log line.
for (const m of ENGINE_RPC_METHODS) {
  if (handlers && !(m in handlers)) console.error(`[sync-engine] missing handler for ${m}`);
}
