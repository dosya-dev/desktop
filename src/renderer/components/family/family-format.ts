// apps/desktop/src/renderer/components/family/family-format.ts
import { GB } from "@/lib/family-api";
import { formatters } from "@/lib/i18n";

/** The unit the active language writes for a gigabyte ("GB", "Go" in French). */
export function gbUnit(): string {
  return formatters().formatBytes(GB).split(" ").pop() ?? "GB";
}

/**
 * The number part of formatGigabytes, without the unit: whole GB, grouped the
 * way the language groups. For "184 of 200 GB", so both figures in one
 * sentence agree.
 */
export function gigabyteFigure(bytes: number): string {
  return formatters().formatNumber(Math.round(bytes / GB));
}

/** Whole GB ("1,234 GB"); under a gigabyte, the usual size ("512.0 MB"). Reservations are whole GB, so this is how they read. */
export function formatGigabytes(bytes: number): string {
  if (bytes < GB) return formatters().formatBytes(bytes);
  return `${gigabyteFigure(bytes)} ${gbUnit()}`;
}

/** Whole GB as a size; 0 stays "0 GB" (formatGigabytes would fall back to bytes). */
export function sizeGb(gb: number): string {
  return gb >= 1 ? formatGigabytes(gb * GB) : `0 ${gbUnit()}`;
}
