import { formatBytes } from "@dosya-dev/shared";

export { formatBytes };

export function formatDate(ts: number | string): string {
  const d = typeof ts === "number" ? new Date(ts * 1000) : new Date(ts);
  return d.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

export function formatRelative(ts: number | string): string {
  const d = typeof ts === "number" ? new Date(ts * 1000) : new Date(ts);
  const now = Date.now();
  const diff = now - d.getTime();
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return formatDate(ts);
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
