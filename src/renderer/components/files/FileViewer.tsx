// Ported from apps/web/src/components/file-viewer.tsx (read-only) - keep in sync with the web copy.
// The desktop viewer is read-only: the Edit button, Pintura image/video editor,
// and CodeMirror text editor from the web version are intentionally absent.
// Downloads go through the file:download IPC (save dialog) instead of an <a download>.
import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import {
  X, Download, ChevronLeft, ChevronRight, Clock,
} from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/api-client";
import { fileRawUrl } from "@/lib/file-url";
import { humanSize, extOf, isImage, isVideo, isAudio, isPdf, isVcard, isOfficeFile, isBook } from "@/lib/file-type";
import { isTextReadable, langFromExtension, looksBinary } from "@/lib/text-detect";
import { highlightToHtml } from "@/lib/text-highlight";
import { useInFileFind } from "@/lib/use-in-file-find";
import { FilePreviewImage } from "@/components/files/FilePreviewImage";
import { TextFindBar } from "@/components/files/TextFindBar";
import { VCardView } from "@/components/files/VCardView";
import { OfficePreview } from "@/components/files/OfficePreview";
import { BookViewer } from "@/components/files/BookViewer";
import { AudioPlayer } from "@/components/files/audio/AudioPlayer";
import { fileIconSrc } from "@/components/files/FileIcon";

// ── Types ─────────────────────────────────────────────────

/** The file shape the viewer needs - matches the Files page's API rows. */
export interface ViewerFile {
  id: string;
  name: string;
  size_bytes: number;
  mime_type: string;
  extension: string | null;
  region: string;
  created_at: number;
  updated_at: number;
  current_version?: number;
  lock_mode: string;
  is_hidden: number;
  /**
   * Who `is_hidden` hides this from - "none" | "everyone" | "users" | "roles".
   * Optional for the same reason `origin` is: not every producer of a
   * ViewerFile-shaped row selects it.
   */
  hidden_mode?: string;
  uploader_name: string | null;
  share_count: number;
  comment_count: number;
  origin?: string | null;
}

interface Version {
  version_number: number;
  size_bytes: number;
  created_at: number;
  uploader_name: string | null;
}

interface FileViewerProps {
  file: ViewerFile;
  files: ViewerFile[];
  onClose: () => void;
  onNavigate: (file: ViewerFile) => void;
}

// ── Helpers ───────────────────────────────────────────────

const THUMB_WINDOW = 6;
function getThumbWindow(activeIdx: number, total: number) {
  if (total <= THUMB_WINDOW) return { start: 0, end: total };
  let start = activeIdx - Math.floor(THUMB_WINDOW / 2);
  if (start < 0) start = 0;
  let end = start + THUMB_WINDOW;
  if (end > total) { end = total; start = end - THUMB_WINDOW; }
  return { start, end };
}

/** Save via the main process (save dialog → streamed download), with a "Show in Folder" toast. */
async function downloadViaDialog(file: ViewerFile, version?: number): Promise<void> {
  try {
    const res = await window.electronAPI.downloadFile(file.id, file.name, version);
    if (res.canceled) return;
    if (res.ok && res.path) {
      const path = res.path;
      toast.success("Downloaded", {
        description: path,
        action: { label: "Show in Folder", onClick: () => window.electronAPI.showInFolder(path) },
      });
    }
  } catch (err) {
    toast.error("Download failed", {
      description: err instanceof Error ? err.message : undefined,
    });
  }
}

// ── Component ─────────────────────────────────────────────

