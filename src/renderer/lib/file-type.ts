// Ported from apps/web/src/lib/helpers.ts (subset) - keep in sync with the web copy.
// File-type detection + small formatting helpers used by the files surfaces.

export function extOf(name: string): string {
  return name.includes(".") ? name.split(".").pop()!.toLowerCase() : "";
}

const EXT_COLORS: Record<string, string> = {
  mp4: "#EF4444", mov: "#EF4444", avi: "#EF4444", mkv: "#EF4444", webm: "#EF4444",
  fig: "#7C3AED", sketch: "#7C3AED", xd: "#7C3AED",
  pdf: "#2563EB", doc: "#D97706", docx: "#D97706", pptx: "#D97706", ppt: "#D97706",
  xls: "#059669", xlsx: "#059669", csv: "#374151",
  zip: "#0891B2", rar: "#0891B2",
  png: "#059669", jpg: "#059669", jpeg: "#059669", gif: "#059669", svg: "#059669", webp: "#059669",
  heic: "#059669", heif: "#059669",
};

export function colorFor(name: string): string {
  return EXT_COLORS[extOf(name)] ?? "#706E69";
}

export function labelFor(name: string): string {
  const e = extOf(name);
  return e ? e.toUpperCase() : "FILE";
}

const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg", "ico", "heic", "heif"]);
export function isImage(name: string): boolean {
  return IMAGE_EXTS.has(extOf(name));
}

const HEIC_EXTS = new Set(["heic", "heif"]);
/** True only for HEIC/HEIF - the one image format Chromium can't render natively. */
export function isHeic(name: string): boolean {
  return HEIC_EXTS.has(extOf(name));
}

const VIDEO_EXTS = new Set(["mp4", "mov", "avi", "mkv", "webm", "wmv", "flv"]);
export function isVideo(name: string): boolean {
  return VIDEO_EXTS.has(extOf(name));
}

const TEXT_EXTS = new Set([
  "txt", "md", "json", "xml", "csv", "log", "yml", "yaml", "toml", "ini", "cfg",
  "js", "ts", "jsx", "tsx", "py", "rb", "go", "rs", "java", "kt", "c", "cpp", "h",
  "cs", "php", "swift", "sh", "bash", "zsh", "sql", "html", "css", "scss", "less",
  "env", "gitignore", "dockerfile", "makefile",
]);
export function isText(name: string): boolean {
  return TEXT_EXTS.has(extOf(name));
}

const AUDIO_EXTS = new Set(["mp3", "wav", "ogg", "flac", "aac", "m4a", "wma"]);
export function isAudio(name: string): boolean {
  return AUDIO_EXTS.has(extOf(name));
}

export function isPdf(name: string): boolean {
  return extOf(name) === "pdf";
}

export function isVcard(name: string): boolean {
  const e = extOf(name);
  return e === "vcf" || e === "vcard";
}

const OFFICE_EXTS = new Set([
  "docx", "xlsx", "pptx", "doc", "xls", "ppt", "odt", "ods", "odp", "rtf", "csv",
]);

// Files that open in the ONLYOFFICE editor at /editor/:fileId. Keep in sync
// with apps/web/src/lib/helpers.ts and apps/api/src/lib/onlyoffice/formats.ts.
export function isOfficeFile(name: string): boolean {
  return OFFICE_EXTS.has(extOf(name));
}

export function humanSize(b: number): string {
  if (b < 1024) return b + " B";
  if (b < 1048576) return (b / 1024).toFixed(0) + " KB";
  if (b < 1073741824) return (b / 1048576).toFixed(1) + " MB";
  return (b / 1073741824).toFixed(2) + " GB";
}

export function timeAgo(ts: number): string {
  const diff = Math.floor(Date.now() / 1000) - ts;
  if (diff < 60) return "just now";
  if (diff < 3600) return Math.floor(diff / 60) + "m ago";
  if (diff < 86400) return Math.floor(diff / 3600) + "h ago";
  if (diff < 604800) return Math.floor(diff / 86400) + "d ago";
  const d = new Date(ts * 1000);
  const m = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${m[d.getMonth()]} ${d.getDate()}`;
}

export function initials(name: string | null | undefined): string {
  const parts = (name ?? "").trim().split(/\s+/);
  return ((parts[0]?.[0] ?? "") + (parts[1]?.[0] ?? "")).toUpperCase() || "?";
}

const ORIGIN_LABELS: Record<string, string> = {
  web: "Web", desktop: "Desktop", mobile: "Mobile", cli: "CLI",
  webdav: "WebDAV", s3: "S3", ftp: "FTP", import: "Import",
};

export function originLabel(origin: string | null | undefined): string {
  return (origin && ORIGIN_LABELS[origin]) || "-";
}

// "Hidden" is never binary from the viewer's own perspective - if they can
// see the row at all, they're someone it's NOT hidden from. This names who
// ELSE it's hidden from, and warns that hidden items drop out of share
// links - it must never read as "hidden from you". Mirrors
// apps/web/src/lib/helpers.ts's hiddenTitle.
export function hiddenTitle(hiddenMode: string | null | undefined): string {
  return hiddenMode === "everyone"
    ? "Hidden from everyone. Not included in share links."
    : "Hidden from some people. Not included in share links.";
}

const REGION_LABELS: Record<string, string> = {
  "us-east-1": "US East", "us-west-1": "US West", "us-west-2": "US West 2",
  "eu-west-1": "EU West", "eu-central-1": "EU Central",
  "ap-southeast-1": "Singapore", "ap-southeast-2": "Sydney", "ap-northeast-1": "Tokyo",
  "sa-east-1": "Sao Paulo", "me-south-1": "Bahrain",
  "af-south-1": "Cape Town", "auto": "Auto",
};

export function regionLabel(code: string): string {
  if (code === "multi") return "Multiple regions";
  return REGION_LABELS[code] ?? code;
}
