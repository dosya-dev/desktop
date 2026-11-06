// Ported from apps/web/src/components/file-detail-panel.tsx, merged with the
// desktop app's existing comments tab - keep in sync with the web copy.
import { useState, useEffect, useCallback, useMemo } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  X, Download, Copy, Trash2, Eye, Share2, Lock, RotateCcw, Loader2,
  MessageCircle, Send, CornerDownRight, Pencil,
} from "lucide-react";
import { toast } from "sonner";
import { autoDir, Bdi, Part, useAutoDir } from "@/lib/bidi-ui";
import { api, ApiError, apiBase } from "@/lib/api-client";
import { LIMITS, validateCommentBody } from "@dosya-dev/shared";
import { useT } from "@/lib/i18n";
import type { T } from "../../../i18n/translator";
import { richText } from "@/lib/rich-text";
import { useAvatarVersion, userAvatarUrl } from "@/lib/avatar-version";
import { usePermissions } from "@/lib/use-permissions";
import { fileRawUrl } from "@/lib/file-url";
import { humanSize, timeAgo, extOf, isImage, isVideo, isText, isAudio, colorFor, regionLabel, originLabel } from "@/lib/file-type";
import { FilePreviewImage } from "@/components/files/FilePreviewImage";
import { fileIconSrc } from "@/components/files/FileIcon";
import { type ViewerFile, downloadViaDialog } from "@/components/files/FileViewer";
import { DosyaVideo } from "@dosya-dev/video-player/react";
import "@dosya-dev/video-player/skin.css";

interface Version {
  id: string;
  version_number: number;
  size_bytes: number;
  extension: string | null;
  uploaded_by: string;
  created_at: number;
  uploader_name: string | null;
}

interface ShareLink {
  id: string;
  url: string;
  view_count: number;
  download_count: number;
  expires_at: number | null;
  is_password_protected: number;
  is_revoked: number;
  created_at: number;
}

interface Comment {
  id: string;
  user_id: string;
  parent_id: string | null;
  body: string;
  is_edited: number;
  created_at: number;
  user_name: string;
  user_email: string;
  user_avatar: string | null;
}

interface FileDetailPanelProps {
  file: ViewerFile;
  workspaceId: string;
  initialTab?: "info" | "comments";
  /** Opened from "Version history": list versions even when there is only one. */
  showVersions?: boolean;
  onClose: () => void;
  onCopy: (id: string) => void;
  onDelete: (id: string, name: string) => void;
  onShare: (id: string, name: string) => void;
  onView: (file: ViewerFile) => void;
  onRefresh: () => void;
}

/**
 * One file's comment thread, as the Comments tab reads it. Shared with the
 * panel's prefetch so both name the same cache entry.
 */
function commentsQuery(fileId: string, workspaceId: string) {
  return {
    queryKey: ["comments", fileId],
    queryFn: () =>
      api.get<{ ok: boolean; comments: Comment[] }>(
        `/api/comments?file_id=${fileId}&workspace_id=${workspaceId}`,
      ),
  };
}

/** How long the panel must stay on a file before its thread is fetched ahead. */
const COMMENTS_PREFETCH_DELAY_MS = 400;

