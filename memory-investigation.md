# Memory Investigation — dosya.dev Desktop

## Project Context

| Field | Value |
|---|---|
| App name | dosya.dev desktop |
| Electron version | 34.5.8 |
| Node version (bundled) | 20.x (Electron 34) |
| Chromium version | 132 (Electron 34) |
| Renderer framework | React 19.0.0 |
| State management | Zustand 5.0.3 + TanStack React Query 5.72.2 |
| BrowserWindows | 1 main + 1 transient OAuth popup |
| Target OS | macOS, Windows, Linux |

---

## Phase 1: Baseline Measurement

### Instrumentation

Two logger modules have been created:

- **Main process**: `src/main/memory-logger.ts`
- **Renderer**: `src/renderer/memory-logger-renderer.ts`

#### How to enable

**Main process** — add to `src/main/index.ts` after `app.whenReady()`:

```typescript
import { startMemoryLogger } from "./memory-logger";

// Inside app.whenReady().then(async () => {
startMemoryLogger("cold-idle"); // or "typical-use" or "stress"
```

**Renderer** — add to `src/renderer/main.tsx` or `App.tsx`:

```typescript
import { startRendererMemoryLogger } from "./memory-logger-renderer";
if (import.meta.env.DEV) startRendererMemoryLogger();
```

#### Scenarios to capture

| Scenario | Steps | Log file |
|---|---|---|
| `cold-idle` | Launch app, sit idle 5 minutes | `memory-logs/cold-idle.log` |
| `typical-use` | Launch, add a sync pair with ~100 files, wait for sync to complete | `memory-logs/typical-use.log` |
| `stress` | Launch, sync a folder with 5K+ files, repeat sync 3x, idle 5 minutes | `memory-logs/stress.log` |

### Baseline Table

**Status: AWAITING USER DATA**

| Process | t=0 | t=5min | t=15min | t=30min | Growth slope |
|---|---|---|---|---|---|
| Main (RSS) | — | — | — | — | — |
| Main (heap) | — | — | — | — | — |
| Renderer (JSHeap) | — | — | — | — | — |
| GPU | — | — | — | — | — |

> Run the three scenarios with the instrumentation above and paste the logs here before proceeding to fixes.

---

## Phase 2: Process-Level Audit

### 2a. Main Process

#### Window lifecycle

| Window | Creation | Disposal | Status |
|---|---|---|---|
| `mainWindow` | `index.ts:60` | Hidden on close (`index.ts:100-105`), destroyed on app quit | OK — single persistent window |
| OAuth popup | `ipc.ts:104` | `popup.close()` in `done()` at `ipc.ts:141`, plus `popup.on("closed")` handler at `ipc.ts:182` | OK — all paths resolve and close |

No `BrowserView` or `webContents.loadURL` without disposal found.

#### IPC handlers

All `ipcMain.handle` and `ipcMain.on` calls are registered once at module load time in:
- `ipc.ts:34-273` (window controls, auth, file ops, notifications)
- `sync/ipc-handlers.ts:17-161` (sync operations)
- `updater.ts:29-125` (auto-updater)

**Finding:** No runtime-registered handlers. No duplicate registration risk. All handlers are registered once and persist for the app lifetime. **OK.**

#### Event emitters

| Registration | File:Line | Removal path | Status |
|---|---|---|---|
| `session.defaultSession.cookies.on("changed")` | `index.ts:199`, `session.ts:89` | App lifetime — no removal needed | OK |
| `powerMonitor.on("suspend"/"resume")` | `index.ts:218-229` | App lifetime | OK |
| `app.on("activate"/"window-all-closed"/"before-quit"/"second-instance"/"open-url")` | `index.ts:54,142,231,242,247` | App lifetime | OK |
| `syncEngine.on("status-changed"/"conflict-detected"/"error")` | `ipc-handlers.ts:158-160`, `tray.ts:143` | Engine lifetime (same as app) | OK |
| `autoUpdater.on(...)` (6 handlers) | `updater.ts:50-83` | App lifetime | OK |

