import { formatBytes, formatRelative } from "./format";
import { EXTENSION_FAMILY, FILE_FAMILY, SWATCH_BY_NAME } from "./palette";
import { tl } from "./locale-state";
import type { MessageKey } from "../../i18n/keys";

// File-type detection + small formatting helpers used by the files surfaces.
// The colours come from the shared palette, so this no longer has to be kept in sync
// with the web copy by hand - both read the same generated file.

export function extOf(name: string): string {
  return name.includes(".") ? name.split(".").pop()!.toLowerCase() : "";
}

/**
 * File-type colour. The extension-to-family map and the family-to-colour map both live
 * in the shared palette now, so a `.xlsx` and a "spreadsheet" can no longer be coloured
 * by two different lookups that disagree.
 */
export function colorFor(name: string, scheme: "light" | "dark" = "light"): string {
  const family = EXTENSION_FAMILY[extOf(name)] ?? "other";
  const swatch = SWATCH_BY_NAME[FILE_FAMILY[family] ?? "graphite"];
  return swatch[scheme];
}

export function labelFor(name: string): string {
  const e = extOf(name);
  return e ? e.toUpperCase() : tl("common.label.fileUppercase");
}

/**
 * Broad category for the file list's Type column.
 *
 * Distinct from `labelFor` on purpose: that returns the extension, which is
 * what the Extension column already shows. A Type column repeating it says
 * nothing, and the raw MIME type it replaced was unreadable at any width.
 */
export function kindLabel(name: string): string {
  if (isPdf(name)) return tl("common.label.pdf");
  if (isImage(name)) return tl("common.label.image");
  if (isVideo(name)) return tl("common.label.videoTitleCase");
  if (isAudio(name)) return tl("common.label.audio");
  if (isBook(name)) return tl("common.label.book");
  if (isVcard(name)) return tl("common.label.contact");
  if (isOfficeFile(name)) return tl("common.label.document");
  if (isText(name)) return tl("common.label.text");
  return tl("common.label.fileTitleCase");
}

// avif is Chromium-native. tiff/dng are NOT here on purpose: Chromium does
// not decode them and the server thumbnailer only knows heic/png/jpeg, so
// the honest download card is the right rendering.
const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "gif", "webp", "avif", "bmp", "svg", "ico", "heic", "heif"]);
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

// opus/oga are Chromium-native; mka rides its Matroska demuxer. wma plays
// nowhere - it stays listed so the player's decode-failure banner claims
// the file rather than the generic fallback card.
const AUDIO_EXTS = new Set(["mp3", "wav", "ogg", "oga", "opus", "flac", "aac", "m4a", "mka", "wma"]);
export function isAudio(name: string): boolean {
  return AUDIO_EXTS.has(extOf(name));
}

export function isPdf(name: string): boolean {
  return extOf(name) === "pdf";
}

/**
 * Formats the reader can open. foliate-js also handles mobi/azw3/fb2/cbz, and
 * they are vendored, so they are listed here too rather than falling through to
 * a Download button that pretends the app cannot read them.
 *
 * .pdf is deliberately absent: vendor/foliate-js/pdf.js needs a pdfjs build
 * that is not vendored, and this app already renders PDFs natively.
 */
const BOOK_EXTS = new Set(["epub", "mobi", "azw3", "fb2", "cbz"]);

export function isBook(name: string): boolean {
  return BOOK_EXTS.has(extOf(name));
}

// Deliberately narrow. `.cbz` and `.epub` are zips too, but both already
// route to the book reader, and claiming them here would take a working
// experience away and replace it with a file tree.
// `iso` and `img` open in the same pane: the API lists an ISO 9660 image the
// way it lists a zip, and refuses a raw .img with a sentence the pane shows.
const ARCHIVE_EXTS = new Set(["zip", "iso", "img"]);
export function isArchive(name: string): boolean {
  return ARCHIVE_EXTS.has(extOf(name));
}

