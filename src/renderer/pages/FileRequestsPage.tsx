import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  FileUp,
  Plus,
  Copy,
  Lock,
  Clock,
  Mail,
  Send,
  Trash2,
  X,
  Pencil,
  ChevronRight,
  Loader2,
} from "lucide-react";
import { api, ApiError } from "@/lib/api-client";
import { useWorkspace } from "@/lib/workspace-context";
import { formatDate, formatRelative } from "@/lib/format";
import { toast } from "sonner";

interface FileRequest {
  id: string;
  token: string;
  title: string | null;
  message: string | null;
  is_password_protected: number;
  expires_at: number | null;
  allowed_extensions: string | null;
  max_file_size_bytes: number | null;
  max_files: number | null;
  upload_count: number;
  is_revoked: number;
  created_at: number;
  folder_id: string | null;
  created_by_name: string | null;
  folder_name: string | null;
  url: string;
}

interface Recipient {
  id: string;
  email: string;
  sent_at: number | null;
  uploaded_at: number | null;
  created_at: number;
}

interface RequestUpload {
  id: string;
  file_id: string;
  uploader_email: string | null;
  uploader_name: string | null;
  created_at: number;
  file_name: string;
  size_bytes: number;
}

type RequestStatus = "closed" | "expired" | "full" | "active";

/**
 * Why a request is or is not accepting uploads. Mirrors
 * apps/mobile/src/requests/status.ts: closed outranks expired because closing it
 * was the deliberate act, and `full` is its own state because at max_files the
 * request refuses the next upload while an "Active" chip would say otherwise.
 */
function requestStatus(r: FileRequest, now: number): RequestStatus {
  if (r.is_revoked === 1) return "closed";
  if (r.expires_at !== null && r.expires_at < now) return "expired";
  if (r.max_files !== null && r.upload_count >= r.max_files) return "full";
  return "active";
}

const STATUS_STYLE: Record<RequestStatus, string> = {
  active: "bg-[var(--color-primary)]/10 text-[var(--color-primary)]",
  full: "bg-[var(--color-bg-tertiary)] text-[var(--color-text-primary)]",
  expired: "bg-[var(--color-bg-tertiary)] text-[var(--color-text-muted)]",
  closed: "bg-[var(--color-bg-tertiary)] text-[var(--color-text-muted)]",
};

const STATUS_LABEL: Record<RequestStatus, string> = {
  active: "Active", full: "Full", expired: "Expired", closed: "Closed",
};

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) { value /= 1024; i++; }
  return `${value.toFixed(1)} ${units[i]}`;
}

