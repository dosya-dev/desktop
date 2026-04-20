import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Users,
  UserPlus,
  Mail,
  Link2,
  MoreHorizontal,
  Trash2,
  Clock,
  Shield,
  Crown,
  User,
  Eye,
} from "lucide-react";
import { api, ApiError } from "@/lib/api-client";
import { useWorkspace } from "@/lib/workspace-context";
import { formatDate, formatRelative } from "@/lib/format";
import { toast } from "sonner";
import { isValidEmail } from "@dosya-dev/shared";

interface TeamResponse {
  ok: boolean;
  workspace: { name: string; icon_initials: string; icon_color: string };
  members: {
    membership_id: string;
    user_id: string;
    role_id: string;
    joined_at: number;
    name: string;
    email: string;
    is_you: boolean;
  }[];
  invites: {
    id: string;
    email: string;
    role_id: string;
    created_at: number;
    expires_at: number;
    invited_by_name: string | null;
  }[];
  activity: {
    id: string;
    action: string;
    metadata: string | null;
    created_at: number;
    user_name: string | null;
  }[];
  stats: { members: number; pending: number; shares_this_week: number };
}

const ROLE_LABELS: Record<string, { label: string; color: string; icon: React.ReactNode }> = {
  role_owner: { label: "Owner", color: "#22c55e", icon: <Crown size={12} /> },
  role_admin: { label: "Admin", color: "#3b82f6", icon: <Shield size={12} /> },
  role_member: { label: "Member", color: "#6b7280", icon: <User size={12} /> },
  role_viewer: { label: "Viewer", color: "#a16207", icon: <Eye size={12} /> },
};

