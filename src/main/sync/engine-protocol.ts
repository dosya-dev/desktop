/**
 * The wire protocol between the main process and the isolated sync engine.
 *
 * Both processes import this file and nothing else in common, which is why it
 * has ZERO value imports: `node --test` strips types only, so a module a test
 * loads directly cannot import values from its siblings. Keeping it a leaf
 * also keeps it honest - the protocol should not need the engine to describe
 * itself.
 *
 * Every message crossing the boundary is validated on arrival. A utilityProcess
 * message is untrusted input in exactly the way an IPC message is: malformed or
 * unexpected traffic must be dropped, never crash the receiver, and never reach
 * a method lookup. That last point is the reason `isEngineRpcMethod` exists as
 * an allowlist rather than a `typeof engine[method] === "function"` check -
 * the latter would happily call `constructor` or anything else on the chain.
 */

/**
 * Every engine method the main process may invoke remotely.
 *
 * This list is the security boundary AND the contract: the child's dispatch
 * table must have exactly these keys, so adding a method here without adding
 * its handler is a type error rather than a runtime "not a function".
 */
export const ENGINE_RPC_METHODS = [
  "start",
  "stop",
  "getConfig",
  "saveGlobalConfig",
  "addPair",
  "removePair",
  "updatePair",
  "pausePair",
  "resumePair",
  "pauseAll",
  "pauseAllFor",
  "resumeAll",
  "pauseAllTransient",
  "resumeAllTransient",
  "syncNow",
  "resolveConflict",
  "setAppVisible",
  "notifyNetworkOnline",
  "getFolderTree",
] as const;

export type EngineRpcMethod = (typeof ENGINE_RPC_METHODS)[number];

/** The capabilities the child can only get by asking the parent for them. */
export const HOST_METHODS = ["getSessionCookies", "resolveProxy"] as const;
export type HostMethod = (typeof HOST_METHODS)[number];

/** The engine events the renderer subscribes to. Nothing else crosses. */
export const ENGINE_EVENTS = ["status-changed", "conflict-detected", "error"] as const;
export type EngineEventName = (typeof ENGINE_EVENTS)[number];

export type ParentToChild =
  | { t: "init"; apiBase: string; userDataDir: string; isDev: boolean }
  | { t: "rpc"; id: number; method: EngineRpcMethod; args: unknown[] }
  | { t: "host-res"; id: number; ok: true; value: unknown }
  | { t: "host-res"; id: number; ok: false; error: string };

export type ChildToParent =
  | { t: "ready" }
  | { t: "rpc-res"; id: number; ok: true; value: unknown }
  | { t: "rpc-res"; id: number; ok: false; error: string }
  | { t: "event"; name: EngineEventName; data: unknown }
  | { t: "host"; id: number; method: HostMethod; args: unknown[] };

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * A usable correlation id. NaN and Infinity are rejected explicitly because
 * they survive `typeof x === "number"` and would silently fail every Map
 * lookup, leaving the caller's promise pending forever.
 */
function isId(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

export function isEngineRpcMethod(v: unknown): v is EngineRpcMethod {
  return typeof v === "string" && (ENGINE_RPC_METHODS as readonly string[]).includes(v);
}

export function isHostMethod(v: unknown): v is HostMethod {
  return typeof v === "string" && (HOST_METHODS as readonly string[]).includes(v);
}

export function isEngineEventName(v: unknown): v is EngineEventName {
  return typeof v === "string" && (ENGINE_EVENTS as readonly string[]).includes(v);
}

export function isParentToChild(v: unknown): v is ParentToChild {
  if (!isRecord(v)) return false;
  switch (v.t) {
    case "init":
      return typeof v.apiBase === "string" && typeof v.userDataDir === "string" && typeof v.isDev === "boolean";
    case "rpc":
      return isId(v.id) && isEngineRpcMethod(v.method) && Array.isArray(v.args);
    case "host-res":
      return isId(v.id) && (v.ok === true || (v.ok === false && typeof v.error === "string"));
    default:
      return false;
  }
}

export function isChildToParent(v: unknown): v is ChildToParent {
  if (!isRecord(v)) return false;
  switch (v.t) {
    case "ready":
      return true;
    case "rpc-res":
      return isId(v.id) && (v.ok === true || (v.ok === false && typeof v.error === "string"));
    case "event":
      return isEngineEventName(v.name);
    case "host":
      return isId(v.id) && isHostMethod(v.method) && Array.isArray(v.args);
    default:
      return false;
  }
}

/**
 * Flatten anything throwable into a string.
 *
 * An `Error` does not cross a structured-clone boundary with its stack and
 * prototype intact, so both sides serialize to text at the edge instead of
 * pretending the object survives. The empty-string guard matters more than it
 * looks: `new Error("")` is common from aborted fetches, and an empty message
 * renders in the Issues tab as a blank row that tells the user nothing.
 */
export function errorText(err: unknown): string {
  if (err instanceof Error && err.message) return err.message;
  if (typeof err === "string" && err) return err;
  if (err === null) return "null";
  if (err === undefined) return "undefined";
  try {
    const s = String(err);
    return s || "Unknown error";
  } catch {
    return "Unknown error";
  }
}
