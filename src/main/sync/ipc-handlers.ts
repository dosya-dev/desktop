import { ipcMain, dialog, shell, BrowserWindow } from "electron";
import { isAbsolute } from "path";
import type { SyncEngine } from "./index";
import type { SyncPair, SyncMode } from "./types";

const VALID_SYNC_MODES: SyncMode[] = ["two-way", "push", "push-safe", "pull", "pull-safe"];
const VALID_CONFLICT_STRATEGIES = ["last-write-wins", "keep-both"];
const VALID_RESOLUTIONS = ["keep-local", "keep-remote", "keep-both"];

function assertString(val: unknown, name: string): asserts val is string {
  if (typeof val !== "string" || val.length === 0 || val.length > 1000) {
    throw new Error(`Invalid ${name}: must be a non-empty string`);
  }
}

export function registerSyncIpcHandlers(engine: SyncEngine): void {
  ipcMain.handle("sync:get-config", () => engine.getConfig());

  ipcMain.handle("sync:save-config", (_e, updates) => {
    if (typeof updates !== "object" || updates === null) {
      throw new Error("Invalid config updates");
    }
    return engine.saveGlobalConfig(updates);
  });

  ipcMain.handle("sync:get-status", () => engine.getStatus());

  ipcMain.handle("sync:add-pair", async (_e, opts: Omit<SyncPair, "id" | "createdAt">) => {
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
      conflictStrategy: opts.conflictStrategy || "last-write-wins",
      selectiveFolders: Array.isArray(opts.selectiveFolders) ? opts.selectiveFolders : [],
      excludedPatterns,
      enabled: opts.enabled !== false,
    };
    await engine.addPair(pair);
    return pair;
  });

  ipcMain.handle("sync:remove-pair", (_e, { pairId }) => {
    assertString(pairId, "pairId");
    return engine.removePair(pairId);
  });

  ipcMain.handle("sync:update-pair", (_e, { pairId, updates }) => {
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
    return engine.updatePair(pairId, updates);
  });

  ipcMain.handle("sync:pick-local-folder", async () => {
    const win = BrowserWindow.getFocusedWindow();
    if (!win) return null;
    const result = await dialog.showOpenDialog(win, {
      properties: ["openDirectory", "createDirectory"],
      title: "Select sync folder",
    });
    return result.canceled ? null : result.filePaths[0] ?? null;
  });

  ipcMain.handle("sync:get-folder-tree", async (_e, { workspaceId }) => {
    assertString(workspaceId, "workspaceId");
    const client = engine.getClient();
    return client.getFolderTree(workspaceId);
  });

  ipcMain.handle("sync:pause-pair", (_e, { pairId }) => {
    assertString(pairId, "pairId");
    return engine.pausePair(pairId);
  });
  ipcMain.handle("sync:resume-pair", (_e, { pairId }) => {
    assertString(pairId, "pairId");
    return engine.resumePair(pairId);
  });
  ipcMain.handle("sync:pause-all", () => engine.pauseAll());
  ipcMain.handle("sync:resume-all", () => engine.resumeAll());
  ipcMain.handle("sync:sync-now", (_e, { pairId }) => {
    assertString(pairId, "pairId");
    return engine.syncNow(pairId);
  });

  ipcMain.handle("sync:resolve-conflict", (_e, { conflictId, resolution }) => {
    assertString(conflictId, "conflictId");
    assertString(resolution, "resolution");
    if (!VALID_RESOLUTIONS.includes(resolution)) {
      throw new Error(`Invalid resolution: ${resolution}. Must be one of: ${VALID_RESOLUTIONS.join(", ")}`);
    }
    return engine.resolveConflict(conflictId, resolution as "keep-local" | "keep-remote" | "keep-both");
  });

  ipcMain.handle("sync:open-sync-folder", async (_e, { pairId }) => {
    assertString(pairId, "pairId");
    const config = await engine.getConfig();
    const pair = config.pairs.find((p) => p.id === pairId);
    if (pair) shell.openPath(pair.localPath);
  });

  ipcMain.handle("sync:get-conflicts", () => engine.getConflicts());

  // Forward engine events to renderer
  engine.on("status-changed", (status) => {
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send("sync:status-changed", status);
    }
  });

  engine.on("conflict-detected", (conflict) => {
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send("sync:conflict-detected", conflict);
    }
  });

  engine.on("error", (err) => {
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send("sync:error", err);
    }
  });
}
