import { useEffect, useState } from "react";

/** Mirrors `Distribution` in src/main/distribution.ts, as the IPC delivers it. */
export type RendererDistribution = "direct" | "ms-store" | "snap" | "mas";

let cached: Promise<RendererDistribution> | null = null;

/**
 * The channel this install came from, asked of the main process once per
 * renderer and shared by every surface that branches on it. An older preload
 * without the channel, or any failure, reads as the direct download: the
 * surfaces that differ are all reductions, and a direct build shows everything.
 */
export function loadDistribution(): Promise<RendererDistribution> {
  if (!cached) {
    const ask = window.electronAPI?.getDistribution;
    cached = (ask ? ask() : Promise.resolve("direct"))
      .then((d) => (d === "ms-store" || d === "snap" || d === "mas" ? d : "direct"))
      .catch(() => "direct" as const);
  }
  return cached;
}

export function useDistribution(): RendererDistribution | null {
  const [distribution, setDistribution] = useState<RendererDistribution | null>(null);
  useEffect(() => {
    let live = true;
    loadDistribution().then((d) => {
      if (live) setDistribution(d);
    });
    return () => {
      live = false;
    };
  }, []);
  return distribution;
}

/** Tests only. */
export function __resetDistributionCache(): void {
  cached = null;
}
