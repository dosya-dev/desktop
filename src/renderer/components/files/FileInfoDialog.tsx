// Ported from apps/web/src/components/file-info-dialog.tsx — keep in sync with the web copy.
import { useState } from "react";
import { Copy, Check, Lock, EyeOff, Share2, MessageSquare } from "lucide-react";
import { FilePreviewImage } from "@/components/files/FilePreviewImage";
import { fileIconSrc, folderIconSrc } from "@/components/files/FileIcon";
import { Modal } from "@/components/files/Modal";
import { humanSize, extOf, regionLabel, colorFor, isImage } from "@/lib/file-type";

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
  if (!ts) return "—";
  return new Date(ts * 1000).toLocaleString(undefined, {
    year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
  });
}

export function FileInfoDialog({ target, location, onClose }: {
  target: InfoTarget | null;
  location?: string;
  onClose: () => void;
}) {
  if (!target) return null;
  return (
    <Modal onClose={onClose}>
      {target.type === "file" && <FileInfo file={target.item} location={location} />}
      {target.type === "folder" && <FolderInfo folder={target.item} location={location} />}
      <div className="mt-5 flex justify-end">
        <button onClick={onClose} className="rounded-lg border px-4 py-2 text-sm" style={{ borderColor: "var(--color-border)" }}>
          Close
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
  return (
    <button
      onClick={() => navigator.clipboard?.writeText(id).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1200); }).catch(() => {})}
      className="group inline-flex items-center gap-1.5 font-mono text-xs text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
      title="Copy ID"
    >
      <span className="break-all">{id}</span>
      {copied ? <Check size={12} className="shrink-0 text-green-600" /> : <Copy size={12} className="shrink-0 opacity-0 group-hover:opacity-100" />}
    </button>
  );
}

function StatusBadges({ lock_mode, is_hidden }: { lock_mode: string; is_hidden: number }) {
  if (lock_mode === "none" && !is_hidden) return <span className="text-[var(--color-text-muted)]">Normal</span>;
  return (
    <span className="flex flex-wrap gap-1.5">
      {lock_mode !== "none" && (
        <span className="inline-flex items-center gap-1 rounded bg-[var(--color-bg-tertiary)] px-1.5 py-0.5 text-xs">
          <Lock size={12} className="text-violet-600" /> {lock_mode === "full_lock" ? "Locked" : "Lock"}
        </span>
      )}
      {!!is_hidden && (
        <span className="inline-flex items-center gap-1 rounded bg-[var(--color-bg-tertiary)] px-1.5 py-0.5 text-xs">
          <EyeOff size={12} /> Hidden
        </span>
      )}
    </span>
  );
}

function Header({ thumb, name, subtitle, version }: { thumb: React.ReactNode; name: string; subtitle: string; version?: number }) {
  return (
    <div className="flex items-center gap-3 text-left">
      <div className="flex h-14 w-14 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-[var(--color-bg-tertiary)]">{thumb}</div>
      <div className="min-w-0">
        <p className="flex items-center gap-2 break-words text-base font-semibold leading-snug">
          <span className="min-w-0 break-words">{name}</span>
          {version && version > 1 && (
            <span className="shrink-0 rounded bg-[var(--color-bg-tertiary)] px-1.5 py-0.5 text-[9px] font-medium">v{version}</span>
          )}
        </p>
        <p className="mt-0.5 text-xs text-[var(--color-text-muted)]">{subtitle}</p>
      </div>
    </div>
  );
}

// ── file ───────────────────────────────────────────────────
function FileInfo({ file, location }: { file: FileLike; location?: string }) {
  const ext = extOf(file.name).toUpperCase();
  const versions = file.current_version ?? 1;
  const thumb = isImage(file.name)
    ? <FilePreviewImage fileId={file.id} fileName={file.name} size={128} className="h-full w-full object-cover" fallback={<span className="font-mono text-[10px] font-bold" style={{ color: colorFor(file.name) }}>{ext || "FILE"}</span>} />
    : <img src={fileIconSrc(file.name)} alt="" className="h-8 w-8" />;

  return (
    <>
      <Header thumb={thumb} name={file.name} version={versions}
        subtitle={`${file.mime_type || "Unknown type"} · ${humanSize(file.size_bytes)}`} />
      <div className="mt-3">
        <Row label="Kind">{file.mime_type || "Unknown"}{ext ? ` (.${ext.toLowerCase()})` : ""}</Row>
        <Row label="Size">{humanSize(file.size_bytes)} <span className="text-[var(--color-text-muted)]">({file.size_bytes.toLocaleString()} bytes)</span></Row>
        {location && <Row label="Where">{location}</Row>}
        <Row label="Created">{fullDate(file.created_at)}</Row>
        <Row label="Modified">{fullDate(file.updated_at)}</Row>
        <Row label="Versions">{versions} {versions === 1 ? "version" : "versions"}</Row>
        <Row label="Uploaded by">{file.uploader_name || "—"}</Row>
        <Row label="Region">{regionLabel(file.region)}</Row>
        <Row label="Sharing">
          <span className="flex items-center gap-3">
            <span className="inline-flex items-center gap-1"><Share2 size={14} className="text-[var(--color-text-muted)]" /> {file.share_count} {file.share_count === 1 ? "share" : "shares"}</span>
            <span className="inline-flex items-center gap-1"><MessageSquare size={14} className="text-[var(--color-text-muted)]" /> {file.comment_count} {file.comment_count === 1 ? "comment" : "comments"}</span>
          </span>
        </Row>
        <Row label="Status"><StatusBadges lock_mode={file.lock_mode} is_hidden={file.is_hidden} /></Row>
        <Row label="ID"><CopyableId id={file.id} /></Row>
      </div>
    </>
  );
}

// ── folder ─────────────────────────────────────────────────
function FolderInfo({ folder, location }: { folder: FolderLike; location?: string }) {
  return (
    <>
      <Header thumb={<img src={folderIconSrc(folder.file_count)} alt="" className="h-9 w-9" />} name={folder.name}
        subtitle={`Folder · ${folder.file_count} ${folder.file_count === 1 ? "item" : "items"} · ${humanSize(folder.total_size_bytes)}`} />
      <div className="mt-3">
        <Row label="Kind">Folder</Row>
        <Row label="Items">{folder.file_count} {folder.file_count === 1 ? "item" : "items"}</Row>
        <Row label="Size">{humanSize(folder.total_size_bytes)} <span className="text-[var(--color-text-muted)]">({folder.total_size_bytes.toLocaleString()} bytes)</span></Row>
        {location && <Row label="Where">{location}</Row>}
        <Row label="Created">{fullDate(folder.created_at)}</Row>
        <Row label="Modified">{fullDate(folder.content_updated_at)}</Row>
        {folder.uploader_name != null && <Row label="Created by">{folder.uploader_name || "—"}</Row>}
        <Row label="Region">{folder.region ? regionLabel(folder.region) : "—"}</Row>
        <Row label="Status"><StatusBadges lock_mode={folder.lock_mode} is_hidden={folder.is_hidden} /></Row>
        <Row label="ID"><CopyableId id={folder.id} /></Row>
      </div>
    </>
  );
}