export function FileViewer({ file, files, onClose, onNavigate }: FileViewerProps) {
  const [versions, setVersions] = useState<Version[]>([]);
  const [activeVersion, setActiveVersion] = useState(-1);
  const [closing, setClosing] = useState(false);

  const idx = files.findIndex((f) => f.id === file.id);
  const hasPrev = idx > 0;
  const hasNext = idx >= 0 && idx < files.length - 1;
  const counter = idx >= 0 ? `${idx + 1} / ${files.length}` : "";

  // Reset version state synchronously when the viewer is pointed at a different
  // file (this component isn't remounted on navigation), so the new file never
  // renders for a frame carrying the previous file's version param. This is the
  // idiomatic "adjust state during render on a prop change" pattern.
  const prevFileId = useRef(file.id);
  if (prevFileId.current !== file.id) {
    prevFileId.current = file.id;
    setVersions([]);
    setActiveVersion(-1);
  }

  // Load versions. A `cancelled` flag drops a stale response if the file
  // changed mid-flight, so an out-of-order reply can't overwrite the current
  // file's version list.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const data = await api.get<{ ok: boolean; current_version: number; versions: Version[] }>(
          `/api/files/${file.id}/versions`,
        );
        if (cancelled) return;
        if (data.ok && data.versions?.length) {
          setVersions(data.versions);
          setActiveVersion(data.versions[0].version_number);
        } else {
          setVersions([]);
          setActiveVersion(-1);
        }
      } catch {
        if (!cancelled) setVersions([]);
      }
    })();
    return () => { cancelled = true; };
  }, [file.id]);

  // The version actually being shown - `undefined` means current/latest.
  const previewVersion =
    activeVersion > 0 && versions.length > 0 && activeVersion !== versions[0].version_number
      ? activeVersion
      : undefined;

  // Build the raw URL for the active version. The viewer is read-only, so there
  // is no cache-buster: a stable URL keeps video/audio/PDF from restarting and
  // text from re-downloading on every unrelated re-render - it only changes
  // when the file or the shown version changes.
  const rawUrl = useMemo(
    () => fileRawUrl({ fileId: file.id, version: previewVersion }),
    [file.id, previewVersion],
  );

  // Navigate version
  const navigateVersion = useCallback((dir: number) => {
    if (versions.length <= 1) return;
    const curIdx = versions.findIndex((v) => v.version_number === activeVersion);
    const newIdx = curIdx + dir;
    if (newIdx >= 0 && newIdx < versions.length) {
      setActiveVersion(versions[newIdx].version_number);
    }
  }, [versions, activeVersion]);

  const handleClose = useCallback(() => {
    setClosing(true);
    setTimeout(() => onClose(), 200);
  }, [onClose]);

  // Keyboard shortcuts
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") { handleClose(); return; }
      if (e.key === "ArrowLeft" && hasPrev) onNavigate(files[idx - 1]);
      if (e.key === "ArrowRight" && hasNext) onNavigate(files[idx + 1]);
      if (e.key === "ArrowUp") { e.preventDefault(); navigateVersion(-1); }
      if (e.key === "ArrowDown") { e.preventDefault(); navigateVersion(1); }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [hasPrev, hasNext, idx, files, onNavigate, navigateVersion, handleClose]);

  // Lock body scroll
  useEffect(() => {
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = ""; };
  }, []);

  const onDownload = useCallback(() => downloadViaDialog(file, previewVersion), [file, previewVersion]);

  // ── Thumb strip ─────────────────────────────────────────

  const { start: thumbStart, end: thumbEnd } = getThumbWindow(idx, files.length);
  const thumbFiles = files.slice(thumbStart, thumbEnd);

  return (
    <div
      className={`fixed inset-0 z-[300] flex flex-col bg-[var(--color-bg)] transition-opacity duration-200 ${closing ? "opacity-0" : "opacity-100"}`}
    >
      {/* Header */}
      <div className="flex shrink-0 items-center justify-between border-b px-4 py-2.5" style={{ borderColor: "var(--color-border)" }}>
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <svg viewBox="0 0 14 14" fill="none" width="14" height="14" className="shrink-0 text-[var(--color-text-muted)]">
            <path d="M1 7s2.5-4.5 6-4.5S13 7 13 7s-2.5 4.5-6 4.5S1 7 1 7z" stroke="currentColor" strokeWidth="1.1" />
            <circle cx="7" cy="7" r="2" stroke="currentColor" strokeWidth="1.1" />
          </svg>
          <span className="truncate text-sm font-semibold">{file.name}</span>
          <span className="shrink-0 text-xs text-[var(--color-text-muted)]">{counter}</span>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {hasPrev && (
            <button className="flex h-8 w-8 items-center justify-center rounded-md hover:bg-[var(--color-bg-tertiary)]" onClick={() => onNavigate(files[idx - 1])} title="Previous (←)">
              <ChevronLeft size={16} className="text-[var(--color-text-muted)]" />
            </button>
          )}
          {hasNext && (
            <button className="flex h-8 w-8 items-center justify-center rounded-md hover:bg-[var(--color-bg-tertiary)]" onClick={() => onNavigate(files[idx + 1])} title="Next (→)">
              <ChevronRight size={16} className="text-[var(--color-text-muted)]" />
            </button>
          )}
          <button className="flex h-8 w-8 items-center justify-center rounded-md hover:bg-[var(--color-bg-tertiary)]" onClick={onDownload} title="Download">
            <Download size={16} className="text-[var(--color-text-muted)]" />
          </button>
          <button className="ml-1 flex h-8 w-8 items-center justify-center rounded-md hover:bg-[var(--color-bg-tertiary)]" onClick={handleClose} title="Close (Esc)">
            <X size={16} className="text-[var(--color-text-muted)]" />
          </button>
        </div>
      </div>

      {/* Body + version sidebar */}
      <div className="flex min-h-0 flex-1">
        {/* File content */}
        {/* Audio owns the whole area - it is a surface, not an object sitting
            on one - so it drops the centring and padding every other type wants. */}
        <div className={`flex min-h-0 min-w-0 flex-1 bg-[var(--color-bg-secondary)] ${isAudio(file.name) ? "overflow-hidden" : "items-center justify-center overflow-auto p-6"}`}>
          <FileContent file={file} files={files} rawUrl={rawUrl} version={previewVersion} onDownload={onDownload} onNavigate={onNavigate} />
        </div>

        {/* Version sidebar */}
        <aside className="hidden w-52 shrink-0 flex-col border-l bg-[var(--color-bg)] md:flex" style={{ borderColor: "var(--color-border)" }}>
          <div className="flex shrink-0 items-center gap-1.5 border-b px-3.5 py-2.5 text-xs font-semibold" style={{ borderColor: "var(--color-border)" }}>
            <Clock size={12} className="text-[var(--color-text-muted)]" />
            Versions
            <div className="ml-auto flex items-center gap-0.5">
              <kbd className="inline-flex h-5 min-w-5 items-center justify-center rounded border px-1 text-[10px] text-[var(--color-text-muted)]" style={{ borderColor: "var(--color-border)" }}>↑</kbd>
              <kbd className="inline-flex h-5 min-w-5 items-center justify-center rounded border px-1 text-[10px] text-[var(--color-text-muted)]" style={{ borderColor: "var(--color-border)" }}>↓</kbd>
            </div>
          </div>
          <div className="flex-1 overflow-y-auto p-1.5">
            {versions.length === 0 ? (
              <p className="py-5 text-center text-xs text-[var(--color-text-muted)]">No version history</p>
            ) : (
              versions.map((v) => {
                const isActive = v.version_number === activeVersion;
                const isLatest = v.version_number === versions[0].version_number;
                const d = new Date(v.created_at * 1000);
                const dateStr = d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
                const timeStr = d.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" });
                return (
                  <button
                    key={v.version_number}
                    className={`mb-0.5 block w-full rounded-md px-2.5 py-2 text-left transition-colors ${isActive ? "bg-[var(--color-bg-tertiary)] shadow-[inset_2px_0_0_var(--color-primary)]" : "hover:bg-[var(--color-bg-secondary)]"}`}
                    onClick={() => setActiveVersion(v.version_number)}
                  >
                    <div className="flex items-center gap-1.5 text-xs font-semibold">
                      v{v.version_number}
                      {isLatest && (
                        <span className="rounded bg-green-500 px-1.5 py-px text-[9px] font-semibold uppercase tracking-wide text-white">Latest</span>
                      )}
                    </div>
                    <div className="mt-0.5 text-[11px] text-[var(--color-text-muted)]">
                      {humanSize(v.size_bytes)} &middot; {dateStr} {timeStr}
                    </div>
                    {v.uploader_name && (
                      <div className="text-[11px] text-[var(--color-text-muted)]">{v.uploader_name}</div>
                    )}
                  </button>
                );
              })
            )}
          </div>
        </aside>
      </div>

      {/* Thumbnail strip footer */}
      <div className="flex shrink-0 items-center justify-center gap-2 border-t px-3 py-2" style={{ borderColor: "var(--color-border)" }}>
        <kbd className="inline-flex h-5 min-w-5 items-center justify-center rounded border px-1 text-[10px] text-[var(--color-text-muted)]" style={{ borderColor: "var(--color-border)" }}>←</kbd>
        <div className="flex flex-1 items-center justify-center gap-1.5 overflow-x-auto">
          {thumbFiles.map((f, i) => {
            const realIdx = thumbStart + i;
            const isActive = realIdx === idx;
            return (
              <button
                key={f.id}
                className={`relative flex h-13 w-13 shrink-0 items-center justify-center overflow-hidden rounded-md border-2 bg-[var(--color-bg-tertiary)] transition-colors ${isActive ? "border-[var(--color-primary)]" : "border-transparent hover:border-[var(--color-text-muted)]/40"}`}
                onClick={() => onNavigate(files[realIdx])}
                title={f.name}
              >
                <FilePreviewImage
                  fileId={f.id}
                  fileName={f.name}
                  size={128}
                  className="h-full w-full object-cover"
                  fallback={<img src={fileIconSrc(f.name)} alt="" className="h-6 w-6" />}
                />
                {isVideo(f.name) && (
                  <div className="absolute bottom-0.5 right-0.5 flex h-3.5 w-3.5 items-center justify-center rounded bg-black/50">
                    <svg viewBox="0 0 8 8" fill="none" width="8" height="8"><path d="M2 1.5l4.5 2.5L2 6.5z" fill="#fff" /></svg>
                  </div>
                )}
              </button>
            );
          })}
        </div>
        <kbd className="inline-flex h-5 min-w-5 items-center justify-center rounded border px-1 text-[10px] text-[var(--color-text-muted)]" style={{ borderColor: "var(--color-border)" }}>→</kbd>
      </div>
    </div>
  );
}