export function isVcard(name: string): boolean {
  const e = extOf(name);
  return e === "vcf" || e === "vcard";
}

// Same list as packages/shared/src/files/preview-formats.ts CALENDAR_EXTS.
// A text/calendar mime counts only for a name with no extension (an invite
// saved as "invite"): a mime never overrides an extension, and the viewer
// shows the text when the file holds no events.
const CALENDAR_EXTS = new Set(["ics", "ical", "icalendar"]);
export function isCalendar(name: string, mime?: string | null): boolean {
  const ext = extOf(name);
  if (ext) return CALENDAR_EXTS.has(ext);
  return (mime ?? "").split(";")[0].trim().toLowerCase() === "text/calendar";
}

const OFFICE_EXTS = new Set([
  "docx", "xlsx", "pptx", "doc", "xls", "ppt", "odt", "ods", "odp", "rtf", "csv",
]);

// Files that open in the ONLYOFFICE editor at /editor/:fileId. Keep in sync
// with apps/web/src/lib/helpers.ts and apps/api/src/lib/onlyoffice/formats.ts.
export function isOfficeFile(name: string): boolean {
  return OFFICE_EXTS.has(extOf(name));
}

export function humanSize(b: number | null | undefined): string {
  if (typeof b !== "number" || !Number.isFinite(b)) return "-";
  return formatBytes(b);
}

export function timeAgo(ts: number | string | null | undefined): string {
  if (ts == null) return "-";
  const d = typeof ts === "number" ? new Date(ts * 1000) : new Date(ts);
  if (Number.isNaN(d.getTime())) return "-";
  return formatRelative(ts);
}

export function initials(name: string | null | undefined): string {
  const parts = (name ?? "").trim().split(/\s+/);
  return ((parts[0]?.[0] ?? "") + (parts[1]?.[0] ?? "")).toUpperCase() || "?";
}

// Catalog keys for the words; product and protocol names stay as they are.
const ORIGIN_LABELS: Record<string, MessageKey | { name: string }> = {
  web: "common.label.web", desktop: "common.label.desktop", mobile: "common.label.mobileTitleCase", cli: { name: "CLI" },
  webdav: { name: "WebDAV" }, s3: { name: "S3" }, ftp: { name: "FTP" }, import: "common.label.import",
};

export function originLabel(origin: string | null | undefined): string {
  const label = origin ? ORIGIN_LABELS[origin] : undefined;
  if (!label) return "-";
  return typeof label === "string" ? tl(label) : label.name;
}

// "Hidden" is never binary from the viewer's own perspective - if they can
// see the row at all, they're someone it's NOT hidden from. This names who
// ELSE it's hidden from, and warns that hidden items drop out of share
// links - it must never read as "hidden from you". Mirrors
// apps/web/src/lib/helpers.ts's hiddenTitle.
export function hiddenTitle(hiddenMode: string | null | undefined): string {
  return hiddenMode === "everyone"
    ? tl("common.label.hiddenFromEveryoneNotIncludedInShareLinks")
    : tl("common.label.hiddenFromSomePeopleNotIncludedInShareLinks");
}

const REGION_LABELS: Record<string, MessageKey> = {
  "us-east-1": "common.label.usEast", "us-west-1": "common.label.usWest", "us-west-2": "common.label.usWest2",
  "eu-west-1": "common.label.euWest", "eu-central-1": "common.label.euCentral",
  "ap-southeast-1": "common.label.singapore", "ap-southeast-2": "common.label.sydney", "ap-northeast-1": "common.label.tokyo",
  "sa-east-1": "common.label.saoPaulo", "me-south-1": "common.label.bahrain",
  "af-south-1": "common.label.capeTown", "auto": "common.label.auto",
};

export function regionLabel(code: string): string {
  if (code === "multi") return tl("common.label.multipleRegions");
  const key = REGION_LABELS[code];
  return key ? tl(key) : code;
}
