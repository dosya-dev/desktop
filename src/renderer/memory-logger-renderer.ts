/**
 * Renderer-side memory instrumentation.
 * Import and call `startRendererMemoryLogger()` in your renderer entry.
 * Logs to console (visible in DevTools) every 15 seconds.
 *
 * Usage in App.tsx or main.tsx:
 *   import { startRendererMemoryLogger } from "./memory-logger-renderer";
 *   if (import.meta.env.DEV) startRendererMemoryLogger();
 */

let timer: ReturnType<typeof setInterval> | null = null;
let startTime = 0;

export function startRendererMemoryLogger(): void {
  if (timer) stopRendererMemoryLogger();
  startTime = Date.now();

  logSnapshot();
  timer = setInterval(logSnapshot, 15_000);

  console.log("[memory-logger-renderer] Started");
}

export function stopRendererMemoryLogger(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

function logSnapshot(): void {
  const elapsed = Math.round((Date.now() - startTime) / 1000);
  const toMB = (b: number) => (b / 1024 / 1024).toFixed(2);

  // JS heap (Chromium-specific, may not be available in all contexts)
  const perf = (performance as any).memory;
  const jsHeap = perf
    ? {
        usedJSHeapSize: toMB(perf.usedJSHeapSize),
        totalJSHeapSize: toMB(perf.totalJSHeapSize),
        jsHeapSizeLimit: toMB(perf.jsHeapSizeLimit),
      }
    : { usedJSHeapSize: "N/A", totalJSHeapSize: "N/A", jsHeapSizeLimit: "N/A" };

  // DOM node count
  const domNodes = document.querySelectorAll("*").length;

  // Active event listeners (approximate — counts listeners on window and document)
  // Note: there's no native API for this; we count what we can.
  let listenerEstimate = "N/A";
  try {
    // Chrome DevTools protocol exposes getEventListeners, but not in regular code.
    // We rely on the DevTools Memory panel for accurate counts.
    listenerEstimate = "use DevTools";
  } catch {}

  console.table({
    elapsed_s: elapsed,
    usedJSHeap_MB: jsHeap.usedJSHeapSize,
    totalJSHeap_MB: jsHeap.totalJSHeapSize,
    heapLimit_MB: jsHeap.jsHeapSizeLimit,
    domNodes,
    eventListeners: listenerEstimate,
  });
}