// ── File content renderer ─────────────────────────────────

function FileContent({ file, files, rawUrl, version, onDownload, onNavigate }: { file: ViewerFile; files: ViewerFile[]; rawUrl: string; version?: number; onDownload: () => void; onNavigate: (f: ViewerFile) => void }) {
  const ext = extOf(file.name);

  if (isVcard(file.name)) {
    return <VCardView file={file} rawUrl={rawUrl} />;
  }

  if (isImage(file.name)) {
    return (
      <FilePreviewImage
        fileId={file.id}
        fileName={file.name}
        version={version}
        size={1600}
        className="max-h-full max-w-full rounded-md object-contain"
        alt={file.name}
        fallback={<img src={fileIconSrc(file.name)} alt={file.name} className="h-24 w-24" />}
      />
    );
  }

  if (isVideo(file.name)) {
    return <video src={rawUrl} controls autoPlay className="max-h-full max-w-full rounded-md bg-black" />;
  }

  if (isAudio(file.name)) {
    return (
      <AudioPlayer
        file={file}
        files={files}
        rawUrl={rawUrl}
        downloadUrl={rawUrl}
        version={version}
        onNavigate={onNavigate}
      />
    );
  }

  if (isPdf(file.name)) {
    return (
      <iframe src={`${rawUrl}#toolbar=1`} className="h-full w-full rounded-md border-none bg-white" title={`PDF: ${file.name}`} />
    );
  }

  // Office documents have no native renderer here either: the server converts
  // them and this shows the resulting PDF. Placed after isPdf so a real .pdf
  // never takes the conversion path.
  if (isOfficeFile(file.name)) {
    return <OfficePreview file={file} />;
  }

  // Before the text check: an .epub is a zip, so isTextReadable could not claim
  // it, but a .fb2 is XML and would otherwise render as markup instead of a book.
  if (isBook(file.name)) {
    return <BookViewer file={file} />;
  }

  if (isTextReadable(file.name, file.mime_type)) {
    return <TextViewer file={file} rawUrl={rawUrl} onDownload={onDownload} />;
  }

  // Fallback
  return (
    <div className="rounded-xl border bg-[var(--color-bg)] p-10 text-center" style={{ borderColor: "var(--color-border)", minWidth: 280 }}>
      <p className="mb-3 text-4xl font-bold tracking-wider text-[var(--color-text-muted)]/40">{ext.toUpperCase() || "FILE"}</p>
      <p className="mb-5 break-all text-sm text-[var(--color-text-muted)]">{file.name}</p>
      <button
        onClick={onDownload}
        className="inline-flex items-center gap-2 rounded-lg px-5 py-2.5 text-sm font-semibold text-white hover:opacity-90"
        style={{ background: "var(--color-primary)" }}
      >
        <Download size={16} /> Download
      </button>
    </div>
  );
}

