// Ported from apps/web/src/components/file-info-dialog.tsx - keep in sync with the web copy.
import { useState } from "react";
import { Copy, Check, Lock, EyeOff, Share2, MessageSquare } from "lucide-react";
import { FilePreviewImage } from "@/components/files/FilePreviewImage";
import { fileIconSrc, folderIconSrc } from "@/components/files/FileIcon";
import { Modal } from "@/components/files/Modal";
import { humanSize, extOf, regionLabel, colorFor, isImage } from "@/lib/file-type";
import { intlLocale } from "@/lib/locale-state";
import { useT } from "@/lib/i18n";
import { Bdi, useAutoDir } from "@/lib/bidi-ui";

interface FileLike {
  id: string; name: string; size_bytes: number; mime_type: string; extension: string | null;
  region: string; created_at: number; updated_at: number; current_version?: number;
  lock_mode: string; is_hidden: number; uploader_name: string | null; share_count: number; comment_count: number;
}
interface FolderLike {
  id: string; name: string; created_at: number; file_count: number; lock_mode: string; is_hidden: number;
  total_size_bytes: number; content_updated_at: number; region: string | null; uploader_name?: string | null;
}

export type InfoTarget =
  | { type: "file"; item: FileLike }
  | { type: "folder"; item: FolderLike };

function fullDate(ts: number): string {
  if (!ts) return "-";
  return new Date(ts * 1000).toLocaleString(intlLocale(), {
    year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
  });
}

export function FileInfoDialog({ target, location, onClose }: {
  target: InfoTarget | null;
  location?: string;
  onClose: () => void;
}) {
  const t = useT();
  if (!target) return null;
  return (
    <Modal onClose={onClose}>
      {target.type === "file" && <FileInfo file={target.item} location={location} />}
      {target.type === "folder" && <FolderInfo folder={target.item} location={location} />}
      <div className="mt-5 flex justify-end">
        <button onClick={onClose} className="rounded-lg border px-4 py-2 text-sm" style={{ borderColor: "var(--color-border)" }}>
          {t("common.close")}
        </button>
      </div>
    </Modal>
  );
}

// ── shared bits ────────────────────────────────────────────
function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-3 border-b py-2 text-sm last:border-b-0" style={{ borderColor: "var(--color-border)" }}>
      <span className="w-28 shrink-0 text-[var(--color-text-muted)]">{label}</span>
      <span className="min-w-0 flex-1 select-text break-words">{children}</span>
    </div>
  );
}

function CopyableId({ id }: { id: string }) {
  const [copied, setCopied] = useState(false);
  const t = useT();
  return (
    <button
      onClick={() => navigator.clipboard?.writeText(id).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1200); }).catch(() => {})}
      className="group inline-flex items-center gap-1.5 font-mono text-xs text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
      title={t("files.tooltip.copyID")}
    >
      <span dir="ltr" className="break-all">{id}</span>
      {copied ? <Check size={12} className="shrink-0 text-green-600" /> : <Copy size={12} className="shrink-0 opacity-0 group-hover:opacity-100" />}
    </button>
  );
}

function StatusBadges({ lock_mode, is_hidden }: { lock_mode: string; is_hidden: number }) {
  const t = useT();
  if (lock_mode === "none" && !is_hidden) return <span className="text-[var(--color-text-muted)]">{t("files.status.normal")}</span>;
  return (
    <span className="flex flex-wrap gap-1.5">
      {lock_mode !== "none" && (
        <span className="inline-flex items-center gap-1 rounded bg-[var(--color-bg-tertiary)] px-1.5 py-0.5 text-xs">
          <Lock size={12} className="text-violet-600" /> {lock_mode === "full_lock" ? t("files.status.locked") : t("files.status.lock")}
        </span>
      )}
      {!!is_hidden && (
        <span className="inline-flex items-center gap-1 rounded bg-[var(--color-bg-tertiary)] px-1.5 py-0.5 text-xs">
          <EyeOff size={12} /> {t("common.status.hidden")}
        </span>
      )}
    </span>
  );
}

function Header({ thumb, name, subtitle, version }: { thumb: React.ReactNode; name: string; subtitle: string; version?: number }) {
  const ownDir = useAutoDir();
  const t = useT();
  return (
    <div className="flex items-center gap-3 text-start">
      <div className="flex h-14 w-14 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-[var(--color-bg-tertiary)]">{thumb}</div>
      <div className="min-w-0">
        <p className="flex items-center gap-2 break-words text-base font-semibold leading-snug">
          <span dir={ownDir} className="min-w-0 break-words">{name}</span>
          {version && version > 1 && (
            <span className="shrink-0 rounded bg-[var(--color-bg-tertiary)] px-1.5 py-0.5 text-[9px] font-medium">{t("common.label.vVersion", { version: String(version) })}</span>
          )}
        </p>
        <p className="mt-0.5 text-xs text-[var(--color-text-muted)]">{subtitle}</p>
      </div>
    </div>
  );
}