**No dangling listeners found.** All listeners are app-lifetime scoped.

#### Timers

| Timer | File:Line | Cleanup | Status |
|---|---|---|---|
| `recoveryTimer = setInterval(checkRecovery, 30s)` | `sync/index.ts:160` | `clearInterval` in `stop()` at line 172 | OK |
| `statusTimer = setTimeout(..., 500)` | `sync/index.ts:1585` | `clearTimeout` in `stop()` at line 176 | OK |
| `rateLimitResumeTimer = setTimeout(...)` | `sync/index.ts:251` | `clearTimeout` in `stop()`:183, `stopPair()`:514, `pausePair()`:1453 | OK |
| `debounceTimer/maxWaitTimer` in LocalWatcher | `local-watcher.ts:155-156` | `clearTimeout` in `stop()`:258-259 | OK |
| `poller.timer = setInterval(poll, ...)` | `remote-poller.ts:39` | `clearInterval` in `stop()`:44 | OK |
| `setTimeout(autoUpdater.checkForUpdates, 5s)` | `updater.ts:116` | Fire-and-forget, one-shot | OK |
| `loadTimeout = setTimeout(60s)` in OAuth | `ipc.ts:129` | `clearTimeout` in `done()`:136 | OK |

**No leaked timers found.**

#### Child processes

No `utilityProcess.fork`, `child_process.fork/spawn`, or `Worker` usage in the main process.

#### Session and cache

- `session.defaultSession` is used for cookie management only.
- `clearSessionCookie()` (`session.ts:112-123`) calls both `clearStorageData()` and `clearCache()` on logout. **OK.**
- No `disk-cache-size` command-line switch is set. **Recommendation:** Consider bounding it for long-running sync sessions.
- No `session.setSpellCheckerLanguages` call found.

#### Singletons with state at module scope

| Singleton | File | Growth pattern | Status |
|---|---|---|---|
| `SyncEngine.runtimes` (Map) | `sync/index.ts:115` | Bounded by number of sync pairs (user-configured, typically 1-5) | OK |
| `SyncEngine.activeTransfers` (Set) | `sync/index.ts:116` | Bounded by semaphore capacity (default 3) | OK |
| `SyncEngine.conflicts` (array) | `sync/index.ts:118` | Grows with unresolved conflicts. Cleared on pair removal. | **LOW RISK** — conflicts are rare |
| `SyncEngine.recentDownloads` (Map) | `sync/index.ts:121` | **See Finding 1** | **MEDIUM RISK** |
| `SyncEngine.pendingSyncFlagIds` (array) | `sync/index.ts:134` | Flushed at end of scan/reconcile via `splice(0)` | OK |
| `PairRuntime.state.files` (Record) | `sync/types.ts:84` | Grows with tracked file count. Can be 50K+ entries. | **BY DESIGN** — inherent to sync |
| `PairRuntime.state.fileErrors` (Record) | `sync/types.ts:86` | Grows with failed files. Cleaned on successful retry. Permanent errors stay. | **LOW RISK** |
| `PairRuntime.pathIndex` (Map) | `sync/index.ts:75` | Mirror of `state.files`. Same size. | **BY DESIGN** |
| `RemotePoller.lastSnapshotHash` (string) | `remote-poller.ts:21` | Single string | OK |
| `RemoteClient.cachedCookie` | `remote-client.ts:64` | Single string, TTL 60s | OK |
| `updateStatus` | `updater.ts:12` | Single object | OK |
| `tray` | `tray.ts:7` | Single Tray | OK |

#### Native modules

| Module | Purpose | Memory behavior | Status |
|---|---|---|---|
| `chokidar` 4.0.3 | File watching | Uses fsevents (macOS, 1 fd) or inotify (Linux, 1 watch per dir). Properly closed in `stop()`. | OK |
| `graceful-fs` 4.2.11 | EMFILE mitigation | Patches `fs` module, minimal memory overhead | OK |
| `electron-updater` 6.3.9 | Auto-updates | Downloads update file to temp. Single-use. | OK |

