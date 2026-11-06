// Node-safe on purpose: locale-state, not i18n.tsx (React + JSON catalogs),
// so modules that node:test loads (file-columns -> format) can import this.
import { getActiveLocale, intlLocale, tl } from "./locale-state";
export { intlLocale };
import { formatBytes as bytesIn, formatRelative as relative } from "../../i18n/translator";

/** "1.5 KB" (en), "1,5 KB" (de), "1,5 Ko" (fr), following the chosen language. */
export function formatBytes(bytes: number): string {
  return bytesIn(getActiveLocale(), bytes);
}

export function formatDate(ts: number | string): string {
  const d = typeof ts === "number" ? new Date(ts * 1000) : new Date(ts);
  return d.toLocaleDateString(intlLocale(), {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

export function formatRelative(ts: number | string): string {
  return relative(getActiveLocale(), ts, tl);
}

export function fileIcon(ext: string | null): string {
  if (!ext) return "file";
  const map: Record<string, string> = {
    pdf: "pdf", doc: "doc", docx: "doc", xls: "xls", xlsx: "xls",
    ppt: "ppt", pptx: "ppt", txt: "txt", csv: "csv", sql: "sql",
    jpg: "jpg", jpeg: "jpg", png: "png", gif: "gif", svg: "svg",
    mp4: "mp4", avi: "avi", mov: "mov", mp3: "mp3",
    zip: "zip", rar: "zip", "7z": "zip", tar: "zip", gz: "zip",
    js: "js", ts: "js", jsx: "js", tsx: "js", php: "php", java: "java",
    exe: "exe", apk: "apk", iso: "iso",
  };
  return map[ext.toLowerCase()] ?? "file";
}
