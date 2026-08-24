import { EventEmitter } from "events";
import { utilityProcess, app, type UtilityProcess } from "electron";
import { loadConfig } from "./config";
import { createElectronEnv } from "./electron-env";
import { mergeStatusPairs } from "./status-merge";
import { RestartPolicy, HEALTHY_AFTER_MS } from "./restart-policy";
import {
  isChildToParent,
  errorText,
  type ChildToParent,
  type EngineRpcMethod,
  type HostMethod,
} from "./engine-protocol";
import type { SyncConfig, SyncPair, SyncStatus, SyncConflict, RemoteFolderInfo } from "./types";

/**
 * The slice of SyncEngine the main process actually consumes.
 *
 * SyncEngine satisfies this structurally, which is what lets
 * DOSYA_SYNC_IN_PROCESS=1 swap the isolated engine for the in-process one with
 * no other change at any call site.
 */
export interface SyncEngineHandle {
  on(event: "status-changed", cb: (s: SyncStatus) => void): this | void;
  on(event: "conflict-detected", cb: (c: SyncConflict) => void): this | void;
  on(event: "error", cb: (e: unknown) => void): this | void;
  start(): Promise<void>;
  stop(): Promise<void>;
  isRunning(): boolean;
  getStatus(): SyncStatus;
  getConflicts(): SyncConflict[];
  getConfig(): Promise<SyncConfig>;
  saveGlobalConfig(updates: Partial<SyncConfig>): Promise<void>;
  addPair(pair: SyncPair): Promise<void>;
  removePair(pairId: string): Promise<void>;
  updatePair(pairId: string, updates: Partial<SyncPair>): Promise<void>;
  pausePair(pairId: string): Promise<void>;
  resumePair(pairId: string): Promise<void>;
  pauseAll(): Promise<void>;
  pauseAllFor(ms: number): Promise<void>;
  resumeAll(): Promise<void>;
  pauseAllTransient(): Promise<void>;
  resumeAllTransient(): Promise<void>;
  syncNow(pairId: string): void;
  resolveConflict(conflictId: string, resolution: "keep-local" | "keep-remote" | "keep-both"): Promise<void>;
  setAppVisible(visible: boolean): void;
  notifyNetworkOnline(): void;
  getFolderTree(workspaceId: string): Promise<RemoteFolderInfo[]>;
}

const EMPTY_STATUS: SyncStatus = {
  pairs: [],
  globalPaused: false,
  activeTransfers: [],
  unresolvedConflicts: [],
  recentLogs: [],
};

/** How long an RPC may sit unanswered before we give the caller an error. */
const RPC_TIMEOUT_MS = 120_000;

const PARKED_MESSAGE =
  "Sync stopped after repeated crashes and will not restart on its own. Restart the app to try again.";

/**
 * Supervises the sync engine running in a utilityProcess, and presents it to
 * the rest of the main process as if it were still local.
 *
 * Why this exists: before Phase 6 an engine crash took the whole app with it,
 * because the engine ran in the main process - the 2026-08-20 stress test lost
 * the window along with the sync. Now a crash costs a re-fork and sync resumes
 * from the persistent ops queue, which is exactly what that queue was built
 * for.
 *
 * Three things here are worth understanding before changing them:
 *
 * 1. `getStatus()`, `getConflicts()` and `isRunning()` are SYNCHRONOUS, served
 *    from state the child pushes. Callers rely on that: main's power-monitor
 *    handler reads `getStatus().globalPaused` inline, and the tray reads it
 *    while building a menu. Turning them into promises would ripple through
 *    both for no benefit, since the child already emits on every change.
 *
 * 2. Before the child reports in, status is synthesized from config on disk via
 *    the same `mergeStatusPairs` the engine uses. Without it the Sync page
 *    would show "No sync folders yet" for the second the fork takes, which is
 *    the exact split-brain symptom the stress-test fixes removed.
 *
 * 3. Every pending RPC is rejected when the child exits. A promise that never
 *    settles hangs its `ipcMain.handle` forever and the renderer's button
 *    spins for the rest of the session - a far worse failure than an error
 *    toast.
 */
export class SyncEngineHost extends EventEmitter implements SyncEngineHandle {
  private child: UtilityProcess | null = null;
  private nextRpcId = 1;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  private policy = new RestartPolicy();
  /** The same provider the in-process engine would have used for itself. */
  private env = createElectronEnv();