const TEXT_PREVIEW_MAX = 2 * 1024 * 1024; // 2 MB
const HIGHLIGHT_MAX = 300 * 1024;         // 300 KB

function TextViewer({ file, rawUrl, onDownload }: { file: ViewerFile; rawUrl: string; onDownload: () => void }) {
  const ext = extOf(file.name);
  const [plain, setPlain] = useState<string | null>(null);
  const [html, setHtml] = useState<string | null>(null);
  const [state, setState] = useState<"loading" | "ok" | "toobig" | "binary" | "error">("loading");
  const [findOpen, setFindOpen] = useState(false);
  const contentRef = useRef<HTMLDivElement>(null);
  const find = useInFileFind(contentRef);

  // Fetch + detect
  useEffect(() => {
    setPlain(null); setHtml(null); setFindOpen(false); find.clear();
    if (file.size_bytes > TEXT_PREVIEW_MAX) { setState("toobig"); return; }
    setState("loading");
    let cancelled = false;
    fetch(rawUrl, { credentials: "include" })
      .then((r) => (r.ok ? r.text() : Promise.reject()))
      .then((text) => {
        if (cancelled) return;
        if (looksBinary(text.slice(0, 8192))) { setState("binary"); return; }
        setPlain(text);
        setState("ok");
        if (text.length <= HIGHLIGHT_MAX) {
          highlightToHtml(text, langFromExtension(file.name))
            .then((h) => { if (!cancelled) { setHtml(h); requestAnimationFrame(() => find.refresh()); } })
            .catch(() => { /* keep plain */ });
        }
      })
      .catch(() => { if (!cancelled) setState("error"); });
    return () => { cancelled = true; };
  }, [rawUrl, file.name, file.size_bytes]); // eslint-disable-line react-hooks/exhaustive-deps

  // Ctrl/Cmd+F opens our find bar (intercept native find while a text file is shown)
  useEffect(() => {
    if (state !== "ok") return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "f") {
        e.preventDefault();
        setFindOpen(true);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [state]);

  if (state === "toobig") {
    return <OversizeFallback file={file} onDownload={onDownload} />;
  }
  if (state === "binary" || state === "error") {
    return <OversizeFallback file={file} onDownload={onDownload}
      note={state === "binary" ? "This file is not text-previewable." : "Failed to load file content."} />;
  }

  return (
    <div className="relative flex h-full w-full flex-col self-stretch overflow-hidden rounded-lg bg-[#1e1e1e]">
      <div className="sticky top-0 z-10 border-b border-white/10 bg-[#1e1e1e] px-4 py-2 font-mono text-[11px] text-white/40">
        {langFromExtension(file.name) === "text" ? ext.toUpperCase() : langFromExtension(file.name)}
      </div>
      {findOpen && <TextFindBar find={find} onClose={() => { setFindOpen(false); find.clear(); }} />}
      <div ref={contentRef} className="flex-1 overflow-auto text-[13px] leading-relaxed [&_pre]:m-0 [&_pre]:!bg-transparent [&_pre]:px-4 [&_pre]:py-4 [&_pre]:whitespace-pre-wrap [&_pre]:break-words">
        {html
          ? <div dangerouslySetInnerHTML={{ __html: html }} />
          : <pre className="m-0 whitespace-pre-wrap break-words px-4 py-4 font-mono text-[#d4d4d4]">{plain ?? "Loading…"}</pre>}
      </div>
    </div>
  );
}

function OversizeFallback({ file, onDownload, note }: { file: ViewerFile; onDownload: () => void; note?: string }) {
  const sizeStr = humanSize(file.size_bytes);
  return (
    <div className="rounded-xl border bg-[var(--color-bg)] p-10 text-center" style={{ borderColor: "var(--color-border)", minWidth: 280 }}>
      <p className="mb-3 text-4xl font-bold tracking-wider text-[var(--color-text-muted)]/40">{extOf(file.name).toUpperCase() || "FILE"}</p>
      <p className="mb-2 break-all text-sm text-[var(--color-text-muted)]">{file.name}</p>
      <p className="mb-5 text-xs text-[var(--color-text-muted)]">{note ?? `File too large to preview inline (${sizeStr}).`}</p>
      <button
        onClick={onDownload}
        className="inline-flex items-center gap-2 rounded-lg px-5 py-2.5 text-sm font-semibold text-white hover:opacity-90"
        style={{ background: "var(--color-primary)" }}
      >
        <Download size={16} /> Download
      </button>
    </div>
  );
}

export { downloadViaDialog };
