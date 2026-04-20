// File type icon SVGs — matches the web app's icon set exactly

const icons = import.meta.glob("../../assets/file-icons/*.svg", {
  eager: true,
  query: "?url",
  import: "default",
}) as Record<string, string>;

function getIconUrl(filename: string): string {
  return icons[`../../assets/file-icons/${filename}.svg`] ?? icons["../../assets/file-icons/005-txt.svg"] ?? "";
}

const EXT_ICON_MAP: Record<string, string> = {
  pdf: "001-pdf", xls: "002-xls", xlsx: "002-xls", doc: "003-doc", docx: "003-doc",
  ppt: "004-ppt", pptx: "004-ppt", txt: "005-txt", svg: "006-svg", sql: "007-sql",
  js: "008-js", ts: "008-js", jsx: "008-js", tsx: "008-js",
  jpg: "009-jpg", jpeg: "009-jpg", png: "010-png",
  ai: "011-ai", mp3: "012-mp3", wav: "012-mp3", ogg: "012-mp3", flac: "012-mp3",
  mp4: "013-mp4", gif: "014-gif", iso: "015-iso", exe: "016-exe", msi: "016-exe",
  apk: "017-apk", php: "018-php", avi: "019-avi", mov: "020-mov", css: "021-css",
  zip: "022-zip", "7z": "022-zip", tar: "022-zip", gz: "022-zip", rar: "026-rar",
  java: "023-java", eps: "024-eps", ics: "025-ics", xml: "027-xml",
  otp: "028-otp", ttf: "029-ttf", otf: "029-ttf", woff: "029-ttf", woff2: "029-ttf",
};

const DEFAULT_ICON = "005-txt";

function extOf(name: string): string {
  return name.includes(".") ? name.split(".").pop()!.toLowerCase() : "";
}

export function fileIconSrc(fileName: string): string {
  const ext = extOf(fileName);
  const icon = EXT_ICON_MAP[ext] ?? DEFAULT_ICON;
  return getIconUrl(icon);
}

export function folderIconSrc(fileCount: number): string {
  return fileCount > 0
    ? getIconUrl("folder-full")
    : getIconUrl("folder-empty");
}

export function syncIconSrc(): string {
  return getIconUrl("sync");
}

export function FileIcon({
  name,
  size = 20,
  className,
}: {
  name: string;
  size?: number;
  className?: string;
}) {
  return (
    <img
      src={fileIconSrc(name)}
      alt=""
      width={size}
      height={size}
      className={className}
      draggable={false}
    />
  );
}

export function FolderIcon({
  fileCount = 0,
  size = 20,
  className,
  synced,
}: {
  fileCount?: number;
  size?: number;
  className?: string;
  synced?: boolean;
}) {
  return (
    <img
      src={synced ? syncIconSrc() : folderIconSrc(fileCount)}
      alt=""
      width={size}
      height={size}
      className={className}
      draggable={false}
    />
  );
}

export function FileIconWithSync({
  name,
  size = 20,
  className,
  synced,
}: {
  name: string;
  size?: number;
  className?: string;
  synced?: boolean;
}) {
  if (!synced) {
    return <FileIcon name={name} size={size} className={className} />;
  }

  const badgeSize = Math.max(Math.round(size * 0.45), 10);
  return (
    <span className={`relative inline-block ${className ?? ""}`} style={{ width: size, height: size }}>
      <img
        src={fileIconSrc(name)}
        alt=""
        width={size}
        height={size}
        draggable={false}
      />
      <img
        src={syncIconSrc()}
        alt="Synced"
        width={badgeSize}
        height={badgeSize}
        className="absolute"
        style={{ bottom: -2, right: -3 }}
        draggable={false}
      />
    </span>
  );
}