  /** Last status pushed by the child. Null until it reports in. */
  private lastStatus: SyncStatus | null = null;
  /** Config read from disk, so status can be synthesized before the child is up. */
  private configSnapshot: SyncConfig | null = null;

  private running = false;
  private wantRunning = false;
  private intentionalStop = false;
  private parked = false;
  private readyPromise: Promise<void> | null = null;
  private healthyTimer: NodeJS.Timeout | null = null;
  private appVisible = true;

  constructor(
    private apiBase: string,
    private enginePath: string,
  ) {
    super();
    // EventEmitter THROWS on emit("error") when nothing is listening, and the
    // throw lands in the main process. Since this class emits "error" from the
    // child's exit path, an error arriving before registerSyncIpcHandlers has
    // attached its listener would crash the app - precisely the failure this
    // whole layer exists to prevent. A permanent no-op subscriber makes that
    // impossible; the real listeners still get their event.
    this.on("error", () => {});

    // Read config eagerly so the very first getStatus() - which the renderer
    // fires the moment the Sync page mounts - already knows the pairs.
    void this.refreshConfigSnapshot();
  }

  private async refreshConfigSnapshot(): Promise<void> {
    try {
      this.configSnapshot = await loadConfig();
    } catch {
      // A config we cannot read is not fatal here: the child owns config and
      // will report the real state once it is up. Synthesized status simply
      // stays empty until then.
    }
  }

  // ── Process lifecycle ──────────────────────────────────────────────

  private spawn(): Promise<void> {
    if (this.readyPromise) return this.readyPromise;

    this.readyPromise = new Promise<void>((resolve, reject) => {
      let settled = false;
      const child = utilityProcess.fork(this.enginePath, [], {
        serviceName: "dosya-sync-engine",
        stdio: "pipe",
      });
      this.child = child;

      // Keep engine logs in the same file the rest of the app writes to.
      // file-logger.ts mirrors console, NOT the raw streams, so these have to
      // go through console or the engine's output would vanish from main.log -
      // which is the one artifact a crash investigation actually has.
      child.stdout?.on("data", (b: Buffer) => console.log(`[sync-engine] ${String(b).trimEnd()}`));
      child.stderr?.on("data", (b: Buffer) => console.error(`[sync-engine] ${String(b).trimEnd()}`));

      child.on("message", (msg: unknown) => {
        if (!isChildToParent(msg)) return; // untrusted input: drop, never throw
        if (msg.t === "ready" && !settled) {
          settled = true;
          this.onChildReady();
          resolve();
          return;
        }
        this.handleChildMessage(msg);
      });

      child.on("exit", (code) => {
        this.onChildExit(code, settled ? null : reject);
        settled = true;
      });

      child.postMessage({
        t: "init",
        apiBase: this.apiBase,
        userDataDir: app.getPath("userData"),
        isDev: !app.isPackaged,
      });
    });

    return this.readyPromise;
  }

  private onChildReady(): void {
    // Re-apply the state the previous instance had, so a restart is invisible.
    if (!this.appVisible) this.post({ t: "rpc", id: this.nextRpcId++, method: "setAppVisible", args: [false] });
    this.healthyTimer = setTimeout(() => {
      this.policy.recordHealthy(Date.now());
    }, HEALTHY_AFTER_MS);
    this.healthyTimer.unref?.();
  }

  private onChildExit(code: number, rejectStartup: ((e: Error) => void) | null): void {
    this.child = null;
    this.readyPromise = null;
    if (this.healthyTimer) {
      clearTimeout(this.healthyTimer);
      this.healthyTimer = null;
    }

    // Reject every stranded caller before anything else - see class comment.
    const stranded = [...this.pending.values()];
    this.pending.clear();
    for (const p of stranded) {
      clearTimeout(p.timer);
      p.reject(new Error("The sync engine stopped before it could answer."));
    }

    if (this.intentionalStop) {
      this.intentionalStop = false;
      this.running = false;
      return;
    }

    const decision = this.policy.recordCrash(Date.now());
    console.error(`[sync-engine] exited with code ${code}; ${decision.action} (crash ${decision.recentCrashes} in window)`);

    if (decision.action === "park") {
      this.parked = true;
      this.running = false;
      this.emit("error", { message: PARKED_MESSAGE });
      rejectStartup?.(new Error(PARKED_MESSAGE));
      return;
    }

    if (!this.wantRunning) {
      // Crashed while stopped. Nothing to resume; the next start() re-forks.
      this.running = false;
      return;
    }

    setTimeout(() => {
      if (!this.wantRunning || this.parked) return;
      this.spawn()
        .then(() => this.rpc("start", []))
        .then(() => {
          this.running = true;
        })
        .catch((err) => {
          console.error("[sync-engine] restart failed:", errorText(err));
        });
    }, decision.delayMs).unref?.();

    rejectStartup?.(new Error(`The sync engine exited with code ${code}.`));
  }