export function FileDetailPanel({ file, workspaceId, initialTab = "info", showVersions = false, onClose, onCopy, onDelete, onShare, onView, onRefresh }: FileDetailPanelProps) {
  const ownDir = useAutoDir();
  const t = useT();
  const [tab, setTab] = useState<"info" | "comments">(initialTab);
  const panelQueryClient = useQueryClient();
  // Fetch the thread while the Info tab is showing, so opening Comments is
  // instant rather than a round trip after the click. Only once the panel has
  // settled on a file: arrowing through a folder must not fire one request
  // per file passed over.
  useEffect(() => {
    if (!workspaceId) return;
    const timer = setTimeout(() => {
      void panelQueryClient.prefetchQuery(commentsQuery(file.id, workspaceId));
    }, COMMENTS_PREFETCH_DELAY_MS);
    return () => clearTimeout(timer);
  }, [file.id, workspaceId, panelQueryClient]);
  const [versions, setVersions] = useState<Version[]>([]);
  const [currentVersion, setCurrentVersion] = useState(1);
  const [restoringVer, setRestoringVer] = useState<number | null>(null);
  const [unlockToken, setUnlockToken] = useState<string | null>(null);
  const [lockPassword, setLockPassword] = useState("");
  const [lockError, setLockError] = useState("");
  // The server's own sentence takes its own direction; a translation follows the page.
  const [lockErrorRaw, setLockErrorRaw] = useState(false);
  const [unlocking, setUnlocking] = useState(false);
  const [shareLinks, setShareLinks] = useState<ShareLink[]>([]);
  const [revokingLink, setRevokingLink] = useState<string | null>(null);

  const loadVersions = useCallback(async (fileId: string) => {
    try {
      const data = await api.get<{ ok: boolean; current_version: number; versions: Version[] }>(
        `/api/files/${fileId}/versions`,
      );
      // A lone version is noise in the panel, unless the user asked for the history.
      if (data.ok && data.versions && data.versions.length > (showVersions ? 0 : 1)) {
        setVersions(data.versions);
        setCurrentVersion(data.current_version);
      } else {
        setVersions([]);
      }
    } catch {
      setVersions([]);
    }
  }, [showVersions]);

  const loadShareLinks = useCallback(async (fileId: string) => {
    try {
      const data = await api.get<{ ok: boolean; links?: ShareLink[] }>(`/api/files/${fileId}/share`);
      if (data.ok && data.links) setShareLinks(data.links.filter((l) => !l.is_revoked));
      else setShareLinks([]);
    } catch { setShareLinks([]); }
  }, []);

  const revokeShareLink = async (linkId: string) => {
    setRevokingLink(linkId);
    try {
      await api.post(`/api/shares/${linkId}/revoke`);
      loadShareLinks(file.id);
      onRefresh();
    } catch { toast.error(t("common.error.revokeFailed"), { description: t("files.error.theShareLinkCouldNotBeRevoked") }); }
    setRevokingLink(null);
  };

  useEffect(() => {
    setVersions([]);
    setShareLinks([]);
    setUnlockToken(null);
    setLockPassword("");
    setLockError("");
    if (file.lock_mode !== "full_lock") {
      loadVersions(file.id);
      loadShareLinks(file.id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file.id, file.lock_mode]);

  const handleRestore = async (fileId: string, versionNumber: number) => {
    setRestoringVer(versionNumber);
    try {
      const res = await api.post<{ ok: boolean; error?: string }>(`/api/files/${fileId}/versions/restore`, {
        version_number: versionNumber,
      });
      if (res.ok) {
        toast.success(t("files.status.restored"), { description: t("files.description.restoredToVVersionNumber", { versionNumber: String(versionNumber) }) });
        loadVersions(fileId);
        onRefresh();
      } else {
        toast.error(t("files.error.restoreFailed"), { description: res.error != null ? autoDir(res.error) : t("files.error.restoreFailed") });
      }
    } catch {
      toast.error(t("files.error.restoreFailed"));
    }
    setRestoringVer(null);
  };

  const handleUnlock = async () => {
    if (!lockPassword.trim()) return;
    setUnlocking(true);
    setLockError("");
    try {
      const res = await api.post<{ ok: boolean; error?: string; unlock_token?: string }>(`/api/files/${file.id}/unlock`, {
        password: lockPassword,
      });
      if (res.ok && res.unlock_token) {
        setUnlockToken(res.unlock_token);
        loadVersions(file.id);
      } else {
        setLockError(res.error ?? t("files.error.incorrectPassword")); setLockErrorRaw(res.error != null);
        setLockPassword("");
      }
    } catch (err) {
      setLockError(err instanceof ApiError ? err.message : t("common.error.canTReachTheServerCheckYourConnectionAnd")); setLockErrorRaw(err instanceof ApiError);
      if (err instanceof ApiError) setLockPassword("");
    }
    setUnlocking(false);
  };

  const isLocked = file.lock_mode === "full_lock" && !unlockToken;
  const utSuffix = unlockToken ? `?ut=${unlockToken}` : "";
  const borderStyle = { borderColor: "var(--color-border)" };

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/20">
      <div className="fixed inset-0" onClick={onClose} />
      <div
        data-testid="file-detail-panel"
        className="relative z-10 flex h-full w-80 flex-col border-s bg-[var(--color-bg)] shadow-xl"
        style={borderStyle}
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b px-5 py-3" style={borderStyle}>
          <span className="text-sm font-semibold">{t("files.label.fileDetails")}</span>
          <button onClick={onClose} className="rounded p-1 hover:bg-[var(--color-bg-tertiary)]">
            <X size={14} />
          </button>
        </div>

        {isLocked ? (
          /* Locked gate */
          <div className="flex-1 overflow-y-auto">
            <div className="flex h-28 w-full items-center justify-center bg-violet-500">
              <Lock size={28} className="text-white" />
            </div>
            <div className="p-4">
              <p dir={ownDir} className="mb-1 break-all text-sm font-semibold">{file.name}</p>
              <p className="mb-4 text-xs text-[var(--color-text-muted)]">{t("files.label.thisFileIsLocked")}</p>
              <div className="space-y-2">
                <p className="text-xs text-[var(--color-text-muted)]">{t("files.description.enterTheLockPasswordToAccessThisFile")}</p>
                {lockError && <div dir={lockErrorRaw ? ownDir : undefined} className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-[var(--color-danger)]">{lockError}</div>}
                <input
                  type="password"
                  value={lockPassword}
                  onChange={(e) => setLockPassword(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && handleUnlock()}
                  placeholder={t("files.placeholder.enterPassword")}
                  className="h-9 w-full rounded-md border px-3 text-sm outline-none focus:border-[var(--color-primary)]"
                  style={borderStyle}
                  autoFocus
                />
                <button
                  className="flex w-full items-center justify-center gap-1.5 rounded-lg px-4 py-2 text-sm font-medium text-[var(--color-primary-fg)] disabled:opacity-50"
                  style={{ background: "var(--color-primary)" }}
                  onClick={handleUnlock}
                  disabled={unlocking}
                >
                  {unlocking ? <Loader2 size={14} className="animate-spin" /> : <Lock size={14} />}
                  {t("common.action.unlock")}
                </button>
              </div>
            </div>
          </div>
        ) : (
          <div className="flex flex-1 flex-col overflow-hidden">
            {/* Preview */}
            <FilePreview file={file} utSuffix={utSuffix} />

            {/* File name */}
            <div className="border-b px-5 py-3" style={borderStyle}>
              <div className="flex items-center gap-2">
                <p dir={ownDir} className="break-all text-sm font-semibold">{file.name}</p>
                {(file.current_version ?? 1) > 1 && (
                  <span className="shrink-0 rounded bg-[var(--color-bg-tertiary)] px-1.5 py-0.5 text-[9px] font-medium">{t("common.label.vVersion", { version: String(file.current_version) })}</span>
                )}
              </div>
              <p className="mt-0.5 text-xs text-[var(--color-text-muted)]">
                <Part>{humanSize(file.size_bytes)}</Part> · <Part dir="ltr">{file.mime_type}</Part> · <Part>{timeAgo(file.created_at)}</Part>
              </p>
              {file.lock_mode === "view_only" && (
                <span className="mt-1 inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[9px]" style={borderStyle}>
                  <Lock size={10} /> {t("common.status.viewOnly")}
                </span>
              )}
            </div>

            {/* Tabs */}
            <div className="flex border-b" style={borderStyle}>
              <button
                onClick={() => setTab("info")}
                className={`flex-1 py-2.5 text-xs font-medium transition-colors ${
                  tab === "info"
                    ? "border-b-2 border-[var(--color-primary)] text-[var(--color-primary)]"
                    : "text-[var(--color-text-secondary)]"
                }`}
              >
                {t("common.action.details")}
              </button>
              <button
                onClick={() => setTab("comments")}
                className={`flex flex-1 items-center justify-center gap-1.5 py-2.5 text-xs font-medium transition-colors ${
                  tab === "comments"
                    ? "border-b-2 border-[var(--color-primary)] text-[var(--color-primary)]"
                    : "text-[var(--color-text-secondary)]"
                }`}
              >
                <MessageCircle size={12} />
                {richText(t, "files.action.commentsCommentCount", {}, {
                  commentCount: file.comment_count > 0 && (
                    <span className="rounded-full bg-[var(--color-bg-tertiary)] px-1.5 text-xs">
                      {file.comment_count}
                    </span>
                  ),
                })}
              </button>
            </div>

            {tab === "info" ? (
              <div className="flex-1 overflow-y-auto">
                <div className="space-y-4 p-4">
                  {/* Version history */}
                  {versions.length > 0 && (
                    <div>
                      <div className="mb-2 flex items-center justify-between">
                        <span className="text-[10px] font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">{t("common.label.versions")}</span>
                        <span className="rounded bg-blue-100 px-1.5 py-0.5 text-[9px] font-medium text-blue-700">{t("common.label.vVersion", { version: String(currentVersion) })}</span>
                      </div>
                      <div className="max-h-40 space-y-0.5 overflow-y-auto">
                        {versions.map((v) => {
                          const isCurrent = v.version_number === currentVersion;
                          return (
                            <div key={v.id} className={`flex items-center gap-2 rounded px-2 py-1.5 text-[11px] ${isCurrent ? "bg-green-50" : "hover:bg-[var(--color-bg-secondary)]"}`}>
                              <span className={`min-w-5 font-bold ${isCurrent ? "text-green-600" : ""}`}>{t("common.label.vVersion", { version: String(v.version_number) })}</span>
                              <span className="min-w-0 flex-1 truncate text-[var(--color-text-muted)]">
                                <Part>{humanSize(v.size_bytes)}</Part> · {v.uploader_name != null ? <Bdi>{v.uploader_name}</Bdi> : t("files.label.unknown")} · <Part>{timeAgo(v.created_at)}</Part>
                              </span>
                              <div className="flex shrink-0 gap-1">
                                <button
                                  className="flex h-5 items-center rounded border px-1.5 text-[9px] font-medium hover:bg-[var(--color-bg-tertiary)]"
                                  style={borderStyle}
                                  title={t("files.tooltip.downloadVVersionNumber", { versionNumber: String(v.version_number) })}
                                  onClick={(e) => { e.stopPropagation(); downloadViaDialog(file, v.version_number); }}
                                >
                                  <Download size={10} />
                                </button>
                                {!isCurrent && (
                                  <button
                                    className="flex h-5 items-center rounded border border-blue-200 px-1.5 text-[9px] font-medium text-blue-600 hover:bg-blue-50"
                                    onClick={() => handleRestore(file.id, v.version_number)}
                                    disabled={restoringVer === v.version_number}
                                  >
                                    {restoringVer === v.version_number ? <Loader2 size={10} className="animate-spin" /> : <RotateCcw size={10} className="me-0.5" />}
                                    {t("files.action.restore")}
                                  </button>
                                )}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                      {versions.length === 1 && (
                        <p className="mt-1.5 px-2 text-[11px] text-[var(--color-text-muted)]">
                          {t("files.description.onlyOneVersionSoFarUploadANewVersionToStart")}
                        </p>
                      )}
                    </div>
                  )}

                  {/* Properties */}
                  <div>
                    <span className="mb-2 block text-[10px] font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">{t("files.label.properties")}</span>
                    <div className="space-y-1.5">
                      <PropRow label={t("files.label.uploadedBy")} value={file.uploader_name ?? t("files.label.unknown")} raw={file.uploader_name != null} />
                      <PropRow label={t("files.label.region")} value={regionLabel(file.region)} />
                      <PropRow label={t("files.label.created")} value={timeAgo(file.created_at)} />
                      <PropRow label={t("files.label.extension")} value={file.extension || extOf(file.name).toUpperCase() || "-"} raw />
                      {file.origin != null && <PropRow label={t("files.label.origin")} value={originLabel(file.origin)} />}
                    </div>
                  </div>

                  {/* Share links */}
                  {shareLinks.length > 0 && (
                    <div>
                      <span className="mb-2 block text-[10px] font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">{t("files.label.shareLinks")}</span>
                      <div className="space-y-2">
                        {shareLinks.map((link) => {
                          const now = Math.floor(Date.now() / 1000);
                          const expired = link.expires_at ? link.expires_at < now : false;
                          return (
                            <div key={link.id} className="space-y-1.5 rounded-md border bg-[var(--color-bg-secondary)] px-2.5 py-2" style={borderStyle}>
                              <div className="flex items-center gap-1.5">
                                <span dir="ltr" className="ltr-value flex-1 truncate font-mono text-[10px] text-[var(--color-text-muted)]">{link.url}</span>
                                <button
                                  className="shrink-0 text-[10px] font-semibold text-[var(--color-primary)] hover:opacity-80"
                                  onClick={() => { navigator.clipboard.writeText(link.url); toast.success(t("common.label.linkCopied"), { description: t("common.description.copiedToClipboard") }); }}
                                >{t("common.copy")}</button>
                              </div>
                              <div className="flex flex-wrap items-center gap-1.5 text-[8px]">
                                <span className="rounded bg-[var(--color-bg-tertiary)] px-1.5 py-0.5">{t("files.label.viewcountViews", { viewCount: String(link.view_count) })}</span>
                                <span className="rounded bg-[var(--color-bg-tertiary)] px-1.5 py-0.5">
                                  {expired ? t("common.status.expired") : link.expires_at ? t("common.label.expiresDate", { date: timeAgo(link.expires_at) }) : t("files.label.noExpiry")}
                                </span>
                                {link.is_password_protected === 1 && <span className="rounded bg-[var(--color-bg-tertiary)] px-1.5 py-0.5">{t("common.label.password")}</span>}
                              </div>
                              <button
                                className="text-[10px] font-medium text-[var(--color-danger)] hover:underline"
                                onClick={() => revokeShareLink(link.id)}
                                disabled={revokingLink === link.id}
                              >
                                {revokingLink === link.id ? t("files.status.revoking") : t("files.action.revokeLink")}
                              </button>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  )}

                  {/* Actions */}
                  <div className="space-y-1.5 pt-1">
                    <ActionButton icon={<Eye size={14} className="text-[var(--color-text-muted)]" />} label={t("files.action.viewFile")} onClick={() => onView(file)} />
                    <button
                      className="flex h-10 w-full items-center justify-start gap-2 rounded-lg px-3 text-xs font-medium text-[var(--color-primary-fg)]"
                      style={{ background: "var(--color-primary)" }}
                      onClick={() => downloadViaDialog(file)}
                    >
                      <Download size={14} /> {t("common.action.download")}
                    </button>
                    <ActionButton icon={<Share2 size={14} className="text-[var(--color-text-muted)]" />} label={t("files.action.share")} onClick={() => onShare(file.id, file.name)} />
                    <ActionButton icon={<Copy size={14} className="text-[var(--color-text-muted)]" />} label={t("files.action.copyFile")} onClick={() => onCopy(file.id)} />
                    <button
                      className="flex h-10 w-full items-center justify-start gap-2 rounded-lg border px-3 text-xs font-medium text-[var(--color-danger)] hover:bg-red-50"
                      style={{ borderColor: "rgba(239,68,68,0.3)" }}
                      onClick={() => onDelete(file.id, file.name)}
                    >
                      <Trash2 size={14} /> {t("files.action.deleteFile")}
                    </button>
                  </div>
                </div>
              </div>
            ) : (
              <CommentsTab file={file} workspaceId={workspaceId} />
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function ActionButton({ icon, label, onClick }: { icon: React.ReactNode; label: string; onClick: () => void }) {
  return (
    <button
      className="flex h-10 w-full items-center justify-start gap-2 rounded-lg border px-3 text-xs font-medium hover:bg-[var(--color-bg-secondary)]"
      style={{ borderColor: "var(--color-border)" }}
      onClick={onClick}
    >
      {icon} {label}
    </button>
  );
}

// ── thumbnail-scale preview ────────────────────────────────

/** Exported for FileDetailPanel.test.tsx. */
export function FilePreview({ file, utSuffix }: { file: ViewerFile; utSuffix: string }) {
  const t = useT();
  const [previewError, setPreviewError] = useState(false);
  const [textContent, setTextContent] = useState<string | null>(null);

  useEffect(() => {
    setPreviewError(false);
    setTextContent(null);
    if (isText(file.name)) {
      fetch(fileRawUrl({ fileId: file.id, query: utSuffix.replace(/^\?/, "") }), { credentials: "include" })
        .then((r) => (r.ok ? r.text() : Promise.reject()))
        .then((text) => setTextContent(text.slice(0, 2000)))
        .catch(() => setPreviewError(true));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file.id, file.name, utSuffix]);

  const rawWithUt = fileRawUrl({ fileId: file.id, query: utSuffix.replace(/^\?/, "") });

  if (previewError || (!isImage(file.name) && !isVideo(file.name) && !file.name.toLowerCase().endsWith(".pdf") && !isText(file.name) && !isAudio(file.name))) {
    const ext = extOf(file.name).toUpperCase() || t("common.label.fileUppercase");
    return (
      <div className="flex h-28 w-full items-center justify-center" style={{ background: colorFor(file.name) + "18" }}>
        <img src={fileIconSrc(file.name)} alt={ext} className="h-16 w-16" />
      </div>
    );
  }

  if (isImage(file.name)) {
    return (
      <div className="flex h-28 w-full items-center justify-center overflow-hidden bg-[var(--color-bg-tertiary)]">
        <FilePreviewImage
          fileId={file.id}
          fileName={file.name}
          query={utSuffix.replace(/^\?/, "")}
          size={512}
          className="h-full w-full object-contain"
          alt={file.name}
          fallback={
            <div className="flex h-28 w-full items-center justify-center" style={{ background: colorFor(file.name) + "18" }}>
              <img src={fileIconSrc(file.name)} alt={extOf(file.name).toUpperCase() || t("common.label.fileUppercase")} className="h-16 w-16" />
            </div>
          }
        />
      </div>
    );
  }

  if (isVideo(file.name)) {
    return (
      <div className="flex h-48 w-full items-center justify-center overflow-hidden bg-black">
        {/* The shared player in compact mode: keys only while it has focus, so
            it never takes arrows or Space from the file list. A failure shows
            the panel's own icon fallback below instead of the player's card. */}
        <DosyaVideo
          identity={`${file.id}:${utSuffix}`}
          src={rawWithUt}
          className="flex h-full w-full items-center justify-center"
          compact
          preload="metadata"
          autoplay={false}
          failureText=""
          downloadUrl={null}
          title={file.name}
          onFailed={() => setPreviewError(true)}
        />
      </div>
    );
  }

  if (file.name.toLowerCase().endsWith(".pdf")) {
    return (
      <div className="h-48 w-full overflow-hidden bg-[var(--color-bg-tertiary)]">
        <iframe
          src={`${rawWithUt}#toolbar=0&navpanes=0`}
          className="h-full w-full border-none"
          title={t("files.tooltip.pdfPreviewOfFileName", { fileName: file.name })}
        />
      </div>
    );
  }

  if (isAudio(file.name)) {
    return (
      <div className="flex h-20 w-full items-center justify-center bg-[var(--color-bg-secondary)] px-4">
        <audio src={rawWithUt} controls className="h-10 w-full" preload="metadata" />
      </div>
    );
  }

  if (isText(file.name)) {
    return (
      <div className="h-40 w-full overflow-hidden bg-[#1e1e1e]">
        <pre className="m-0 h-full overflow-hidden whitespace-pre-wrap break-all p-3 font-mono text-[11px] leading-relaxed text-[#d4d4d4]">
          {textContent ?? t("common.status.loading")}
        </pre>
      </div>
    );
  }

  return null;
}

// ── comments tab ───────────────────────────────────────────

/**
 * validateCommentBody's verdict in the chosen language. The shared rule
 * decides; its two branches are told apart by its own documented condition,
 * never by reading the English sentence.
 */
function commentError(t: T, body: string): string | null {
  if (validateCommentBody(body) === null) return null;
  return body.trim().length === 0
    ? t("files.error.commentBodyIsRequired")
    : t("files.error.commentTooLongMaxMaxCharacters", { max: String(LIMITS.COMMENT_BODY_MAX) });
}

function CommentsTab({ file, workspaceId }: { file: ViewerFile; workspaceId: string }) {
  const t = useT();
  const [newComment, setNewComment] = useState("");
  const [replyTo, setReplyTo] = useState<Comment | null>(null);
  const [editId, setEditId] = useState<string | null>(null);
  const [editBody, setEditBody] = useState("");
  const { userId, roleName } = usePermissions();
  const queryClient = useQueryClient();

  const { data: commentsData, isLoading: commentsLoading } = useQuery(commentsQuery(file.id, workspaceId));

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["comments", file.id] });
  // Widened from ApiError: a local policy refusal is a plain Error carrying the
  // sentence the API would have returned, and "Failed" is not that sentence.
  const failed = (e: unknown) => toast.error(e instanceof ApiError ? autoDir(e.message) : e instanceof Error ? e.message : t("common.error.failed"));

  const postMut = useMutation({
    mutationFn: (input: { body: string; parentId: string | null }) => {
      // 5000 characters, from the shared policy. A pasted essay used to upload
      // in full and come back refused.
      const problem = commentError(t, input.body);
      if (problem) throw new Error(problem);
      return api.post<{ ok: boolean; comment: Comment }>("/api/comments", {
        file_id: file.id,
        workspace_id: workspaceId,
        body: input.body,
        // Absence means top level. A null would be looked up, and the API answers
        // a parent it cannot find with a 404.
        ...(input.parentId ? { parent_id: input.parentId } : {}),
      });
    },
    // Cleared on success only, so a failed post leaves the typed text in place.
    // The server answers with the stored comment, shaped as the list's rows
    // are; it goes straight into the thread instead of costing a second round
    // trip to read the whole thread again.
    onSuccess: (res) => {
      if (res?.comment) {
        queryClient.setQueryData<{ ok: boolean; comments: Comment[] }>(["comments", file.id], (old) =>
          old ? { ...old, comments: [...old.comments, res.comment] } : old);
        if (!queryClient.getQueryData(["comments", file.id])) invalidate();
      } else {
        invalidate();
      }
      setNewComment("");
      setReplyTo(null);
    },
    onError: failed,
  });

  const editMut = useMutation({
    mutationFn: (v: { id: string; body: string }) => {
      const problem = commentError(t, v.body);
      if (problem) throw new Error(problem);
      return api.put(`/api/comments/${v.id}`, { body: v.body });
    },
    onSuccess: () => { invalidate(); setEditId(null); },
    // Only the author may edit. A 403 means the UI offered something the server
    // refuses, so refetch and stop disagreeing with it.
    onError: (e) => { failed(e); invalidate(); },
  });

  const deleteMut = useMutation({
    mutationFn: (id: string) => api.delete(`/api/comments/${id}`),
    onSuccess: () => { invalidate(); toast.success(t("files.label.commentDeleted")); },
    onError: (e) => { failed(e); invalidate(); },
  });

  const comments = commentsData?.comments ?? [];

  /**
   * Group by ROOT ancestor, not by parent_id.
   *
   * This read parent_id exactly once, so it drew top-level comments and their
   * direct children and nothing else - a reply to a reply, which web lets anyone
   * write, was fetched, counted in the tab's badge, and never rendered. Walking
   * up to the root keeps the single indent while making every depth visible.
   */
  const rootOf = useMemo(() => {
    const byId = new Map(comments.map((c) => [c.id, c]));
    return (c: Comment): string => {
      let cur = c;
      const seen = new Set<string>([cur.id]);
      while (cur.parent_id) {
        const parent = byId.get(cur.parent_id);
        // A cycle cannot happen through the API, but an unbounded walk over
        // server data is not something to leave to chance.
        if (!parent || seen.has(parent.id)) break;
        cur = parent;
        seen.add(cur.id);
      }
      return cur.id;
    };
  }, [comments]);

  const topLevel = comments.filter((c) => !c.parent_id);
  const replies = (parentId: string) => comments.filter((c) => !!c.parent_id && rootOf(c) === parentId);

  const submit = () => {
    const body = newComment.trim();
    if (!body) return;
    postMut.mutate({ body, parentId: replyTo?.id ?? null });
  };

  const bubbleProps = (c: Comment) => ({
    comment: c,
    canEdit: !!userId && c.user_id === userId,
    // The author, or an owner/admin on anyone's comment - the rule the API
    // enforces. Compared case-insensitively: role_name comes from the roles
    // table and the server's check is lowercase.
    canDelete:
      (!!userId && c.user_id === userId) ||
      ["owner", "admin"].includes((roleName ?? "").toLowerCase()),
    editing: editId === c.id,
    editBody,
    busy: editMut.isPending || deleteMut.isPending,
    onReply: () => setReplyTo(c),
    onStartEdit: () => { setEditId(c.id); setEditBody(c.body); },
    onEditBody: setEditBody,
    onSaveEdit: () => {
      const body = editBody.trim();
      if (!body) return;
      editMut.mutate({ id: c.id, body });
    },
    onCancelEdit: () => setEditId(null),
    onDelete: () => deleteMut.mutate(c.id),
  });

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      {/* Comments list */}
      <div className="flex-1 overflow-y-auto px-4 py-3">
        {commentsLoading ? (
          <div className="space-y-3">
            {[1, 2, 3].map((i) => (
              <div key={i} className="h-14 animate-pulse rounded-lg bg-[var(--color-bg-tertiary)]" />
            ))}
          </div>
        ) : comments.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-10 text-center">
            <MessageCircle size={28} className="mb-2 text-[var(--color-text-muted)]" />
            <p className="text-sm text-[var(--color-text-muted)]">{t("files.empty.noCommentsYet")}</p>
            <p className="text-xs text-[var(--color-text-muted)]">{t("files.label.beTheFirstToComment")}</p>
          </div>
        ) : (
          <div className="space-y-3">
            {topLevel.map((c) => (
              <div key={c.id}>
                <CommentBubble {...bubbleProps(c)} />
                {replies(c.id).map((r) => (
                  <div key={r.id} className="ms-6 mt-2">
                    <CommentBubble {...bubbleProps(r)} />
                  </div>
                ))}
              </div>
            ))}
          </div>
        )}
      </div>

      {replyTo && (
        <div
          data-testid="comment-reply-strip"
          className="flex items-center gap-2 border-t px-4 py-2 text-xs text-[var(--color-text-muted)]"
          style={{ borderColor: "var(--color-border)" }}
        >
          <CornerDownRight size={12} className="shrink-0 rtl:-scale-x-100" />
          <span className="truncate">
            {richText(t, "files.label.replyingToUserName", {}, {
              userName: <span className="font-medium text-[var(--color-text-primary)]">{replyTo.user_name}</span>,
            })}
          </span>
          <button
            data-testid="comment-reply-cancel"
            onClick={() => setReplyTo(null)}
            className="ms-auto shrink-0"
            title={t("files.tooltip.cancelReply")}
          >
            <X size={12} />
          </button>
        </div>
      )}

      {/* New comment input */}
      <div className="border-t px-4 py-3" style={{ borderColor: "var(--color-border)" }}>
        <div className="flex items-end gap-2">
          <textarea
            data-testid="comment-input"
            value={newComment}
            onChange={(e) => setNewComment(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && newComment.trim()) {
                e.preventDefault();
                submit();
              }
            }}
            placeholder={replyTo ? t("files.placeholder.replyToUserName", { userName: replyTo.user_name }) : t("files.placeholder.writeAComment")}
            rows={1}
            className="flex-1 resize-none rounded-lg border px-3 py-2 text-sm outline-none focus:border-[var(--color-primary)]"
            style={{ borderColor: "var(--color-border)" }}
          />
          <button
            data-testid="comment-send"
            onClick={submit}
            disabled={!newComment.trim() || postMut.isPending}
            className="rounded-lg p-2 text-[var(--color-primary-fg)] disabled:opacity-50"
            style={{ background: "var(--color-primary)" }}
          >
            <Send size={14} className="rtl:-scale-x-100" />
          </button>
        </div>
      </div>
    </div>
  );
}

// user_avatar is an R2 object key, not a URL - it flags that a photo exists,
// and the bytes stream through the authenticated API. A failed fetch degrades
// to initials; failedAt is compared to the avatar version so a new upload by
// the signed-in user retries instead of staying stuck on initials.
function CommentAvatar({ comment }: { comment: Comment }) {
  const version = useAvatarVersion((s) => s.version);
  const [failedAt, setFailedAt] = useState<number | null>(null);
  if (!comment.user_avatar || failedAt === version) {
    return (
      <div
        className="flex h-5 w-5 items-center justify-center rounded-full text-[10px] font-medium text-[var(--color-primary-fg)]"
        style={{ background: "var(--color-primary)" }}
      >
        {comment.user_name?.charAt(0).toUpperCase() || "?"}
      </div>
    );
  }
  return (
    <img
      key={`${comment.user_id}-${version}`}
      src={userAvatarUrl(apiBase(), comment.user_id, version)}
      alt=""
      className="h-5 w-5 rounded-full object-cover"
      onError={() => setFailedAt(version)}
    />
  );
}

function CommentBubble(props: {
  comment: Comment;
  canEdit: boolean;
  canDelete: boolean;
  editing: boolean;
  editBody: string;
  busy: boolean;
  onReply: () => void;
  onStartEdit: () => void;
  onEditBody: (v: string) => void;
  onSaveEdit: () => void;
  onCancelEdit: () => void;
  onDelete: () => void;
}) {
  const ownDir = useAutoDir();
  const { comment } = props;
  const t = useT();
  return (
    <div
      data-testid={`comment-${comment.id}`}
      className="group rounded-lg bg-[var(--color-bg-secondary)] px-3 py-2.5"
    >
      <div className="mb-1 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <CommentAvatar comment={comment} />
          <span dir={ownDir} className="text-xs font-medium">{comment.user_name}</span>
          <span className="text-[10px] text-[var(--color-text-muted)]">
            {timeAgo(comment.created_at)}
            {comment.is_edited === 1 && (
              <span data-testid={`comment-${comment.id}-edited`}> {t("files.label.edited")}</span>
            )}
          </span>
        </div>
        {/* Quiet until hover, but present in the DOM either way - a control that
            only exists on hover cannot be reached from the keyboard. */}
        <div className="flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
          <button
            data-testid={`comment-${comment.id}-reply`}
            onClick={props.onReply}
            title={t("files.tooltip.reply")}
            className="rounded p-0.5 text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)]"
          >
            <CornerDownRight size={12} className="rtl:-scale-x-100" />
          </button>
          {props.canEdit && (
            <button
              data-testid={`comment-${comment.id}-edit`}
              onClick={props.onStartEdit}
              title={t("files.edit")}
              className="rounded p-0.5 text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)]"
            >
              <Pencil size={12} />
            </button>
          )}
          {/* Delete used to render for every reader and answer with a 403 for
              anyone who was neither the author nor an admin. */}
          {props.canDelete && (
            <button
              data-testid={`comment-${comment.id}-delete`}
              onClick={props.onDelete}
              title={t("common.delete")}
              className="rounded p-0.5 text-[var(--color-text-muted)] hover:text-[var(--color-danger)]"
            >
              <Trash2 size={12} />
            </button>
          )}
        </div>
      </div>

      {props.editing ? (
        <div>
          <textarea
            data-testid="comment-edit-input"
            value={props.editBody}
            onChange={(e) => props.onEditBody(e.target.value)}
            rows={2}
            autoFocus
            className="w-full resize-none rounded-lg border px-2 py-1.5 text-sm outline-none focus:border-[var(--color-primary)]"
            style={{ borderColor: "var(--color-border)" }}
          />
          <div className="mt-1.5 flex justify-end gap-2">
            <button
              data-testid="comment-edit-cancel"
              onClick={props.onCancelEdit}
              className="text-xs text-[var(--color-text-muted)]"
            >
              {t("common.cancel")}
            </button>
            <button
              data-testid="comment-edit-save"
              onClick={props.onSaveEdit}
              disabled={!props.editBody.trim() || props.busy}
              className="text-xs font-medium text-[var(--color-primary)] disabled:opacity-50"
            >
              {t("common.save")}
            </button>
          </div>
        </div>
      ) : (
        <p dir={ownDir} className="whitespace-pre-wrap text-sm">{comment.body}</p>
      )}
    </div>
  );
}

/** `raw`: the value is user or server text and takes its own direction; otherwise it follows the page. */
function PropRow({ label, value, raw = false }: { label: string; value: string; raw?: boolean }) {
  const ownDir = useAutoDir();
  return (
    <div className="flex items-center justify-between">
      <span className="text-xs text-[var(--color-text-muted)]">{label}</span>
      <span dir={raw ? ownDir : undefined} className="max-w-32 truncate text-end text-xs font-medium">{value}</span>
    </div>
  );
}