No `better-sqlite3`, `sharp`, `node-ffi`, `keytar`, or other native addons found.

### 2b. Renderer Process

#### Heap snapshot analysis

**Status: AWAITING USER DATA** — requires running the app with DevTools open.

#### Renderer source audit

| Pattern | Files checked | Issues found |
|---|---|---|
| `addEventListener` without `removeEventListener` | All renderer `.ts`/`.tsx` | **None** — all IPC subscriptions return cleanup functions |
| `useEffect` without cleanup | All pages + components | **None** — all effects with subscriptions have cleanup |
| Zustand subscriptions | `sync-store.ts` | `init()` returns cleanup function with `unsub1()` + `unsub2()`. Called in `SyncPage.tsx:52-55`. **OK** |
| React Query cache | `query-client.ts` | Default `gcTime` (5min), `staleTime` 30s, `queryClient.clear()` on logout. **OK** |
| `URL.createObjectURL` | `ProfilePage.tsx:533-536` | Paired with `revokeObjectURL`. **OK** |
| Observers (Mutation/Resize/Intersection) | All renderer | **None used** |
| WebSocket/EventSource | All renderer | **None used** |
| Web Workers | All renderer | **None used** |
| `requestAnimationFrame` | All renderer | **None used** |
| Module-scope caches | All renderer | **None** — all state is React state or Zustand stores |
| Detached DOM nodes | — | **Requires heap snapshot** |

**Renderer verdict: Clean.** No leaks found in source audit.

### 2c. IPC Layer

#### IPC volume analysis

| Channel | Frequency | Payload size | Status |
|---|---|---|---|
| `sync:status-changed` | Throttled to max 2/s (`emitStatus` 500ms throttle) | Full `SyncStatus` object (pairs + activeTransfers + conflicts) | **See Finding 2** |
| `sync:conflict-detected` | Rare (only on conflicts) | Single `SyncConflict` object (~200 bytes) | OK |
| `sync:error` | Rare | `{ pairId, message }` (~100 bytes) | OK |
| `updater:status-changed` | Rare (during update checks) | `UpdateStatus` object (~100 bytes) | OK |
| `navigate` | Rare (tray/protocol clicks) | String path (~50 bytes) | OK |

**Finding:** `sync:status-changed` is the highest-volume channel. During a 5K-file sync, it fires ~2/s with the full status object including `[...this.activeTransfers]` spread copies. See Finding 2.

#### IPC handler registration in components

All `ipcRenderer.on` registrations in the preload (`preload/index.ts:45-90`) return cleanup functions. The renderer components properly call these cleanup functions in `useEffect` return callbacks. **OK.**

### 2d. Preload Scripts

- `preload/index.ts` is minimal — only wraps `ipcRenderer.invoke` and `ipcRenderer.on` calls.
- No DOM references retained.
- No large state in closures. Each `contextBridge.exposeInMainWorld` function is a thin wrapper.
- **OK.**

---

## Phase 3: Configuration Audit

| Setting | Current | Recommended | Notes |
|---|---|---|---|
| `webPreferences.backgroundThrottling` | `true` (default) | `true` | OK — renderer throttled when hidden |
| `webPreferences.contextIsolation` | `true` | `true` | OK |
| `webPreferences.sandbox` | `true` | `true` | OK |
| `webPreferences.nodeIntegration` | `false` | `false` | OK |
| `webPreferences.spellcheck` | `true` (default) | `false` | Not used — dictionary memory can be freed |
| `webPreferences.webSecurity` | `false` | `false` | Needed for cross-origin API calls. Mitigated. |
| V8 `--max-old-space-size` | default | default | OK |
| Chromium `--disk-cache-size` | unbounded (default) | Bounded | App runs indefinitely in tray; cache can grow |
| DevTools in production | disabled (no explicit open) | disabled | OK |

**Additional checks:**
- Only 1 `BrowserWindow` (plus transient OAuth popup). Single-window design is efficient.
- No `app.commandLine.appendSwitch` calls for feature disabling.
- No DevTools extensions loaded in production.
- CSP is set in production via `session.ts:36-47`.

