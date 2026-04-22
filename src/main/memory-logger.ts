/**
 * Memory instrumentation for the main process.
 * Import and call `startMemoryLogger()` in index.ts after app.whenReady().
 * Logs to ./memory-logs/<scenario>.log every 15 seconds.
 *
 * Usage:
 *   import { startMemoryLogger, stopMemoryLogger } from "./memory-logger";
 *   startMemoryLogger("cold-idle");  // or "typical-use", "stress"
 *   // ... run scenario ...
 *   stopMemoryLogger();
 */

import { app, BrowserWindow, webContents } from "electron";
import { appendFileSync, writeFileSync } from "fs";
import { join } from "path";

let timer: ReturnType<typeof setInterval> | null = null;
let logPath = "";
let startTime = 0;

export function startMemoryLogger(scenario: string): void {
  if (timer) stopMemoryLogger();

  logPath = join(__dirname, "../../memory-logs", `${scenario}.log`);
  startTime = Date.now();

  // Write CSV header
  writeFileSync(
    logPath,
    [
      "elapsed_s",
      "main_rss_mb",
      "main_heapUsed_mb",
      "main_heapTotal_mb",
      "main_external_mb",
      "main_arrayBuffers_mb",
      "window_count",
      "webcontents_count",
      "app_metrics_total_memory_mb",
      "app_metrics_total_cpu_pct",
      "per_process_details",
    ].join(",") + "\n",
    "utf-8",
  );

  // Log immediately, then every 15s
  logSnapshot();
  timer = setInterval(logSnapshot, 15_000);

  console.log(`[memory-logger] Started logging to ${logPath}`);
}

export function stopMemoryLogger(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  console.log(`[memory-logger] Stopped. Log: ${logPath}`);
}

function logSnapshot(): void {
  const elapsed = Math.round((Date.now() - startTime) / 1000);
  const mem = process.memoryUsage();
  const toMB = (b: number) => (b / 1024 / 1024).toFixed(2);

  const windowCount = BrowserWindow.getAllWindows().length;
  const wcCount = webContents.getAllWebContents().length;

  // app.getAppMetrics() gives per-process breakdown
  const metrics = app.getAppMetrics();
  let totalMemoryKB = 0;
  let totalCpuPct = 0;
  const perProcess: string[] = [];

  for (const m of metrics) {
    const memKB = m.memory.workingSetSize;
    totalMemoryKB += memKB;
    totalCpuPct += m.cpu.percentCPUUsage;
    perProcess.push(
      `${m.type}(pid=${m.pid}):${(memKB / 1024).toFixed(1)}MB/${m.cpu.percentCPUUsage.toFixed(1)}%cpu`,
    );
  }

  const line = [
    elapsed,
    toMB(mem.rss),
    toMB(mem.heapUsed),
    toMB(mem.heapTotal),
    toMB(mem.external),
    toMB(mem.arrayBuffers),
    windowCount,
    wcCount,
    (totalMemoryKB / 1024).toFixed(2),
    totalCpuPct.toFixed(2),
    `"${perProcess.join("; ")}"`,
  ].join(",");

  appendFileSync(logPath, line + "\n", "utf-8");
}
