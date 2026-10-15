import { app, ipcMain, dialog, shell, BrowserWindow } from "electron";
import { isAbsolute } from "path";
import type { SyncEngineHandle } from "./engine-host";
import type { SyncPair, SyncMode, ConflictResolution } from "./types";
import { estimateFolder } from "./folder-estimate";
import { hasPair } from "./status-assembly";
import { currentDistribution } from "../distribution";
import { shouldReceiveStatus } from "./broadcast-targets";
import { makeIpcGate, rendererOrigin } from "../ipc-sender";

const VALID_SYNC_MODES: SyncMode[] = ["two-way", "push", "push-safe", "pull", "pull-safe"];
const VALID_CONFLICT_STRATEGIES = ["last-write-wins", "keep-both"];
const VALID_RESOLUTIONS = ["keep-local", "keep-remote", "keep-both"];

function assertString(val: unknown, name: string): asserts val is string {
  if (typeof val !== "string" || val.length === 0 || val.length > 1000) {
    throw new Error(`Invalid ${name}: must be a non-empty string`);
  }
}

function assertStringArray(val: unknown, name: string): asserts val is string[] {
  if (!Array.isArray(val) || !val.every((v) => typeof v === "string")) {
    throw new Error(`${name} must be an array of strings`);
  }
}

