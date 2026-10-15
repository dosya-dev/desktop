import type { RendererDistribution } from "./use-distribution";

/** Guideline 3.1.1: no external purchase link in a Mac App Store app. Nothing is sold in-app. */
export function showsBillingTab(distribution: RendererDistribution | null): boolean {
  return distribution !== "mas";
}

/** Every store delivers its own updates; the updater reports "store-managed" there. */
export function showsUpdateControls(distribution: RendererDistribution | null): boolean {
  return distribution === null || distribution === "direct";
}
