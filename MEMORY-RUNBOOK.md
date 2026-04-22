# Memory Measurement Runbook — dosya.dev Desktop

This document describes how to reproduce the memory measurement scenarios for ongoing monitoring.

## Prerequisites

- Node.js + pnpm installed
- Development environment set up (`pnpm install` in repo root)

## Instrumentation Setup

### 1. Enable main process logger

Edit `src/main/index.ts`, add inside `app.whenReady().then(async () => {`:

```typescript
import { startMemoryLogger, stopMemoryLogger } from "./memory-logger";
startMemoryLogger("cold-idle"); // change per scenario
```

### 2. Enable renderer logger

Edit `src/renderer/main.tsx` (or `App.tsx`):

```typescript
import { startRendererMemoryLogger } from "./memory-logger-renderer";
startRendererMemoryLogger();
```

### 3. Build and run

```bash
cd apps/desktop
pnpm dev
```

## Scenarios

### Scenario 1: Cold Idle

1. Set logger to `startMemoryLogger("cold-idle")`
2. Launch the app
3. Do nothing — let it sit for 5 minutes
4. Check `memory-logs/cold-idle.log`

**What to look for:** RSS should stabilize within 60s. No growth after stabilization indicates no idle-state leaks.

### Scenario 2: Typical Use

1. Set logger to `startMemoryLogger("typical-use")`
2. Launch the app
3. Add a sync pair with ~100 files
4. Wait for initial sync to complete
5. Modify 5 files locally, wait for sync
6. Navigate between pages (Dashboard, Files, Sync, Activity, Profile)
7. Total time: ~10 minutes
8. Check `memory-logs/typical-use.log`

**What to look for:** RSS should rise during sync, then return near baseline within 2 minutes of idle.

### Scenario 3: Stress

1. Set logger to `startMemoryLogger("stress")`
2. Launch the app
3. Add a sync pair with a folder containing 5000+ files
4. Wait for initial scan and upload
5. Trigger "Sync Now" 3 times
6. Let it idle for 5 minutes
7. Check `memory-logs/stress.log`

**What to look for:**
- Peak RSS during batch operations
- RSS after 5 minutes idle vs. t=0
- If RSS after idle is >2x startup RSS, investigate with heap snapshot

## Heap Snapshot (Renderer)

1. Open DevTools (`Cmd+Option+I` or `View > Toggle Developer Tools`)
2. Go to **Memory** tab
3. Take snapshot S1 (immediately after load)
4. Perform the typical-use scenario
5. Take snapshot S2
6. Repeat the flow 10 times
7. Force GC (click the trash can icon in DevTools Memory tab)
8. Take snapshot S3
9. Use **Comparison** view between S1 and S3
10. Report top 15 constructors by retained size delta

## Interpreting Results

### Healthy patterns
- RSS stabilizes after initial load (~150-300MB for Electron)
- HeapUsed grows during sync, returns to baseline after
- DOM node count stays under 5000
- No growth slope after 5 minutes idle

### Warning signs
- RSS grows linearly over time even when idle → main process leak
- HeapUsed grows but never returns to baseline → retained references
- DOM nodes grow with navigation → detached DOM trees
- Multiple `Window` or `Document` objects in heap → renderer leak

## Log format

The CSV log has these columns:

```
elapsed_s,main_rss_mb,main_heapUsed_mb,main_heapTotal_mb,main_external_mb,
main_arrayBuffers_mb,window_count,webcontents_count,
app_metrics_total_memory_mb,app_metrics_total_cpu_pct,per_process_details
```

## Automating

To run measurements in CI or on a schedule, build the app and launch with:

```bash
MEMORY_SCENARIO=cold-idle pnpm dev
```

Then add conditional instrumentation:

```typescript
const scenario = process.env.MEMORY_SCENARIO;
if (scenario) {
  startMemoryLogger(scenario);
  // Auto-stop after 30 minutes
  setTimeout(() => {
    stopMemoryLogger();
    app.quit();
  }, 30 * 60 * 1000);
}
```
