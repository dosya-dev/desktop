// Ported from apps/web/src/components/lock-modal.tsx - keep in sync with the web copy.
import { useState, useEffect } from "react";
import { Lock, Unlock, Eye, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/api-client";
import { Modal } from "@/components/files/Modal";

interface LockModalProps {
  open: boolean;
  target: { id: string; name: string; type: "file" | "folder" } | null;
  onClose: () => void;
  onDone: () => void;
}

type LockMode = "none" | "view_only" | "full_lock";

const MODES: { value: LockMode; label: string; desc: string; icon: React.ReactNode }[] = [
  { value: "none", label: "Unlocked", desc: "Full access for all members", icon: <Unlock size={16} className="text-green-600" /> },
  { value: "view_only", label: "View only", desc: "Can preview, no download or edit", icon: <Eye size={16} className="text-blue-600" /> },
  { value: "full_lock", label: "Full lock", desc: "Password required to access", icon: <Lock size={16} className="text-violet-600" /> },
];

export function LockModal({ open, target, onClose, onDone }: LockModalProps) {
  const [mode, setMode] = useState<LockMode>("none");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [fetching, setFetching] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!open || !target) return;
    setPassword("");
    setError("");
    setFetching(true);
    const ep = target.type === "file" ? `/api/files/${target.id}/lock` : `/api/folders/${target.id}/lock`;
    api.get<{ ok: boolean; lock_mode: string }>(ep)
      .then((data) => { if (data.ok) setMode((data.lock_mode ?? "none") as LockMode); })
      .catch(() => {})
      .finally(() => setFetching(false));
  }, [open, target]);

  const handleSubmit = async () => {
    if (!target) return;
    if (mode === "full_lock" && password.length < 4) {
      setError("Password must be at least 4 characters.");
      return;
    }
    setError("");
    setLoading(true);
    const ep = target.type === "file" ? `/api/files/${target.id}/lock` : `/api/folders/${target.id}/lock`;
    try {
      const body: Record<string, unknown> = { lock_mode: mode };
      if (mode === "full_lock") body.password = password;
      const res = await api.post<{ ok: boolean; error?: string }>(ep, body);
      if (res.ok) {
        toast.success(mode === "none" ? "Unlocked" : "Locked", {
          description: mode === "none" ? `${target.name} is now unlocked.` : `Lock mode set to ${mode.replace("_", " ")}.`,
        });
        onDone();
        onClose();
      } else {
        setError(res.error ?? "Failed");
      }
    } catch {
      setError("Failed to update lock");
    }
    setLoading(false);
  };

  if (!open || !target) return null;

  return (
    <Modal onClose={onClose} maxWidth={384}>
      <h3 className="mb-4 text-lg font-semibold">Lock {target.type}</h3>

      {fetching ? (
        <div className="flex justify-center py-6"><Loader2 size={20} className="animate-spin text-[var(--color-text-muted)]" /></div>
      ) : (
        <div className="space-y-2">
          {MODES.map((m) => (
            <label
              key={m.value}
              className={`flex cursor-pointer items-start gap-3 rounded-lg border px-3 py-3 transition-colors ${mode === m.value ? "border-[var(--color-primary)] bg-[var(--color-bg-secondary)]" : "hover:bg-[var(--color-bg-secondary)]"}`}
              style={mode === m.value ? undefined : { borderColor: "var(--color-border)" }}
            >
              <input
                type="radio"
                name="lock-mode"
                checked={mode === m.value}
                onChange={() => setMode(m.value)}
                className="mt-0.5 accent-[var(--color-primary)]"
              />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 text-sm font-medium">
                  {m.icon} {m.label}
                </div>
                <p className="mt-0.5 text-xs text-[var(--color-text-muted)]">{m.desc}</p>
              </div>
            </label>
          ))}

          {mode === "full_lock" && (
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Enter lock password (min 4 chars)"
              className="w-full rounded-lg border px-3 py-2 text-xs outline-none focus:border-[var(--color-primary)]"
              style={{ borderColor: "var(--color-border)" }}
              autoFocus
            />
          )}

          {error && (
            <p className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-[var(--color-danger)]">{error}</p>
          )}
        </div>
      )}

      <div className="mt-5 flex justify-end gap-2">
        <button onClick={onClose} className="rounded-lg border px-4 py-2 text-sm" style={{ borderColor: "var(--color-border)" }}>
          Cancel
        </button>
        <button
          onClick={handleSubmit}
          disabled={loading || fetching}
          className="flex items-center gap-1.5 rounded-lg px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
          style={{ background: "var(--color-primary)" }}
        >
          {loading && <Loader2 size={14} className="animate-spin" />}
          {mode === "none" ? "Remove lock" : "Apply lock"}
        </button>
      </div>
    </Modal>
  );
}