---

## Phase 4: Dependency Audit

### Duplicated dependencies

No major dependency duplication detected. Key deps:
- React 19.0.0 (single copy)
- React Router 7.4.0 (single copy)
- Zustand 5.0.3 (single copy)
- TanStack React Query 5.72.2 (single copy)

### Dev-only dependencies in production

- `@playwright/test`, `@types/*`, `electron-builder`, `cross-env` are in `devDependencies`. **OK.**
- `electron` is in `devDependencies`. **OK** — Electron is the runtime, not bundled.

### Native addon analysis

| Addon | Disposal API | Status |
|---|---|---|
| `chokidar` | `watcher.close()` | Called in `LocalWatcher.stop()` |
| `graceful-fs` | N/A (patches fs) | No disposal needed |
| `electron-updater` | N/A | Managed by Electron lifecycle |

### Bundle size

**Requires running:** `npx electron-vite build && npx vite-bundle-visualizer` (or equivalent) to get per-module breakdown. Not available from source analysis alone.

---

## Phase 5: Findings Report

### Finding 1: `recentDownloads` Map has no periodic cleanup

**Severity: low**

**Evidence:**
- `sync/index.ts:121` — `private recentDownloads = new Map<string, number>()`
- Entries added at `sync/index.ts:310-312` (`markRecentDownload`)
- Entries removed lazily at `sync/index.ts:314-321` (`isRecentDownload`) — only when checked
- `stop()` at `sync/index.ts:169-193` does NOT clear `recentDownloads`
- No periodic sweep exists

**Root cause:** Downloaded file paths are stored with a timestamp (TTL 10s). Entries are only removed when `isRecentDownload()` is called for the same path. In push-safe mode (no local watcher events trigger `isRecentDownload`), or when downloads far outnumber watcher events, entries accumulate. The map is never proactively swept or cleared on `stop()`.

**Affected files:**
- `apps/desktop/src/main/sync/index.ts:121,310-321,169-193`

**Fix (proposed):**
```typescript
// In stop():
this.recentDownloads.clear();

// Add periodic cleanup in start():
this.recentDownloadSweepTimer = setInterval(() => {
  const now = Date.now();
  for (const [path, ts] of this.recentDownloads) {
    if (now - ts > RECENT_DOWNLOAD_TTL_MS) {
      this.recentDownloads.delete(path);
    }
  }
}, RECENT_DOWNLOAD_TTL_MS * 2);
```

**Verification plan:**
- Re-run stress scenario (5K file sync)
- Monitor `recentDownloads.size` after sync completes
- Expected: map size should drop to 0 within 20s of idle

**Risk:** None — purely additive cleanup.

---

### Finding 2: `getStatus()` creates copies of all active transfers on every emission

**Severity: low**

**Evidence:**
- `sync/index.ts:1383-1387` — `getStatus()` spreads `activeTransfers` and `conflicts` into new arrays
- `sync/index.ts:1576-1592` — `emitStatus()` throttled to 500ms but still calls `getStatus()` which allocates new objects
- `ipc-handlers.ts:158` — every emission triggers `broadcast()` which serializes via IPC
- During a 5K-file sync with 3 concurrent transfers, this creates ~2 full `SyncStatus` objects per second, each serialized to JSON for IPC

**Root cause:** `emitStatus()` calls `getStatus()` which builds a full snapshot. During batch operations, this runs frequently. Each call creates new arrays from `[...this.activeTransfers]` and spread copies of pair status. The IPC layer then serializes the entire object via structured clone.

**Affected files:**
- `apps/desktop/src/main/sync/index.ts:1360-1392,1576-1592`

**Fix (proposed):**
```typescript
// Instead of spreading in getStatus(), cache the status object.
// Only rebuild if data actually changed (dirty flag already exists).
private cachedStatus: SyncStatus | null = null;

private emitStatus(): void {
  if (this.statusTimer) {
    this.statusDirty = true;
    return;
  }
  this.cachedStatus = null; // invalidate cache
  const status = this.getStatus();
  this.emit("status-changed", status);
  this.statusTimer = setTimeout(() => {
    this.statusTimer = null;
    if (this.statusDirty) {
      this.statusDirty = false;
      this.cachedStatus = null;
      this.emit("status-changed", this.getStatus());
    }
  }, 500);
}
```