export function FileRequestsPage() {
  const { active } = useWorkspace();
  const queryClient = useQueryClient();
  const [showCreate, setShowCreate] = useState(false);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [closeTarget, setCloseTarget] = useState<FileRequest | null>(null);
  const [title, setTitle] = useState("");
  const [email, setEmail] = useState("");
  const [message, setMessage] = useState("");
  const [maxFiles, setMaxFiles] = useState("");
  const [expiryDays, setExpiryDays] = useState("7");

  const { data, isLoading } = useQuery({
    queryKey: ["file-requests", active?.id],
    queryFn: () =>
      api.get<{ ok: boolean; requests: FileRequest[] }>(
        `/api/file-requests?workspace_id=${active?.id}`,
      ),
    enabled: !!active,
  });

  const createMut = useMutation({
    mutationFn: () =>
      api.post("/api/file-requests/create", {
        workspace_id: active!.id,
        title: title.trim(),
        message: message.trim() || null,
        max_files: maxFiles ? Number(maxFiles) : null,
        expires_in_days: expiryDays ? Number(expiryDays) : null,
        // RECIPIENTS GO IN `emails`, AS AN ARRAY. This used to send
        // recipient_email, which the endpoint does not read at all - so the
        // request was created, nobody was invited, and nothing said so.
        emails: email.trim() ? [email.trim()] : undefined,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["file-requests"] });
      setShowCreate(false);
      setTitle(""); setEmail(""); setMessage(""); setMaxFiles(""); setExpiryDays("7");
      toast.success(email.trim() ? "File request sent" : "File request created");
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : "Failed"),
  });

  const closeMut = useMutation({
    mutationFn: (id: string) => api.delete(`/api/file-requests/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["file-requests"] });
      // DELETE sets is_revoked = 1 and keeps the row. Calling it a delete made
      // the request's continued presence in this list look like a bug.
      toast.success("Request closed");
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : "Failed"),
  });

  const requests = data?.requests ?? [];
  const now = Date.now() / 1000;
  const detail = requests.find((r) => r.id === detailId) ?? null;

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">File Requests</h1>
          <p className="text-sm text-[var(--color-text-muted)]">
            Request files from anyone - they don't need an account
          </p>
        </div>
        <button
          data-testid="request-new"
          onClick={() => setShowCreate(true)}
          className="flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-medium text-white"
          style={{ background: "var(--color-primary)" }}
        >
          <Plus size={14} /> New request
        </button>
      </div>

      {isLoading ? (
        <div className="space-y-3">{[1, 2, 3].map(i => <div key={i} className="h-20 animate-pulse rounded-xl bg-[var(--color-bg-tertiary)]" />)}</div>
      ) : requests.length === 0 ? (
        <div className="flex flex-col items-center justify-center rounded-xl border py-16" style={{ borderColor: "var(--color-border)" }} data-testid="requests-empty">
          <FileUp size={36} className="mb-3 text-[var(--color-text-muted)]" />
          <p className="text-sm font-medium">No file requests yet</p>
          <p className="mt-1 text-xs text-[var(--color-text-muted)]">Create a request to receive files from anyone</p>
        </div>
      ) : (
        // One bordered card of rows, matching apps/web's file requests list.
        // Previously each request was its own floating card, which at three or
        // more requests read as a pile of boxes rather than a list.
        <div className="overflow-hidden rounded-xl border" style={{ borderColor: "var(--color-border)" }}>
          {requests.map((req) => {
            const status = requestStatus(req, now);
            const revoked = req.is_revoked === 1;
            const title = req.title || "Untitled request";
            return (
              <div
                key={req.id}
                data-testid={`request-${req.id}`}
                className={`flex items-center gap-3 border-b px-4 py-3.5 transition-colors last:border-b-0 hover:bg-[var(--color-bg-secondary)] ${revoked ? "opacity-60" : ""}`}
                style={{ borderColor: "var(--color-border)" }}
              >
                <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-[var(--color-bg-tertiary)] text-[var(--color-text-muted)]">
                  <Mail size={16} />
                </div>

                <div className="min-w-0 flex-1">
                  <p className={`truncate text-sm font-medium ${revoked ? "line-through" : ""}`} title={title}>
                    {title}
                  </p>
                  <div className="mt-1 flex flex-wrap items-center gap-2">
                    <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${STATUS_STYLE[status]}`}>
                      {STATUS_LABEL[status]}
                    </span>
                    <span className="rounded-full bg-[var(--color-bg-tertiary)] px-2 py-0.5 text-[10px] font-medium text-[var(--color-text-secondary)]">
                      {req.upload_count} file{req.upload_count === 1 ? "" : "s"}
                    </span>
                    {req.is_password_protected === 1 && (
                      <span className="flex items-center gap-1 rounded-full bg-[var(--color-bg-tertiary)] px-2 py-0.5 text-[10px] font-medium text-[var(--color-text-secondary)]">
                        <Lock size={9} /> Password
                      </span>
                    )}
                    <span className="truncate text-[11px] text-[var(--color-text-muted)]">
                      {req.folder_name ?? (req.folder_id ? "Unknown folder" : "Workspace root")}
                    </span>
                    {req.expires_at && (
                      <span className="flex items-center gap-1 text-[11px] text-[var(--color-text-muted)]">
                        <Clock size={10} /> Expires {formatDate(req.expires_at)}
                      </span>
                    )}
                    <span className="text-[11px] text-[var(--color-text-muted)]">
                      Created {formatRelative(req.created_at)}
                    </span>
                  </div>
                </div>

                <div className="flex shrink-0 items-center gap-1.5">
                  <button
                    data-testid={`request-${req.id}-open`}
                    onClick={() => setDetailId(req.id)}
                    className="flex h-7 items-center gap-1 rounded-lg border px-2.5 text-xs hover:bg-[var(--color-bg-tertiary)]"
                    style={{ borderColor: "var(--color-border)" }}
                  >
                    Details <ChevronRight size={11} />
                  </button>
                  {!revoked && (
                    <button
                      data-testid={`request-${req.id}-copy`}
                      onClick={() => { navigator.clipboard.writeText(req.url); toast.success("Link copied"); }}
                      className="flex h-7 items-center gap-1 rounded-lg border px-2.5 text-xs hover:bg-[var(--color-bg-tertiary)]"
                      style={{ borderColor: "var(--color-border)" }}
                    >
                      <Copy size={11} /> Copy link
                    </button>
                  )}
                  {!revoked && (
                    <button
                      data-testid={`request-${req.id}-close`}
                      onClick={() => setCloseTarget(req)}
                      className="flex h-7 items-center gap-1 rounded-lg border px-2.5 text-xs text-[var(--color-danger)] hover:bg-[var(--color-danger)]/10"
                      style={{ borderColor: "color-mix(in oklab, var(--color-danger) 30%, transparent)" }}
                    >
                      <Lock size={11} /> Close
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Create Modal */}
      {showCreate && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30">
          <div className="w-full max-w-md rounded-xl bg-[var(--color-bg)] p-6 shadow-xl" onClick={(e) => e.stopPropagation()}>
            <h3 className="mb-4 text-lg font-semibold">New file request</h3>
            <div className="space-y-3">
              <div>
                <label className="mb-1 block text-sm font-medium">Title *</label>
                <input data-testid="create-title" type="text" value={title} onChange={(e) => setTitle(e.target.value)} autoFocus placeholder="e.g. Brand assets for Q2 campaign" className="w-full rounded-lg border px-3 py-2 text-sm outline-none focus:border-[var(--color-primary)]" style={{ borderColor: "var(--color-border)" }} />
              </div>
              <div>
                <label className="mb-1 block text-sm font-medium">Invite by email (optional)</label>
                <input data-testid="create-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="recipient@example.com" className="w-full rounded-lg border px-3 py-2 text-sm outline-none focus:border-[var(--color-primary)]" style={{ borderColor: "var(--color-border)" }} />
              </div>
              <div>
                <label className="mb-1 block text-sm font-medium">Message (optional)</label>
                <textarea data-testid="create-message" value={message} onChange={(e) => setMessage(e.target.value)} rows={2} placeholder="Any instructions for the uploader..." className="w-full resize-none rounded-lg border px-3 py-2 text-sm outline-none focus:border-[var(--color-primary)]" style={{ borderColor: "var(--color-border)" }} />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="mb-1 block text-sm font-medium">Expires in (days)</label>
                  <input data-testid="create-expiry" type="number" value={expiryDays} onChange={(e) => setExpiryDays(e.target.value)} min={1} max={90} className="w-full rounded-lg border px-3 py-2 text-sm outline-none focus:border-[var(--color-primary)]" style={{ borderColor: "var(--color-border)" }} />
                </div>
                <div>
                  <label className="mb-1 block text-sm font-medium">Max files</label>
                  <input data-testid="create-max-files" type="number" value={maxFiles} onChange={(e) => setMaxFiles(e.target.value)} min={1} placeholder="Unlimited" className="w-full rounded-lg border px-3 py-2 text-sm outline-none focus:border-[var(--color-primary)]" style={{ borderColor: "var(--color-border)" }} />
                </div>
              </div>
            </div>
            <div className="mt-5 flex justify-end gap-2">
              <button data-testid="create-cancel" onClick={() => setShowCreate(false)} className="rounded-lg border px-4 py-2 text-sm" style={{ borderColor: "var(--color-border)" }}>Cancel</button>
              <button data-testid="create-submit" onClick={() => createMut.mutate()} disabled={!title.trim() || createMut.isPending} className="rounded-lg px-4 py-2 text-sm font-medium text-white disabled:opacity-50" style={{ background: "var(--color-primary)" }}>
                {createMut.isPending ? "Creating..." : "Create request"}
              </button>
            </div>
          </div>
          <div className="fixed inset-0 -z-10" onClick={() => setShowCreate(false)} />
        </div>
      )}

      {closeTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30">
          <div className="w-full max-w-sm rounded-xl bg-[var(--color-bg)] p-6 shadow-xl">
            <h3 className="text-lg font-semibold">Close this request?</h3>
            <p className="mt-2 text-sm text-[var(--color-text-muted)]">
              It stops accepting uploads. Files already received are kept, and the
              request stays in this list marked Closed.
            </p>
            <div className="mt-5 flex justify-end gap-2">
              <button data-testid="close-cancel" onClick={() => setCloseTarget(null)} className="rounded-lg border px-4 py-2 text-sm" style={{ borderColor: "var(--color-border)" }}>Cancel</button>
              <button
                data-testid="close-confirm"
                onClick={() => { const t = closeTarget; setCloseTarget(null); closeMut.mutate(t.id); }}
                className="rounded-lg px-4 py-2 text-sm font-medium text-white"
                style={{ background: "var(--color-danger)" }}
              >
                Close request
              </button>
            </div>
          </div>
        </div>
      )}

      {detail && <RequestDetailPanel request={detail} onClose={() => setDetailId(null)} />}
    </div>
  );
}

