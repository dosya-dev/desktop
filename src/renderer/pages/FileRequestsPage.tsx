import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  FileUp,
  Plus,
  Copy,
  Trash2,
  Clock,
  Link2,
  Mail,
  X,
} from "lucide-react";
import { api, ApiError } from "@/lib/api-client";
import { useWorkspace } from "@/lib/workspace-context";
import { formatDate, formatRelative } from "@/lib/format";
import { toast } from "sonner";

interface FileRequest {
  id: string;
  token: string;
  title: string;
  message: string | null;
  recipient_email: string | null;
  expires_at: number | null;
  max_files: number | null;
  upload_count: number;
  is_revoked: number;
  created_at: number;
  url: string;
}

export function FileRequestsPage() {
  const { active } = useWorkspace();
  const queryClient = useQueryClient();
  const [showCreate, setShowCreate] = useState(false);
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
        recipient_email: email.trim() || null,
        message: message.trim() || null,
        max_files: maxFiles ? Number(maxFiles) : null,
        expires_in_days: expiryDays ? Number(expiryDays) : null,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["file-requests"] });
      setShowCreate(false);
      setTitle(""); setEmail(""); setMessage(""); setMaxFiles(""); setExpiryDays("7");
      toast.success("File request created");
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : "Failed"),
  });

  const deleteMut = useMutation({
    mutationFn: (id: string) => api.delete(`/api/file-requests/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["file-requests"] });
      toast.success("Request deleted");
    },
  });

  const requests = data?.requests ?? [];

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">File Requests</h1>
          <p className="text-sm text-[var(--color-text-muted)]">
            Request files from anyone — they don't need an account
          </p>
        </div>
        <button
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
        <div className="flex flex-col items-center justify-center rounded-xl border py-16" style={{ borderColor: "var(--color-border)" }}>
          <FileUp size={36} className="mb-3 text-[var(--color-text-muted)]" />
          <p className="text-sm font-medium">No file requests yet</p>
          <p className="mt-1 text-xs text-[var(--color-text-muted)]">Create a request to receive files from anyone</p>
        </div>
      ) : (
        <div className="space-y-3">
          {requests.map((req) => (
            <div key={req.id} className="rounded-xl border p-4" style={{ borderColor: "var(--color-border)" }}>
              <div className="flex items-start justify-between">
                <div>
                  <p className="text-sm font-semibold">{req.title}</p>
                  {req.recipient_email && (
                    <p className="mt-0.5 flex items-center gap-1 text-xs text-[var(--color-text-muted)]">
                      <Mail size={11} /> {req.recipient_email}
                    </p>
                  )}
                </div>
                <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                  req.is_revoked ? "bg-red-50 text-red-600" :
                  req.expires_at && req.expires_at < Date.now() / 1000 ? "bg-gray-100 text-gray-500" :
                  "bg-[var(--color-primary)]/10 text-[var(--color-primary)]"
                }`}>
                  {req.is_revoked ? "Closed" :
                   req.expires_at && req.expires_at < Date.now() / 1000 ? "Expired" : "Active"}
                </span>
              </div>
              <div className="mt-3 flex items-center gap-4 text-xs text-[var(--color-text-muted)]">
                <span className="flex items-center gap-1"><FileUp size={11} /> {req.upload_count} uploads</span>
                {req.expires_at && <span className="flex items-center gap-1"><Clock size={11} /> Expires {formatDate(req.expires_at)}</span>}
                <span>{formatRelative(req.created_at)}</span>
              </div>
              <div className="mt-3 flex items-center gap-2 border-t pt-3" style={{ borderColor: "var(--color-border)" }}>
                <button
                  onClick={() => { navigator.clipboard.writeText(req.url); toast.success("Link copied"); }}
                  className="flex items-center gap-1 rounded-lg border px-2.5 py-1 text-xs hover:bg-[var(--color-bg-secondary)]"
                  style={{ borderColor: "var(--color-border)" }}
                >
                  <Copy size={11} /> Copy link
                </button>
                <button
                  onClick={() => deleteMut.mutate(req.id)}
                  className="flex items-center gap-1 rounded-lg border px-2.5 py-1 text-xs text-[var(--color-danger)] hover:bg-red-50"
                  style={{ borderColor: "var(--color-border)" }}
                >
                  <Trash2 size={11} /> Delete
                </button>
              </div>
            </div>
          ))}
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
                <input type="text" value={title} onChange={(e) => setTitle(e.target.value)} autoFocus placeholder="e.g. Brand assets for Q2 campaign" className="w-full rounded-lg border px-3 py-2 text-sm outline-none focus:border-[var(--color-primary)]" style={{ borderColor: "var(--color-border)" }} />
              </div>
              <div>
                <label className="mb-1 block text-sm font-medium">Recipient email (optional)</label>
                <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="recipient@example.com" className="w-full rounded-lg border px-3 py-2 text-sm outline-none focus:border-[var(--color-primary)]" style={{ borderColor: "var(--color-border)" }} />
              </div>
              <div>
                <label className="mb-1 block text-sm font-medium">Message (optional)</label>
                <textarea value={message} onChange={(e) => setMessage(e.target.value)} rows={2} placeholder="Any instructions for the uploader..." className="w-full resize-none rounded-lg border px-3 py-2 text-sm outline-none focus:border-[var(--color-primary)]" style={{ borderColor: "var(--color-border)" }} />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="mb-1 block text-sm font-medium">Expires in (days)</label>
                  <input type="number" value={expiryDays} onChange={(e) => setExpiryDays(e.target.value)} min={1} max={90} className="w-full rounded-lg border px-3 py-2 text-sm outline-none focus:border-[var(--color-primary)]" style={{ borderColor: "var(--color-border)" }} />
                </div>
                <div>
                  <label className="mb-1 block text-sm font-medium">Max files</label>
                  <input type="number" value={maxFiles} onChange={(e) => setMaxFiles(e.target.value)} min={1} placeholder="Unlimited" className="w-full rounded-lg border px-3 py-2 text-sm outline-none focus:border-[var(--color-primary)]" style={{ borderColor: "var(--color-border)" }} />
                </div>
              </div>
            </div>
            <div className="mt-5 flex justify-end gap-2">
              <button onClick={() => setShowCreate(false)} className="rounded-lg border px-4 py-2 text-sm" style={{ borderColor: "var(--color-border)" }}>Cancel</button>
              <button onClick={() => createMut.mutate()} disabled={!title.trim() || createMut.isPending} className="rounded-lg px-4 py-2 text-sm font-medium text-white disabled:opacity-50" style={{ background: "var(--color-primary)" }}>
                {createMut.isPending ? "Creating..." : "Create request"}
              </button>
            </div>
          </div>
          <div className="fixed inset-0 -z-10" onClick={() => setShowCreate(false)} />
        </div>
      )}
    </div>
  );
}