**Verification plan:**
- Profile IPC payload sizes during a large sync
- Expected: no change in behavior, but fewer allocations between emissions

**Risk:** Low — caching may show slightly stale data in edge cases, but the 500ms throttle already introduces staleness.

---

### Finding 3: Tray menu rebuilt on every status-changed event

**Severity: low**

**Evidence:**
- `tray.ts:143` — `syncEngine.on("status-changed", (status) => buildMenu(status))`
- `tray.ts:25-136` — `buildMenu()` calls `Menu.buildFromTemplate()` which creates native menu objects
- During active sync, this fires every 500ms (throttle interval)
- Each call creates a new native `Menu` object; old ones depend on Chromium GC

**Root cause:** `Menu.buildFromTemplate()` allocates native (C++) menu objects. Electron handles cleanup of previous menus when `setContextMenu()` is called, but during rapid rebuilds (2/s), the GC pressure on native objects can cause memory spikes until Chromium's GC cycle runs.

**Affected files:**
- `apps/desktop/src/main/tray.ts:25-153`

**Fix (proposed):**
```typescript
// Throttle tray menu rebuild separately — no need to rebuild faster than 2s
let trayRebuildTimer: ReturnType<typeof setTimeout> | null = null;
let pendingStatus: SyncStatus | null = null;

syncEngine.on("status-changed", (status: SyncStatus) => {
  pendingStatus = status;
  if (!trayRebuildTimer) {
    trayRebuildTimer = setTimeout(() => {
      trayRebuildTimer = null;
      if (pendingStatus) {
        buildMenu(pendingStatus);
        pendingStatus = null;
      }
    }, 2000);
  }
});
```

**Verification plan:**
- Monitor native memory (via `app.getAppMetrics()`) during a large sync
- Expected: smoother memory curve, fewer native allocation spikes

**Risk:** Tray menu shows status up to 2s stale. Acceptable since the tray is not the primary UI.

---

### Finding 4: `webPreferences.spellcheck` is not explicitly disabled

**Severity: low**

**Evidence:**
- `index.ts:79-92` — `webPreferences` does not set `spellcheck: false`
- Electron 34 defaults `spellcheck` to `true`
- Spellcheck dictionaries (Hunspell) load ~2-5MB per language into the renderer process
- This app is a file sync/management tool — spellcheck provides no value

**Root cause:** Default Electron behavior loads spellcheck dictionaries into renderer memory even when the app has no text editing surfaces that benefit from it.

**Affected files:**
- `apps/desktop/src/main/index.ts:79-92`

**Fix (proposed):**
```typescript
webPreferences: {
  preload: join(__dirname, "../preload/index.js"),
  contextIsolation: true,
  nodeIntegration: false,
  sandbox: true,
  spellcheck: false,  // ← add this
  webSecurity: false,
},
```

**Verification plan:**
- Compare renderer process memory at t=0 with/without spellcheck
- Expected: ~2-5MB reduction in renderer RSS

**Risk:** None — no text editing in this app.

---

### Finding 5: Disk cache unbounded for long-running app

**Severity: low**

**Evidence:**
- No `--disk-cache-size` command-line switch set
- App runs indefinitely in tray for sync, potentially for days/weeks
- Default Chromium disk cache can grow to 250MB+ over time
- `session.clearCache()` is only called on logout (`session.ts:122`)

**Root cause:** Chromium's HTTP cache grows unbounded while the app runs. For a sync-focused app that doesn't browse the web, this cache holds very little useful data but consumes disk and some memory for cache indices.

**Affected files:**
- `apps/desktop/src/main/index.ts` (no switch set)

**Fix (proposed):**
```typescript
// In index.ts, before createWindow():
app.commandLine.appendSwitch("disk-cache-size", String(50 * 1024 * 1024)); // 50MB
```