export function registerSyncIpcHandlers(engine: SyncEngineHandle): void {
  // ── Sender validation (S-1) ──────────────────────────────────────
  // Same gate as src/main/ipc.ts: every channel here refuses a message that
  // did not come from the app's own top-level renderer. `on` is not
  // destructured because nothing in this file registers one - add it (and the
  // gate, never bare ipcMain) if that changes; ipc-gate-coverage.test.ts fails
  // loudly if a bare registration ever appears.
  const { handle } = makeIpcGate(
    ipcMain,
    rendererOrigin({ isPackaged: app.isPackaged, devServerUrl: process.env.ELECTRON_RENDERER_URL }),
  );

  handle("sync:get-config", () => engine.getConfig());

  handle("sync:save-config", (_e, updates) => {
    if (typeof updates !== "object" || updates === null) {
      throw new Error("Invalid config updates");
    }
    return engine.saveGlobalConfig(updates);
  });

  handle("sync:get-status", () => engine.getStatus());

  handle("sync:add-pair", async (_e, opts: Omit<SyncPair, "id" | "createdAt">) => {
    // Validate required fields
    assertString(opts.workspaceId, "workspaceId");
    assertString(opts.workspaceName, "workspaceName");
    assertString(opts.localPath, "localPath");
    assertString(opts.remoteFolderName, "remoteFolderName");
    assertString(opts.region, "region");

    if (!isAbsolute(opts.localPath)) {
      throw new Error("localPath must be an absolute path");
    }

    if (opts.syncMode && !VALID_SYNC_MODES.includes(opts.syncMode)) {
      throw new Error(`Invalid syncMode: ${opts.syncMode}`);
    }
    if (opts.conflictStrategy && !VALID_CONFLICT_STRATEGIES.includes(opts.conflictStrategy)) {
      throw new Error(`Invalid conflictStrategy: ${opts.conflictStrategy}`);
    }
    // The sandbox grant travels with the path; only a string or "clear it" is
    // valid. Checked here as well as in sync:update-pair - a pair is created
    // with its bookmark, so this is the door it comes through first.
    if (opts.bookmark !== undefined && opts.bookmark !== null && typeof opts.bookmark !== "string") {
      throw new Error("bookmark must be a string");
    }

    // Validate excludedPatterns
    const excludedPatterns: string[] = [];
    if (Array.isArray((opts as any).excludedPatterns)) {
      for (const p of (opts as any).excludedPatterns) {
        if (typeof p === "string" && p.length > 0 && p.length <= 200) {
          excludedPatterns.push(p);
        }
      }
    }

    // Apply safe defaults for optional fields
    const pollInterval = typeof opts.pollIntervalMs === "number" && opts.pollIntervalMs >= 5000 && opts.pollIntervalMs <= 300000
      ? opts.pollIntervalMs
      : 30000;

    const pair: SyncPair = {
      ...opts,
      id: `sp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      createdAt: Date.now(),
      pollIntervalMs: pollInterval,
      syncMode: opts.syncMode || "push-safe",
      // keep-both for NEW pairs: when both sides changed the same file,
      // last-write-wins silently discards one of them. Keeping both costs a
      // second file in the folder; the alternative costs somebody's work.
      // Existing pairs keep whatever they were configured with.
      conflictStrategy: opts.conflictStrategy || "keep-both",
      selectiveFolders: Array.isArray(opts.selectiveFolders) ? opts.selectiveFolders : [],
      excludedPatterns,
      enabled: opts.enabled !== false,
    };
    await engine.addPair(pair);
    return pair;
  });

  handle("sync:remove-pair", (_e, { pairId }) => {
    assertString(pairId, "pairId");
    return engine.removePair(pairId);
  });

  handle("sync:update-pair", (_e, { pairId, updates }) => {
    assertString(pairId, "pairId");
    if (typeof updates !== "object" || updates === null) {
      throw new Error("Invalid updates");
    }
    // Prevent overriding localPath to arbitrary locations
    if (updates.localPath !== undefined) {
      assertString(updates.localPath, "localPath");
      if (!isAbsolute(updates.localPath)) {
        throw new Error("localPath must be an absolute path");
      }
    }
    if (updates.syncMode && !VALID_SYNC_MODES.includes(updates.syncMode)) {
      throw new Error(`Invalid syncMode: ${updates.syncMode}`);
    }
    // The sandbox grant travels with the path; only a string or "clear it" is valid.
    if (updates.bookmark !== undefined && updates.bookmark !== null && typeof updates.bookmark !== "string") {
      throw new Error("bookmark must be a string");
    }
    return engine.updatePair(pairId, updates);
  });

  // Cheap file/folder count so the Add-folder modal can warn about huge trees
  // before the user commits to syncing one.
  handle("sync:estimate-local-folder", async (_e, { path }) => {
    assertString(path, "path");
    if (!isAbsolute(path)) throw new Error("path must be absolute");
    return estimateFolder(path);
  });

  handle("sync:pick-local-folder", async (_e, opts?: { defaultPath?: string }) => {
    const win = BrowserWindow.getFocusedWindow();
    if (!win) return null;
    const defaultPath = opts?.defaultPath;
    if (defaultPath !== undefined) {
      assertString(defaultPath, "defaultPath");
      if (!isAbsolute(defaultPath)) throw new Error("defaultPath must be absolute");
    }
    const result = await dialog.showOpenDialog(win, {
      properties: ["openDirectory", "createDirectory"],
      title: "Select sync folder",
      ...(defaultPath ? { defaultPath } : {}),
      // Sandboxed builds only. macOS hands back a token that reopens this exact
      // grant after a relaunch; a saved path alone is inert in the sandbox.
      securityScopedBookmarks: currentDistribution() === "mas",
    });
    if (result.canceled) return null;
    const path = result.filePaths[0];
    if (!path) return null;
    return { path, bookmark: result.bookmarks?.[0] };
  });

  handle("sync:get-folder-tree", async (_e, { workspaceId }) => {
    assertString(workspaceId, "workspaceId");
    return engine.getFolderTree(workspaceId);
  });

  handle("sync:pause-pair", (_e, { pairId }) => {
    assertString(pairId, "pairId");
    return engine.pausePair(pairId);
  });
  handle("sync:resume-pair", (_e, { pairId }) => {
    assertString(pairId, "pairId");
    return engine.resumePair(pairId);
  });
  handle("sync:pause-all", () => engine.pauseAll());
  handle("sync:pause-all-for", (_e, { ms }) => {
    const n = typeof ms === "number" && ms > 0 && ms <= 24 * 60 * 60 * 1000 ? ms : 60 * 60 * 1000;
    return engine.pauseAllFor(n);
  });
  handle("sync:resume-all", () => engine.resumeAll());
  handle("sync:sync-now", (_e, { pairId }) => {
    assertString(pairId, "pairId");
    return engine.syncNow(pairId);
  });

  handle("sync:resolve-conflict", (_e, { conflictId, resolution }) => {
    assertString(conflictId, "conflictId");
    assertString(resolution, "resolution");
    if (!VALID_RESOLUTIONS.includes(resolution)) {
      throw new Error(`Invalid resolution: ${resolution}. Must be one of: ${VALID_RESOLUTIONS.join(", ")}`);
    }
    return engine.resolveConflict(conflictId, resolution as "keep-local" | "keep-remote" | "keep-both");
  });

  handle("sync:open-sync-folder", async (_e, { pairId }) => {
    assertString(pairId, "pairId");
    const config = await engine.getConfig();
    const pair = config.pairs.find((p) => p.id === pairId);
    if (pair) shell.openPath(pair.localPath);
  });

  handle("sync:list-conflicts", (_e, { pairIds, offset, limit }) => {
    if (pairIds !== undefined) assertStringArray(pairIds, "pairIds");
    if (typeof offset !== "number" || typeof limit !== "number") throw new Error("offset and limit must be numbers");
    return engine.listConflicts({ pairIds, offset, limit });
  });

  handle("sync:resolve-conflicts", (_e, { pairIds, resolution }) => {
    assertStringArray(pairIds, "pairIds");
    assertString(resolution, "resolution");
    if (!VALID_RESOLUTIONS.includes(resolution)) {
      throw new Error(`Invalid resolution: ${resolution}. Must be one of: ${VALID_RESOLUTIONS.join(", ")}`);
    }
    return engine.resolveConflicts(pairIds, resolution as ConflictResolution);
  });

  /**
   * A renderer that has been open across a pair removal can still name a pair
   * that no longer exists. That is stale UI, not an error worth throwing at
   * a button - log it and do nothing.
   */
  const withPair = (channel: string, run: (pairId: string) => unknown) =>
    handle(channel, (_e, { pairId }) => {
      assertString(pairId, "pairId");
      if (!hasPair(engine.getStatus(), pairId)) {
        console.warn(`[sync] ${channel}: no such sync folder (${pairId}) - ignoring`);
        return;
      }
      return run(pairId);
    });

  // "N files not synced" pill actions (Contract 9).
  withPair("sync:retry-file-errors", (pairId) => engine.retryFileErrors(pairId));
  withPair("sync:clear-file-errors", (pairId) => engine.clearFileErrors(pairId));

  // A large local deletion held back from the cloud: the user decides.
  withPair("sync:confirm-pending-deletion", (pairId) => engine.confirmPendingDeletion(pairId));
  withPair("sync:dismiss-pending-deletion", (pairId) => engine.dismissPendingDeletion(pairId));

  // Forward engine events to renderer.
  //
  // Only windows the user can actually see. A hidden or minimized window used
  // to keep committing React trees at the status rate (DSK-003); the renderer
  // pulls a fresh snapshot on "show" instead (sync-store's init/refresh).
  function broadcast(channel: string, data: unknown): void {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!shouldReceiveStatus(win)) continue;
      win.webContents.send(channel, data);
    }
  }

  // Conflict events must still be delivered. "conflict-detected" and "error"
  // are one-shot and the renderer must not miss them while hidden, so they
  // stay on the unconditional path - only destroyed windows are skipped.
  function broadcastAlways(channel: string, data: unknown): void {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send(channel, data);
    }
  }

  engine.on("status-changed", (status) => broadcast("sync:status-changed", status));
  engine.on("conflict-detected", (conflict) => broadcastAlways("sync:conflict-detected", conflict));
  engine.on("error", (err) => broadcastAlways("sync:error", err));
}