  // ── Messaging ──────────────────────────────────────────────────────

  private post(msg: unknown): void {
    this.child?.postMessage(msg);
  }

  private handleChildMessage(msg: ChildToParent): void {
    switch (msg.t) {
      case "rpc-res": {
        const p = this.pending.get(msg.id);
        if (!p) return;
        this.pending.delete(msg.id);
        clearTimeout(p.timer);
        if (msg.ok) p.resolve(msg.value);
        else p.reject(new Error(msg.error));
        return;
      }
      case "event": {
        if (msg.name === "status-changed") this.lastStatus = msg.data as SyncStatus;
        this.emit(msg.name, msg.data);
        return;
      }
      case "host": {
        void this.serveHostCall(msg.id, msg.method, msg.args);
        return;
      }
      default:
        return;
    }
  }

  /**
   * Answer the child's request for something only the main process can do.
   *
   * Delegates straight to `createElectronEnv()` rather than reimplementing the
   * cookie lookup and the PAC-string parsing. That matters: those two are
   * exactly the logic the in-process engine uses today, and a second copy here
   * would drift the moment either is fixed. The isolated engine and the
   * in-process engine must resolve auth and proxies identically or the
   * DOSYA_SYNC_IN_PROCESS escape hatch stops being a valid comparison.
   *
   * Always replies, including on failure: a child left waiting on a host call
   * stalls every transfer queued behind it.
   */
  private async serveHostCall(id: number, method: HostMethod, args: unknown[]): Promise<void> {
    try {
      const value =
        method === "getSessionCookies"
          ? await this.env.getSessionCookies()
          : await this.env.resolveProxy(typeof args[0] === "string" ? args[0] : "");
      this.post({ t: "host-res", id, ok: true, value });
    } catch (err) {
      this.post({ t: "host-res", id, ok: false, error: errorText(err) });
    }
  }