/**
 * One request in full: what arrived, who was asked, and an edit form.
 *
 * A panel rather than a second route, because this page already owns the data and
 * desktop's shell has no nested routing for it.
 */
function RequestDetailPanel({ request, onClose }: { request: FileRequest; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [newEmail, setNewEmail] = useState("");
  const [addError, setAddError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [editTitle, setEditTitle] = useState(request.title ?? "");
  const [editMessage, setEditMessage] = useState(request.message ?? "");

  const closed = request.is_revoked === 1;

  const uploadsQ = useQuery({
    queryKey: ["file-request", request.id, "uploads"],
    queryFn: () => api.get<{ ok: boolean; uploads: RequestUpload[] }>(`/api/file-requests/${request.id}/uploads`),
  });
  const recipientsQ = useQuery({
    queryKey: ["file-request", request.id, "recipients"],
    queryFn: () => api.get<{ ok: boolean; recipients: Recipient[] }>(`/api/file-requests/${request.id}/recipients`),
  });

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ["file-request", request.id] });
    queryClient.invalidateQueries({ queryKey: ["file-requests"] });
  };

  const addMut = useMutation({
    mutationFn: (value: string) => api.post(`/api/file-requests/${request.id}/recipients`, { email: value }),
    onSuccess: () => { setNewEmail(""); setAddError(null); invalidate(); },
    // 409 (already a recipient) and 410 (request closed) are both about the
    // address just typed, so they belong beside the field.
    onError: (e) => setAddError(e instanceof ApiError ? e.message : "Could not add that address"),
  });

  const removeMut = useMutation({
    mutationFn: (recipientId: string) =>
      api.delete(`/api/file-requests/${request.id}/recipients?recipient_id=${recipientId}`),
    onSuccess: invalidate,
    onError: (e) => toast.error(e instanceof ApiError ? e.message : "Failed"),
  });

  const resendMut = useMutation({
    mutationFn: (recipientId: string) =>
      api.post(`/api/file-requests/${request.id}/resend`, { recipient_id: recipientId }),
    onSuccess: () => toast.success("Invite resent"),
    onError: (e) => toast.error(e instanceof ApiError ? e.message : "Failed"),
  });

  const editMut = useMutation({
    mutationFn: (body: Record<string, unknown>) => api.patch(`/api/file-requests/${request.id}`, body),
    onSuccess: () => { setEditing(false); invalidate(); toast.success("Request updated"); },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : "Failed"),
  });

  const uploads = uploadsQ.data?.uploads ?? [];
  const recipients = recipientsQ.data?.recipients ?? [];
  const pending = recipients.filter((r) => r.uploaded_at === null);

  const saveEdit = () => {
    const body: Record<string, unknown> = {};
    if (editTitle.trim() !== (request.title ?? "")) body.title = editTitle.trim();
    if (editMessage.trim() !== (request.message ?? "")) body.message = editMessage.trim();
    // PATCH writes exactly the keys it receives, so send only what changed.
    if (!Object.keys(body).length) { setEditing(false); return; }
    editMut.mutate(body);
  };

  return (
    <div className="fixed inset-0 z-40 flex justify-end bg-black/20" onClick={onClose}>
      <aside
        data-testid="request-detail"
        onClick={(e) => e.stopPropagation()}
        className="flex h-full w-[420px] flex-col overflow-y-auto border-l bg-[var(--color-bg)]"
        style={{ borderColor: "var(--color-border)" }}
      >
        <div className="flex items-center justify-between border-b px-4 py-3" style={{ borderColor: "var(--color-border)" }}>
          <p className="truncate text-sm font-semibold">{request.title || "Untitled request"}</p>
          <button data-testid="request-detail-close" onClick={onClose} className="text-[var(--color-text-muted)]">
            <X size={16} />
          </button>
        </div>

        <div className="border-b px-4 py-3" style={{ borderColor: "var(--color-border)" }}>
          <p data-testid="request-detail-url" className="break-all font-mono text-xs text-[var(--color-text-muted)]">
            {request.url}
          </p>
          <button
            data-testid="request-detail-copy"
            onClick={() => { navigator.clipboard.writeText(request.url); toast.success("Link copied"); }}
            className="mt-2 flex items-center gap-1 rounded-lg border px-2.5 py-1 text-xs"
            style={{ borderColor: "var(--color-border)" }}
          >
            <Copy size={11} /> Copy link
          </button>
        </div>

        {/* Uploads */}
        <div className="border-b px-4 py-3" style={{ borderColor: "var(--color-border)" }}>
          <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-[var(--color-text-muted)]">
            Uploads ({uploads.length})
          </p>
          {uploadsQ.isLoading ? (
            <Loader2 size={14} className="animate-spin text-[var(--color-text-muted)]" />
          ) : uploads.length === 0 ? (
            <p data-testid="request-uploads-empty" className="text-xs text-[var(--color-text-muted)]">
              Nothing uploaded yet.
            </p>
          ) : (
            <div className="space-y-2">
              {uploads.map((u) => (
                <div key={u.id} data-testid={`upload-${u.id}`} className="flex items-center gap-2 text-xs">
                  <FileUp size={12} className="shrink-0 text-[var(--color-text-muted)]" />
                  <span className="flex-1 truncate">{u.file_name}</span>
                  <span className="text-[var(--color-text-muted)]">{humanSize(u.size_bytes)}</span>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Recipients */}
        <div className="border-b px-4 py-3" style={{ borderColor: "var(--color-border)" }}>
          <div className="mb-2 flex items-center justify-between">
            <p className="text-xs font-semibold uppercase tracking-wide text-[var(--color-text-muted)]">
              Recipients ({recipients.length})
            </p>
            {pending.length > 0 && !closed && (
              <button
                data-testid="request-resend-all"
                onClick={() => pending.forEach((r) => resendMut.mutate(r.id))}
                className="text-xs font-medium text-[var(--color-primary)]"
              >
                Resend all ({pending.length})
              </button>
            )}
          </div>
          {recipients.length === 0 ? (
            <p data-testid="request-recipients-empty" className="text-xs text-[var(--color-text-muted)]">
              Nobody invited. The link works on its own.
            </p>
          ) : (
            <div className="space-y-2">
              {recipients.map((r) => (
                <div key={r.id} data-testid={`recipient-${r.id}`} className="flex items-center gap-2 text-xs">
                  <Mail size={12} className="shrink-0 text-[var(--color-text-muted)]" />
                  <span className="flex-1 truncate">{r.email}</span>
                  <span className="text-[var(--color-text-muted)]">
                    {r.uploaded_at ? "Uploaded" : r.sent_at ? "Invited" : "Not sent"}
                  </span>
                  {!r.uploaded_at && !closed && (
                    <button
                      data-testid={`recipient-${r.id}-resend`}
                      onClick={() => resendMut.mutate(r.id)}
                      title="Resend invite"
                      className="text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)]"
                    >
                      <Send size={12} />
                    </button>
                  )}
                  <button
                    data-testid={`recipient-${r.id}-remove`}
                    onClick={() => removeMut.mutate(r.id)}
                    title="Remove recipient"
                    className="text-[var(--color-text-muted)] hover:text-[var(--color-danger)]"
                  >
                    <Trash2 size={12} />
                  </button>
                </div>
              ))}
            </div>
          )}

          {/* A closed request answers 410, so the form is not offered at all. */}
          {!closed && (
            <div className="mt-3">
              <div className="flex items-center gap-2">
                <input
                  data-testid="recipient-add-input"
                  type="email"
                  value={newEmail}
                  onChange={(e) => { setNewEmail(e.target.value); if (addError) setAddError(null); }}
                  placeholder="Invite another address"
                  className="flex-1 rounded-lg border px-2.5 py-1.5 text-xs outline-none focus:border-[var(--color-primary)]"
                  style={{ borderColor: "var(--color-border)" }}
                />
                <button
                  data-testid="recipient-add"
                  onClick={() => {
                    const value = newEmail.trim().toLowerCase();
                    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) { setAddError("Enter a valid email address"); return; }
                    addMut.mutate(value);
                  }}
                  disabled={addMut.isPending}
                  className="rounded-lg p-1.5 text-white disabled:opacity-50"
                  style={{ background: "var(--color-primary)" }}
                >
                  <Plus size={12} />
                </button>
              </div>
              {addError && (
                <p data-testid="recipient-add-error" className="mt-1 text-xs text-[var(--color-danger)]">{addError}</p>
              )}
            </div>
          )}
        </div>

        {/* Edit */}
        <div className="px-4 py-3">
          {editing ? (
            <div className="space-y-2">
              <input
                data-testid="request-edit-title"
                value={editTitle}
                onChange={(e) => setEditTitle(e.target.value)}
                placeholder="Title"
                className="w-full rounded-lg border px-2.5 py-1.5 text-xs outline-none focus:border-[var(--color-primary)]"
                style={{ borderColor: "var(--color-border)" }}
              />
              <textarea
                data-testid="request-edit-message"
                value={editMessage}
                onChange={(e) => setEditMessage(e.target.value)}
                rows={2}
                placeholder="Message"
                className="w-full resize-none rounded-lg border px-2.5 py-1.5 text-xs outline-none focus:border-[var(--color-primary)]"
                style={{ borderColor: "var(--color-border)" }}
              />
              <div className="flex justify-end gap-2">
                <button data-testid="request-edit-cancel" onClick={() => setEditing(false)} className="text-xs text-[var(--color-text-muted)]">
                  Cancel
                </button>
                <button
                  data-testid="request-edit-save"
                  onClick={saveEdit}
                  disabled={editMut.isPending}
                  className="text-xs font-medium text-[var(--color-primary)] disabled:opacity-50"
                >
                  Save
                </button>
              </div>
            </div>
          ) : (
            <button
              data-testid="request-edit"
              onClick={() => setEditing(true)}
              className="flex items-center gap-1.5 text-xs text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)]"
            >
              <Pencil size={12} /> Edit title and message
            </button>
          )}
        </div>
      </aside>
    </div>
  );
}
