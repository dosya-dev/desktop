import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Link2,
  Copy,
  Trash2,
  Eye,
  Download,
  Shield,
  Clock,
  ExternalLink,
  Search,
} from "lucide-react";
import { api } from "@/lib/api-client";
import { useWorkspace } from "@/lib/workspace-context";
import { formatDate, formatRelative } from "@/lib/format";
import { toast } from "sonner";

interface ShareLink {
  link_id: string;
  token: string;
  expires_at: number | null;
  view_count: number;
  download_count: number;
  is_revoked: number;
  shared_at: number;
  is_password_protected: number;
  file_id: string | null;
  file_name: string | null;
  size_bytes: number | null;
  extension: string | null;
  region: string | null;
  folder_name: string | null;
  sharer_name: string | null;
  status: "active" | "expiring" | "expired" | "revoked";
  display_name: string;
  url: string;
  is_mine: boolean;
}

interface SharesResponse {
  ok: boolean;
  links: ShareLink[];
  stats: {
    total: number;
    active: number;
    expiring: number;
    total_views: number;
  };
}

type StatusFilter = "all" | "active" | "expiring" | "expired" | "revoked";

const STATUS_COLORS: Record<string, string> = {
  active: "#22c55e",
  expiring: "#f59e0b",
  expired: "#9ca3af",
  revoked: "#ef4444",
};

