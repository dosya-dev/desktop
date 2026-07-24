// Ported from apps/web/src/components/hide-modal.tsx — keep in sync with the web copy.
import { useState, useEffect } from "react";
import { Eye, EyeOff, UserMinus, Shield, Loader2, Check } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/api-client";
import { Modal } from "@/components/files/Modal";

interface HideModalProps {
  open: boolean;
  target: { id: string; name: string; type: "file" | "folder" } | null;
  workspaceId: string;
  onClose: () => void;
  onDone: () => void;
}

type HiddenMode = "none" | "everyone" | "users" | "roles";

interface Member { user_id: string; name: string; email: string; role_id: string; is_you: boolean }
interface Role { id: string; name: string }

export function HideModal({ open, target, workspaceId, onClose, onDone }: HideModalProps) {
  const [mode, setMode] = useState<HiddenMode>("none");
  const [selectedTargets, setSelectedTargets] = useState<Set<string>>(new Set());
  const [members, setMembers] = useState<Member[]>([]);
  const [roles, setRoles] = useState<Role[]>([]);
  const [loading, setLoading] = useState(false);
  const [fetching, setFetching] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!open || !target) return;
    setError("");
    setFetching(true);

    const ep = target.type === "file" ? `/api/files/${target.id}/hide` : `/api/folders/${target.id}/hide`;

    Promise.all([
      api.get<{ ok: boolean; hidden_mode?: string; rules?: { target_id: string }[] }>(ep),
      api.get<{ ok: boolean; members?: Member[] }>(`/api/team?workspace_id=${workspaceId}`),
      api.get<{ ok: boolean; roles?: Role[] }>(`/api/roles?workspace_id=${workspaceId}`),
    ]).then(([hideData, teamData, rolesData]) => {
      if (hideData.ok) {
        setMode((hideData.hidden_mode ?? "none") as HiddenMode);
        setSelectedTargets(new Set((hideData.rules ?? []).map((r) => r.target_id)));
      }
      if (teamData.ok && teamData.members) setMembers(teamData.members);
      if (rolesData.ok && rolesData.roles) setRoles(rolesData.roles);
    }).catch(() => {}).finally(() => setFetching(false));
  }, [open, target, workspaceId]);

  const toggleTarget = (id: string) => {
    setSelectedTargets((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const handleSubmit = async () => {
    if (!target) return;
    setError("");
    setLoading(true);
    const ep = target.type === "file" ? `/api/files/${target.id}/hide` : `/api/folders/${target.id}/hide`;
    try {
      const body: Record<string, unknown> = { hidden_mode: mode };
      if (mode === "users" || mode === "roles") {
        if (selectedTargets.size === 0) {
          setError(`Select at least one ${mode === "users" ? "user" : "role"}.`);
          setLoading(false);
          return;
        }
        body.targets = Array.from(selectedTargets);
      }
      const res = await api.post<{ ok: boolean; error?: string }>(ep, body);
      if (res.ok) {
        toast.success(mode === "none" ? "Now visible" : "Hidden", {
          description: mode === "none" ? `${target.name} is now visible to everyone.` : `${target.name} is now hidden.`,
        });
        onDone();
        onClose();
      } else {
        setError(res.error ?? "Failed");
      }
    } catch {
      setError("Failed to update visibility");
    }
    setLoading(false);
  };

  // You can't hide your own files from yourself or your own role — still shown, but disabled.
  const myRoleId = members.find((m) => m.is_you)?.role_id;

  const MODES: { value: HiddenMode; label: string; desc: string; icon: React.ReactNode }[] = [
    { value: "none", label: "Visible", desc: "Everyone can see this", icon: <Eye size={16} className="text-[var(--color-text-muted)]" /> },
    { value: "everyone", label: "Hidden from everybody", desc: "Only you can see this", icon: <EyeOff size={16} className="text-red-500" /> },
    { value: "users", label: "Hidden from specific users", desc: "Select which users can't see this", icon: <UserMinus size={16} className="text-blue-500" /> },
    { value: "roles", label: "Hidden from specific roles", desc: "Select which roles can't see this", icon: <Shield size={16} className="text-violet-500" /> },
  ];

  if (!open || !target) return null;

  return (
    <Modal onClose={onClose} maxWidth={384}>
      <h3 className="mb-4 text-lg font-semibold">Hide {target.type}</h3>

      {fetching ? (
        <div className="flex justify-center py-6"><Loader2 size={20} className="animate-spin text-[var(--color-text-muted)]" /></div>
      ) : (
        <div className="space-y-2">
          {MODES.map((m) => (
            <label
              key={m.value}
              className={`flex cursor-pointer items-start gap-3 rounded-lg border px-3 py-2.5 transition-colors ${mode === m.value ? "border-[var(--color-primary)] bg-[var(--color-bg-secondary)]" : "hover:bg-[var(--color-bg-secondary)]"}`}
              style={mode === m.value ? undefined : { borderColor: "var(--color-border)" }}
            >
              <input
                type="radio"
                name="hide-mode"
                checked={mode === m.value}
                onChange={() => { setMode(m.value); setSelectedTargets(new Set()); }}
                className="mt-0.5 accent-[var(--color-primary)]"
              />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 text-sm font-medium">{m.icon} {m.label}</div>
                <p className="mt-0.5 text-xs text-[var(--color-text-muted)]">{m.desc}</p>
              </div>
            </label>
          ))}

          {/* User picker */}
          {mode === "users" && (
            <div className="max-h-40 overflow-y-auto rounded-lg border" style={{ borderColor: "var(--color-border)" }}>
              {members.length === 0 ? (
                <p className="py-3 text-center text-xs text-[var(--color-text-muted)]">No members found</p>
              ) : members.map((m) => (
                <button
                  key={m.user_id}
                  disabled={m.is_you}
                  className={`flex w-full items-center gap-2 border-b px-3 py-2 text-left text-xs last:border-b-0 ${m.is_you ? "cursor-not-allowed opacity-50" : "hover:bg-[var(--color-bg-secondary)]"} ${selectedTargets.has(m.user_id) ? "bg-blue-50" : ""}`}
                  style={{ borderColor: "var(--color-border)" }}
                  onClick={() => { if (!m.is_you) toggleTarget(m.user_id); }}
                >
                  {selectedTargets.has(m.user_id) && <Check size={12} className="shrink-0 text-blue-600" />}
                  <span className="flex-1 truncate">{m.name}{m.is_you && " (you)"}</span>
                  <span className="truncate text-[var(--color-text-muted)]">{m.email}</span>
                </button>
              ))}
            </div>
          )}

          {/* Role picker */}
          {mode === "roles" && (
            <div className="max-h-40 overflow-y-auto rounded-lg border" style={{ borderColor: "var(--color-border)" }}>
              {roles.length === 0 ? (
                <p className="py-3 text-center text-xs text-[var(--color-text-muted)]">No roles found</p>
              ) : roles.map((r) => {
                const isMine = r.id === myRoleId;
                return (
                  <button
                    key={r.id}
                    disabled={isMine}
                    className={`flex w-full items-center gap-2 border-b px-3 py-2 text-left text-xs last:border-b-0 ${isMine ? "cursor-not-allowed opacity-50" : "hover:bg-[var(--color-bg-secondary)]"} ${selectedTargets.has(r.id) ? "bg-violet-50" : ""}`}
                    style={{ borderColor: "var(--color-border)" }}
                    onClick={() => { if (!isMine) toggleTarget(r.id); }}
                  >
                    {selectedTargets.has(r.id) && <Check size={12} className="shrink-0 text-violet-600" />}
                    <span className="flex-1 truncate">{r.name}{isMine && " (your role)"}</span>
                  </button>
                );
              })}
            </div>
          )}

          {(mode === "users" || mode === "roles") && selectedTargets.size > 0 && (
            <p className="text-xs text-[var(--color-text-muted)]">{selectedTargets.size} selected</p>
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
          Apply
        </button>
      </div>
    </Modal>
  );
}