// ── file ───────────────────────────────────────────────────
function FileInfo({ file, location }: { file: FileLike; location?: string }) {
  const t = useT();
  const ext = extOf(file.name).toUpperCase();
  const versions = file.current_version ?? 1;
  const thumb = isImage(file.name)
    ? <FilePreviewImage fileId={file.id} fileName={file.name} size={128} className="h-full w-full object-cover" fallback={<span className="font-mono text-[10px] font-bold" style={{ color: colorFor(file.name) }}>{ext || t("common.label.fileUppercase")}</span>} />
    : <img src={fileIconSrc(file.name)} alt="" className="h-8 w-8" />;

  return (
    <>
      <Header thumb={thumb} name={file.name} version={versions}
        subtitle={`${file.mime_type || t("files.label.unknownType")} · ${humanSize(file.size_bytes)}`} />
      <div className="mt-3">
        <Row label={t("files.label.kind")}>{file.mime_type || t("files.label.unknown")}{ext ? ` (.${ext.toLowerCase()})` : ""}</Row>
        <Row label={t("files.label.size")}>{humanSize(file.size_bytes)} <span className="text-[var(--color-text-muted)]">{t("files.label.sizebytesBytes", { sizeBytes: file.size_bytes.toLocaleString(intlLocale()) })}</span></Row>
        {location && <Row label={t("files.label.where")}><Bdi>{location}</Bdi></Row>}
        <Row label={t("files.label.created")}>{fullDate(file.created_at)}</Row>
        <Row label={t("files.label.modified")}>{fullDate(file.updated_at)}</Row>
        <Row label={t("common.label.versions")}>{t("files.label.versionSentenceCase", { versions })}</Row>
        <Row label={t("files.label.uploadedBy")}>{file.uploader_name ? <Bdi>{file.uploader_name}</Bdi> : "-"}</Row>
        <Row label={t("files.label.region")}>{regionLabel(file.region)}</Row>
        <Row label={t("files.label.sharing")}>
          <span className="flex items-center gap-3">
            <span className="inline-flex items-center gap-1"><Share2 size={14} className="text-[var(--color-text-muted)]" /> {t("files.label.share", { shareCount: file.share_count })}</span>
            <span className="inline-flex items-center gap-1"><MessageSquare size={14} className="text-[var(--color-text-muted)]" /> {t("files.label.comment", { commentCount: file.comment_count })}</span>
          </span>
        </Row>
        <Row label={t("common.column.status")}><StatusBadges lock_mode={file.lock_mode} is_hidden={file.is_hidden} /></Row>
        <Row label={t("files.label.id")}><CopyableId id={file.id} /></Row>
      </div>
    </>
  );
}

// ── folder ─────────────────────────────────────────────────
function FolderInfo({ folder, location }: { folder: FolderLike; location?: string }) {
  const t = useT();
  return (
    <>
      <Header thumb={<img src={folderIconSrc(folder.file_count)} alt="" className="h-9 w-9" />} name={folder.name}
        subtitle={t("files.label.folderItemCountAndSize", { count: folder.file_count, size: humanSize(folder.total_size_bytes) })} />
      <div className="mt-3">
        <Row label={t("files.label.kind")}>{t("common.label.folder")}</Row>
        <Row label={t("files.label.items")}>{t("common.label.item", { count: folder.file_count })}</Row>
        <Row label={t("files.label.size")}>{humanSize(folder.total_size_bytes)} <span className="text-[var(--color-text-muted)]">{t("files.label.sizebytesBytes", { sizeBytes: folder.total_size_bytes.toLocaleString(intlLocale()) })}</span></Row>
        {location && <Row label={t("files.label.where")}><Bdi>{location}</Bdi></Row>}
        <Row label={t("files.label.created")}>{fullDate(folder.created_at)}</Row>
        <Row label={t("files.label.modified")}>{fullDate(folder.content_updated_at)}</Row>
        {folder.uploader_name != null && <Row label={t("files.label.createdBy")}>{folder.uploader_name ? <Bdi>{folder.uploader_name}</Bdi> : "-"}</Row>}
        <Row label={t("files.label.region")}>{folder.region ? regionLabel(folder.region) : "-"}</Row>
        <Row label={t("common.column.status")}><StatusBadges lock_mode={folder.lock_mode} is_hidden={folder.is_hidden} /></Row>
        <Row label={t("files.label.id")}><CopyableId id={folder.id} /></Row>
      </div>
    </>
  );
}