export function SharedLinksPage() {
  const { active } = useWorkspace();
  const queryClient = useQueryClient();
  const [tab, setTab] = useState<"mine" | "shared">("mine");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [search, setSearch] = useState("");
  const [revokeTarget, setRevokeTarget] = useState<ShareLink | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ["shares", active?.id],
    queryFn: () =>
      api.get<SharesResponse>(`/api/shares?workspace_id=${active?.id}`),
    enabled: !!active,
  });

  const revokeMut = useMutation({
    mutationFn: (id: string) => api.delete(`/api/shares/${id}/revoke`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["shares"] });
      setRevokeTarget(null);
      toast.success("Share link revoked");
    },
  });

  const links = (data?.links ?? []).filter((l) => {
    if (tab === "mine" && !l.is_mine) return false;
    if (tab === "shared" && l.is_mine) return false;
    if (statusFilter !== "all" && l.status !== statusFilter) return false;
    if (search && !l.display_name.toLowerCase().includes(search.toLowerCase()))
      return false;
    return true;
  });

  const stats = data?.stats;

  const copyLink = (url: string) => {
    navigator.clipboard.writeText(url);
    toast.success("Link copied");
  };

  return (
    <div className="flex h-full gap-6">
      {/* Main Content */}
      <div className="flex-1 space-y-4">
        <h1 className="text-2xl font-semibold">Shared</h1>

        {/* Tabs */}
        <div className="flex items-center gap-6 border-b" style={{ borderColor: "var(--color-border)" }}>
          <button
            onClick={() => setTab("mine")}
            className={`pb-2.5 text-sm font-medium transition-colors ${
              tab === "mine"
                ? "border-b-2 border-[var(--color-primary)] text-[var(--color-primary)]"
                : "text-[var(--color-text-secondary)]"
            }`}
          >
            By me
          </button>
          <button
            onClick={() => setTab("shared")}
            className={`pb-2.5 text-sm font-medium transition-colors ${
              tab === "shared"
                ? "border-b-2 border-[var(--color-primary)] text-[var(--color-primary)]"
                : "text-[var(--color-text-secondary)]"
            }`}
          >
            With me
          </button>
        </div>

        {/* Filters */}
        <div className="flex items-center gap-2">
          {(["all", "active", "expiring", "expired", "revoked"] as const).map(
            (f) => (
              <button
                key={f}
                onClick={() => setStatusFilter(f)}
                className={`rounded-full px-3 py-1 text-xs font-medium capitalize transition-colors ${
                  statusFilter === f
                    ? "bg-[var(--color-primary)]/10 text-[var(--color-primary)]"
                    : "text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-tertiary)]"
                }`}
              >
                {f}
              </button>
            ),
          )}
          <div className="relative ml-auto">
            <Search
              size={14}
              className="absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--color-text-muted)]"
            />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Filter..."
              className="rounded-lg border py-1.5 pl-8 pr-3 text-sm outline-none"
              style={{ borderColor: "var(--color-border)", width: 180 }}
            />
          </div>
        </div>

        {/* Table */}
        {isLoading ? (
          <div className="space-y-2">
            {Array.from({ length: 5 }).map((_, i) => (
              <div key={i} className="h-12 animate-pulse rounded-lg bg-[var(--color-bg-tertiary)]" />
            ))}
          </div>
        ) : (
          <div className="overflow-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b text-xs text-[var(--color-text-muted)]" style={{ borderColor: "var(--color-border)" }}>
                  <th className="py-2 font-medium">File</th>
                  <th className="py-2 font-medium w-20">Region</th>
                  <th className="py-2 font-medium w-16">Views</th>
                  <th className="py-2 font-medium w-28">Expiry</th>
                  <th className="py-2 font-medium w-24">Status</th>
                  <th className="py-2 w-28"></th>
                </tr>
              </thead>
              <tbody>
                {links.map((link) => (
                  <tr
                    key={link.link_id}
                    className="border-b hover:bg-[var(--color-bg-secondary)] transition-colors"
                    style={{ borderColor: "var(--color-border)" }}
                  >
                    <td className="py-3">
                      <div className="flex items-center gap-2">
                        <Link2 size={14} className="text-[var(--color-text-muted)] shrink-0" />
                        <span className="truncate font-medium">{link.display_name}</span>
                        {link.is_password_protected === 1 && (
                          <Shield size={12} className="text-[var(--color-text-muted)]" />
                        )}
                      </div>
                    </td>
                    <td className="py-3 text-xs text-[var(--color-text-muted)]">
                      {link.region || "—"}
                    </td>
                    <td className="py-3 text-[var(--color-text-muted)]">
                      {link.view_count}
                    </td>
                    <td className="py-3 text-xs text-[var(--color-text-muted)]">
                      {link.expires_at
                        ? formatDate(link.expires_at)
                        : "Never"}
                    </td>
                    <td className="py-3">
                      <span
                        className="inline-block rounded-full px-2 py-0.5 text-xs font-medium capitalize"
                        style={{
                          color: STATUS_COLORS[link.status],
                          background: STATUS_COLORS[link.status] + "15",
                        }}
                      >
                        {link.status}
                      </span>
                    </td>
                    <td className="py-3">
                      <div className="flex items-center gap-1">
                        <button
                          onClick={() => copyLink(link.url)}
                          className="rounded p-1.5 hover:bg-[var(--color-bg-tertiary)]"
                          title="Copy link"
                        >
                          <Copy size={14} />
                        </button>
                        {link.is_mine && link.status !== "revoked" && (
                          <button
                            onClick={() => setRevokeTarget(link)}
                            className="rounded p-1.5 text-[var(--color-danger)] hover:bg-red-50"
                            title="Revoke"
                          >
                            <Trash2 size={14} />
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
                {links.length === 0 && (
                  <tr>
                    <td colSpan={6} className="py-16 text-center text-sm text-[var(--color-text-muted)]">
                      No share links found
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Right Sidebar: Stats */}
      <div className="w-64 space-y-4">
        <div className="rounded-xl border p-4" style={{ borderColor: "var(--color-border)" }}>
          <h3 className="mb-3 text-sm font-semibold">Overview</h3>
          <div className="space-y-3">
            <StatRow label="Active links" value={stats?.active ?? 0} color="var(--color-primary)" />
            <StatRow label="Total views" value={stats?.total_views ?? 0} color="#3b82f6" />
            <StatRow label="Expiring soon" value={stats?.expiring ?? 0} color="#f59e0b" />
            <StatRow label="Total links" value={stats?.total ?? 0} color="var(--color-text-secondary)" />
          </div>
        </div>
      </div>

      {/* Revoke Modal */}
      {revokeTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30">
          <div className="w-full max-w-sm rounded-xl bg-[var(--color-bg)] p-6 shadow-xl">
            <h3 className="mb-2 text-lg font-semibold">Revoke share link</h3>
            <p className="mb-4 text-sm text-[var(--color-text-secondary)]">
              Are you sure you want to revoke the share link for{" "}
              <span className="font-medium text-[var(--color-text)]">
                {revokeTarget.display_name}
              </span>
              ? This cannot be undone.
            </p>
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setRevokeTarget(null)}
                className="rounded-lg border px-4 py-2 text-sm"
                style={{ borderColor: "var(--color-border)" }}
              >
                Cancel
              </button>
              <button
                onClick={() => revokeMut.mutate(revokeTarget.link_id)}
                className="rounded-lg bg-[var(--color-danger)] px-4 py-2 text-sm font-medium text-white"
              >
                Revoke
              </button>
            </div>
          </div>
          <div className="fixed inset-0 -z-10" onClick={() => setRevokeTarget(null)} />
        </div>
      )}
    </div>
  );
}

function StatRow({
  label,
  value,
  color,
}: {
  label: string;
  value: number;
  color: string;
}) {
  return (
    <div className="flex items-center justify-between">
      <div className="flex items-center gap-2">
        <div className="h-2.5 w-2.5 rounded-full" style={{ background: color }} />
        <span className="text-sm text-[var(--color-text-secondary)]">{label}</span>
      </div>
      <span className="text-sm font-semibold">{value}</span>
    </div>
  );
}