  private async rpc(method: EngineRpcMethod, args: unknown[]): Promise<unknown> {
    if (this.parked) throw new Error(PARKED_MESSAGE);
    await this.spawn();
    return new Promise((resolve, reject) => {
      const id = this.nextRpcId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`The sync engine did not answer ${method} in time.`));
      }, RPC_TIMEOUT_MS);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
      this.post({ t: "rpc", id, method, args });
    });
  }

  /** Fire-and-forget for the void methods, so a dead child cannot throw at a
   *  caller that has no way to handle it (a tray click, a power event). */
  private send(method: EngineRpcMethod, args: unknown[]): void {
    this.rpc(method, args).catch((err) => {
      console.error(`[sync-engine] ${method} failed:`, errorText(err));
    });
  }

  // ── SyncEngineHandle ───────────────────────────────────────────────

  /**
   * Serializes start/stop so the two can never interleave.
   *
   * Logging out and back in fires stop() and start() within a millisecond.
   * Unserialized, start() would post its RPC into the child that stop() is
   * about to kill, and the exit handler would reject it as "stopped before it
   * could answer" - leaving sync dead after a perfectly ordinary re-login.
   *
   * The queued body re-reads `wantRunning` before acting, so whichever call
   * came last wins and the other becomes a no-op. That is why the flags are
   * set synchronously by the callers and only acted on in here.
   */
  private lifecycle: Promise<unknown> = Promise.resolve();

  private enqueueLifecycle<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.lifecycle.then(fn, fn);
    this.lifecycle = run.catch(() => {});
    return run;
  }

  async start(): Promise<void> {
    this.wantRunning = true;
    if (this.parked) throw new Error(PARKED_MESSAGE);
    // Flip synchronously, BEFORE the round trip. See isRunning().
    this.running = true;
    return this.enqueueLifecycle(async () => {
      if (!this.wantRunning) return; // a stop was requested after us
      try {
        await this.rpc("start", []);
      } catch (err) {
        this.running = false;
        throw err;
      }
      void this.refreshConfigSnapshot();
    });
  }

  async stop(): Promise<void> {
    this.wantRunning = false;
    // Same reasoning as start(): the state must be visible to any caller that
    // looks between here and the reply.
    this.running = false;
    return this.enqueueLifecycle(async () => {
      if (this.wantRunning) return; // a start was requested after us
      if (!this.child) return;
      this.intentionalStop = true;
      try {
        await this.rpc("stop", []);
      } catch {
        // A stop that fails still means we are stopping; fall through to kill.
      }
      this.child?.kill();
      this.child = null;
      this.readyPromise = null;
    });
  }

  /**
   * Whether the engine is meant to be running right now.
   *
   * This tracks INTENT and flips synchronously inside start()/stop(), rather
   * than waiting for the child to confirm. That is not a shortcut, it is the
   * fix for a real bug: main's session-cookie handler does
   * `if (removed) stop() else if (!isRunning()) start()`, and logging out and
   * back in fires those two within a millisecond of each other. When stop()
   * was a round trip that only cleared the flag on reply, the login arriving
   * mid-flight saw isRunning() === true, skipped the start, and left sync
   * silently dead for the rest of the session - which is exactly the class of
   * failure the isolated engine is supposed to eliminate, not introduce.
   */
  isRunning(): boolean {
    return this.running;
  }

  getStatus(): SyncStatus {
    if (this.lastStatus) return this.lastStatus;
    const pairs = this.configSnapshot?.pairs ?? [];
    const globalPaused = this.configSnapshot?.pausedGlobally ?? false;
    return {
      ...EMPTY_STATUS,
      pairs: this.parked
        ? mergeStatusPairs([], pairs, false).map((p) => ({
            ...p,
            status: "error" as const,
            errorMessage: PARKED_MESSAGE,
          }))
        : mergeStatusPairs([], pairs, globalPaused),
      globalPaused,
    };
  }

  getConflicts(): SyncConflict[] {
    return this.lastStatus?.unresolvedConflicts ?? [];
  }

  async getConfig(): Promise<SyncConfig> {
    const cfg = (await this.rpc("getConfig", [])) as SyncConfig;
    this.configSnapshot = cfg;
    return cfg;
  }

  async saveGlobalConfig(updates: Partial<SyncConfig>): Promise<void> {
    await this.rpc("saveGlobalConfig", [updates]);
    void this.refreshConfigSnapshot();
  }

  async addPair(pair: SyncPair): Promise<void> {
    await this.rpc("addPair", [pair]);
    void this.refreshConfigSnapshot();
  }

  async removePair(pairId: string): Promise<void> {
    await this.rpc("removePair", [pairId]);
    void this.refreshConfigSnapshot();
  }

  async updatePair(pairId: string, updates: Partial<SyncPair>): Promise<void> {
    await this.rpc("updatePair", [pairId, updates]);
    void this.refreshConfigSnapshot();
  }

  async pausePair(pairId: string): Promise<void> {
    await this.rpc("pausePair", [pairId]);
  }

  async resumePair(pairId: string): Promise<void> {
    await this.rpc("resumePair", [pairId]);
  }

  async pauseAll(): Promise<void> {
    await this.rpc("pauseAll", []);
  }

  async pauseAllFor(ms: number): Promise<void> {
    await this.rpc("pauseAllFor", [ms]);
  }

  async resumeAll(): Promise<void> {
    await this.rpc("resumeAll", []);
  }

  async pauseAllTransient(): Promise<void> {
    await this.rpc("pauseAllTransient", []);
  }

  async resumeAllTransient(): Promise<void> {
    await this.rpc("resumeAllTransient", []);
  }

  syncNow(pairId: string): void {
    this.send("syncNow", [pairId]);
  }

  async resolveConflict(conflictId: string, resolution: "keep-local" | "keep-remote" | "keep-both"): Promise<void> {
    await this.rpc("resolveConflict", [conflictId, resolution]);
  }

  setAppVisible(visible: boolean): void {
    this.appVisible = visible;
    if (this.child) this.send("setAppVisible", [visible]);
  }

  notifyNetworkOnline(): void {
    if (this.child) this.send("notifyNetworkOnline", []);
  }

  async getFolderTree(workspaceId: string): Promise<RemoteFolderInfo[]> {
    return (await this.rpc("getFolderTree", [workspaceId])) as RemoteFolderInfo[];
  }
}
