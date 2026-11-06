/**
 * The largest box with `ratio` (width / height) that fits hostW x hostH,
 * rounded to whole pixels. null when the host has no definite height: the
 * root then falls back to its CSS rule (full width, aspect-ratio height).
 */
export function fitBox(hostW: number, hostH: number, ratio: number): { width: number; height: number } | null {
  if (hostH <= 0 || hostW <= 0 || !(ratio > 0) || !Number.isFinite(ratio)) return null;
  const width = Math.min(hostW, hostH * ratio);
  return { width: Math.round(width), height: Math.round(width / ratio) };
}