**Verification plan:**
- Monitor disk usage in `~/.config/dosya/Cache` (or equivalent) over 24h
- Expected: cache stays below 50MB

**Risk:** If the renderer loads large images or assets from the API, they may need to be re-fetched more often. Unlikely for this app's use case.

---

### Finding 6: Large state file JSON.stringify causes transient memory spikes

**Severity: medium (for 50K+ file syncs)**

**Evidence:**
- `sync/config.ts:89` — `JSON.stringify(state)` for compact (no pretty-print) output
- For 50K tracked files, `state.files` has 50K entries. Each entry ~200 bytes → ~10MB JSON string
- `savePairState` is called every 50 file operations (`STATE_SAVE_INTERVAL = 50`)
- During a 50K-file initial scan, this means ~1000 calls to `JSON.stringify()` creating ~10MB temporary strings
- V8 must allocate and GC these strings, causing heap pressure

**Root cause:** The entire pair state is serialized to JSON and written to disk on every 50th file operation. For large syncs, this creates large transient allocations that spike `heapUsed`.

**Affected files:**
- `apps/desktop/src/main/sync/config.ts:84-90`
- `apps/desktop/src/main/sync/index.ts:59` (`STATE_SAVE_INTERVAL = 50`)

**Fix (proposed):**
Option A: Increase `STATE_SAVE_INTERVAL` for large syncs:
```typescript
// Adaptive save interval based on state size
const trackedFiles = Object.keys(rt.state.files).length;
const saveInterval = trackedFiles > 10000 ? 500 : trackedFiles > 1000 ? 200 : 50;
```

Option B: Use streaming JSON writer (e.g., write entries incrementally). This is a larger change.

**Verification plan:**
- Monitor `heapUsed` during a 50K-file sync
- Expected: fewer spikes in heap allocation, smoother curve

**Risk:** Increasing save interval means more data loss on crash. At 500 interval with 3 concurrent transfers, a crash could lose ~500 file records. Acceptable since the next scan will recover them.

---

### Unconfirmed Hypotheses

These require Phase 1 metrics to verify:

1. **Chokidar memory for large directory trees (Linux)** — On Linux, inotify watches consume kernel memory (~1KB per watch). A 10K-directory tree would use ~10MB kernel memory. Cannot verify without running on Linux.

2. **React Query cache growth** — With `staleTime: 30s` and `gcTime: 5min` (default), unused query data persists for 5 minutes. If many different workspace views are visited, cache could grow. Requires heap snapshot to verify.

3. **Electron IPC structured clone overhead** — Each `sync:status-changed` broadcast serializes the full status via structured clone. The serialization itself allocates memory in both main and renderer processes. Requires IPC payload measurement.

4. **OAuth popup residual memory** — After `popup.close()`, Chromium may retain renderer process memory briefly. Requires `app.getAppMetrics()` measurement before/after OAuth.

---

## Summary

| Finding | Severity | Memory impact | Fix complexity |
|---|---|---|---|
| F1: recentDownloads no cleanup | Low | ~1KB per download, accumulates | Trivial |
| F2: getStatus() copies on every emit | Low | ~1-5KB per emission, 2/s during sync | Low |
| F3: Tray menu rebuilt 2/s | Low | Native menu GC pressure | Low |
| F4: Spellcheck enabled by default | Low | ~2-5MB constant | Trivial |
| F5: Disk cache unbounded | Low | Disk + cache index memory | Trivial |
| F6: JSON.stringify spikes for large state | Medium | ~10MB transient per save for 50K files | Low |

**Overall assessment:** The codebase demonstrates strong memory management practices. No classic memory leaks (dangling listeners, unclosed handles, growing caches) were found. The findings are optimization opportunities rather than leak fixes. The most impactful issue is F6 (state serialization spikes) which only affects very large sync scenarios.

The renderer is clean — all subscriptions have cleanup, no observers or workers leak, React Query cache is bounded and cleared on logout.

The main process has good timer/listener hygiene. All intervals are cleared on stop, all event listeners are app-lifetime scoped.