export function TeamPage() {
  const { active } = useWorkspace();
  const queryClient = useQueryClient();
  const [showInvite, setShowInvite] = useState(false);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState("role_member");
  const [removeTarget, setRemoveTarget] = useState<{ id: string; name: string } | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ["team", active?.id],
    queryFn: () =>
      api.get<TeamResponse>(`/api/team?workspace_id=${active?.id}`),
    enabled: !!active,
  });

  const inviteMut = useMutation({
    mutationFn: () =>
      api.post("/api/team/invite", {
        workspace_id: active!.id,
        email: inviteEmail,
        role_id: inviteRole,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["team"] });
      setShowInvite(false);
      setInviteEmail("");
      toast.success("Invitation sent");
    },
    onError: (err) => {
      toast.error(err instanceof ApiError ? err.message : "Failed to send invite");
    },
  });

  const removeMut = useMutation({
    mutationFn: (id: string) =>
      api.delete(`/api/team/members/${id}`, { workspace_id: active!.id }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["team"] });
      setRemoveTarget(null);
      toast.success("Member removed");
    },
  });

  const revokeInviteMut = useMutation({
    mutationFn: (id: string) =>
      api.delete(`/api/team/invites/${id}/revoke`, { workspace_id: active!.id }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["team"] });
      toast.success("Invite revoked");
    },
  });

  const members = data?.members ?? [];
  const invites = data?.invites ?? [];
  const activity = data?.activity ?? [];
  const stats = data?.stats;

  return (
    <div className="flex h-full gap-6">
      {/* Main Content */}
      <div className="flex-1 space-y-6">
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-semibold">Team</h1>
          <button
            onClick={() => setShowInvite(true)}
            className="flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-medium text-white"
            style={{ background: "var(--color-primary)" }}
          >
            <UserPlus size={16} />
            Invite
          </button>
        </div>

        {/* Stats */}
        <div className="grid grid-cols-3 gap-4">
          <MiniStat label="Members" value={stats?.members ?? 0} />
          <MiniStat label="Pending invites" value={stats?.pending ?? 0} />
          <MiniStat label="Shares this week" value={stats?.shares_this_week ?? 0} />
        </div>

        {/* Members Table */}
        <div>
          <h2 className="mb-3 text-sm font-semibold">Members</h2>
          {isLoading ? (
            <div className="space-y-2">
              {Array.from({ length: 4 }).map((_, i) => (
                <div key={i} className="h-14 animate-pulse rounded-lg bg-[var(--color-bg-tertiary)]" />
              ))}
            </div>
          ) : (
            <div className="overflow-auto rounded-xl border" style={{ borderColor: "var(--color-border)" }}>
              <table className="w-full text-left text-sm">
                <thead>
                  <tr className="border-b bg-[var(--color-bg-secondary)]" style={{ borderColor: "var(--color-border)" }}>
                    <th className="px-4 py-2.5 text-xs font-medium text-[var(--color-text-muted)]">Member</th>
                    <th className="px-4 py-2.5 text-xs font-medium text-[var(--color-text-muted)]">Role</th>
                    <th className="px-4 py-2.5 text-xs font-medium text-[var(--color-text-muted)]">Joined</th>
                    <th className="w-10 px-4 py-2.5"></th>
                  </tr>
                </thead>
                <tbody>
                  {members.map((m) => {
                    const role = ROLE_LABELS[m.role_id] ?? { label: m.role_id, color: "#6b7280", icon: null };
                    return (
                      <tr key={m.membership_id} className="border-b last:border-0" style={{ borderColor: "var(--color-border)" }}>
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-3">
                            <div
                              className="flex h-8 w-8 items-center justify-center rounded-full text-xs font-medium text-white"
                              style={{ background: "var(--color-primary)" }}
                            >
                              {m.name.charAt(0).toUpperCase()}
                            </div>
                            <div>
                              <p className="font-medium">
                                {m.name}
                                {m.is_you && (
                                  <span className="ml-1.5 text-xs text-[var(--color-text-muted)]">(you)</span>
                                )}
                              </p>
                              <p className="text-xs text-[var(--color-text-muted)]">{m.email}</p>
                            </div>
                          </div>
                        </td>
                        <td className="px-4 py-3">
                          <span
                            className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium"
                            style={{ color: role.color, background: role.color + "15" }}
                          >
                            {role.icon}
                            {role.label}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-xs text-[var(--color-text-muted)]">
                          {formatDate(m.joined_at)}
                        </td>
                        <td className="px-4 py-3">
                          {!m.is_you && m.role_id !== "role_owner" && (
                            <button
                              onClick={() =>
                                setRemoveTarget({ id: m.membership_id, name: m.name })
                              }
                              className="rounded p-1 text-[var(--color-text-muted)] hover:bg-[var(--color-bg-tertiary)] hover:text-[var(--color-danger)]"
                            >
                              <Trash2 size={14} />
                            </button>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* Pending Invites */}
        {invites.length > 0 && (
          <div>
            <h2 className="mb-3 text-sm font-semibold">
              Pending invites
              <span className="ml-2 rounded-full bg-[var(--color-bg-tertiary)] px-2 py-0.5 text-xs">
                {invites.length}
              </span>
            </h2>
            <div className="space-y-2">
              {invites.map((inv) => (
                <div
                  key={inv.id}
                  className="flex items-center justify-between rounded-lg border px-4 py-3"
                  style={{ borderColor: "var(--color-border)" }}
                >
                  <div className="flex items-center gap-3">
                    <Mail size={16} className="text-[var(--color-text-muted)]" />
                    <div>
                      <p className="text-sm font-medium">{inv.email}</p>
                      <p className="text-xs text-[var(--color-text-muted)]">
                        Invited {formatRelative(inv.created_at)}
                        {inv.invited_by_name && ` by ${inv.invited_by_name}`}
                      </p>
                    </div>
                  </div>
                  <button
                    onClick={() => revokeInviteMut.mutate(inv.id)}
                    className="rounded px-2 py-1 text-xs text-[var(--color-danger)] hover:bg-red-50"
                  >
                    Revoke
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Right Sidebar */}
      <div className="w-64 space-y-4">
        {/* Recent Activity */}
        <div className="rounded-xl border p-4" style={{ borderColor: "var(--color-border)" }}>
          <h3 className="mb-3 text-sm font-semibold">Recent activity</h3>
          {activity.length > 0 ? (
            <div className="space-y-2">
              {activity.slice(0, 6).map((a) => (
                <div key={a.id} className="flex items-start gap-2">
                  <div className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--color-primary)]" />
                  <div>
                    <p className="text-xs">
                      <span className="font-medium">{a.user_name}</span>{" "}
                      <span className="text-[var(--color-text-secondary)]">{a.action}</span>
                    </p>
                    <p className="text-xs text-[var(--color-text-muted)]">
                      {formatRelative(a.created_at)}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-xs text-[var(--color-text-muted)]">No recent activity</p>
          )}
        </div>

        {/* Role Guide */}
        <div className="rounded-xl border p-4" style={{ borderColor: "var(--color-border)" }}>
          <h3 className="mb-3 text-sm font-semibold">Role guide</h3>
          <div className="space-y-2.5">
            {Object.entries(ROLE_LABELS).map(([id, role]) => (
              <div key={id} className="flex items-center gap-2">
                <div className="h-2.5 w-2.5 rounded-full" style={{ background: role.color }} />
                <span className="text-xs font-medium" style={{ color: role.color }}>
                  {role.label}
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Invite Modal */}
      {showInvite && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30">
          <div className="w-full max-w-sm rounded-xl bg-[var(--color-bg)] p-6 shadow-xl">
            <h3 className="mb-4 text-lg font-semibold">Invite to workspace</h3>
            <div className="space-y-3">
              <div>
                <label className="mb-1 block text-sm font-medium">Email</label>
                <input
                  type="email"
                  value={inviteEmail}
                  onChange={(e) => setInviteEmail(e.target.value)}
                  placeholder="colleague@example.com"
                  autoFocus
                  className="w-full rounded-lg border px-3 py-2 text-sm outline-none focus:border-[var(--color-primary)]"
                  style={{ borderColor: "var(--color-border)" }}
                />
              </div>
              <div>
                <label className="mb-1 block text-sm font-medium">Role</label>
                <select
                  value={inviteRole}
                  onChange={(e) => setInviteRole(e.target.value)}
                  className="w-full rounded-lg border px-3 py-2 text-sm outline-none"
                  style={{ borderColor: "var(--color-border)" }}
                >
                  <option value="role_admin">Admin</option>
                  <option value="role_member">Member</option>
                  <option value="role_viewer">Viewer</option>
                </select>
              </div>
            </div>
            <div className="mt-5 flex justify-end gap-2">
              <button
                onClick={() => { setShowInvite(false); setInviteEmail(""); }}
                className="rounded-lg border px-4 py-2 text-sm"
                style={{ borderColor: "var(--color-border)" }}
              >
                Cancel
              </button>
              <button
                onClick={() => inviteMut.mutate()}
                disabled={!isValidEmail(inviteEmail) || inviteMut.isPending}
                className="rounded-lg px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
                style={{ background: "var(--color-primary)" }}
              >
                {inviteMut.isPending ? "Sending..." : "Send invite"}
              </button>
            </div>
          </div>
          <div className="fixed inset-0 -z-10" onClick={() => setShowInvite(false)} />
        </div>
      )}

      {/* Remove Member Modal */}
      {removeTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30">
          <div className="w-full max-w-sm rounded-xl bg-[var(--color-bg)] p-6 shadow-xl">
            <h3 className="mb-2 text-lg font-semibold">Remove member</h3>
            <p className="mb-4 text-sm text-[var(--color-text-secondary)]">
              Remove <span className="font-medium text-[var(--color-text)]">{removeTarget.name}</span> from this workspace?
            </p>
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setRemoveTarget(null)}
                className="rounded-lg border px-4 py-2 text-sm"
                style={{ borderColor: "var(--color-border)" }}
              >
                Cancel
              </button>
              <button
                onClick={() => removeMut.mutate(removeTarget.id)}
                className="rounded-lg bg-[var(--color-danger)] px-4 py-2 text-sm font-medium text-white"
              >
                Remove
              </button>
            </div>
          </div>
          <div className="fixed inset-0 -z-10" onClick={() => setRemoveTarget(null)} />
        </div>
      )}
    </div>
  );
}

function MiniStat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-xl border p-4" style={{ borderColor: "var(--color-border)" }}>
      <p className="text-2xl font-semibold">{value}</p>
      <p className="text-xs text-[var(--color-text-secondary)]">{label}</p>
    </div>
  );
}
