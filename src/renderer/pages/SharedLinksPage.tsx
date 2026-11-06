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
import { api, ApiError } from "@/lib/api-client";
import { useWorkspace } from "@/lib/workspace-context";
import { formatDate, formatRelative } from "@/lib/format";
import { toast } from "sonner";
import { autoDir, useAutoDir } from "@/lib/bidi-ui";
import { useT } from "@/lib/i18n";
import { richText } from "@/lib/rich-text";
import type { MessageKey } from "../../i18n/keys";

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

/**
 * Chip and badge text per status, by the API's stable status value. Shown
 * with first-letter:uppercase rather than capitalize: the English sources are
 * single lowercase words, and capitalize would title-case every word of a
 * longer translation.
 */
const STATUS_LABEL: Record<StatusFilter, MessageKey> = {
  all: "common.label.all",
  active: "shared-links.label.active",
  expiring: "shared-links.label.expiring",
  expired: "shared-links.status.expired",
  revoked: "shared-links.label.revoked",
};

const STATUS_COLORS: Record<string, string> = {
  active: "#22c55e",
  expiring: "#f59e0b",
  expired: "#9ca3af",
  revoked: "#ef4444",
};

export function SharedLinksPage() {
  const ownDir = useAutoDir();
  const { active } = useWorkspace();
  const queryClient = useQueryClient();
  const t = useT();
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
    // POST is the revoke route's verb. DELETE answered "Not found" until the
    // API grew an alias for it (TC-050); POST works against every API.
    mutationFn: (id: string) => api.post(`/api/shares/${id}/revoke`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["shares"] });
      setRevokeTarget(null);
      toast.success(t("shared-links.label.shareLinkRevoked"));
    },
    onError: (err) => {
      toast.error(err instanceof ApiError ? autoDir(err.message) : t("shared-links.error.failedToRevokeShareLink"));
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
    toast.success(t("common.label.linkCopied"));
  };

  return (
    <div className="flex h-full gap-6" data-testid="shared-links-page">
      {/* Main Content */}
      <div className="flex-1 space-y-4">
        <h1 className="text-2xl font-semibold">{t("common.label.shared")}</h1>

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
            {t("shared-links.action.byMe")}
          </button>
          <button
            onClick={() => setTab("shared")}
            className={`pb-2.5 text-sm font-medium transition-colors ${
              tab === "shared"
                ? "border-b-2 border-[var(--color-primary)] text-[var(--color-primary)]"
                : "text-[var(--color-text-secondary)]"
            }`}
          >
            {t("shared-links.action.withMe")}
          </button>
        </div>

        {/* Filters */}
        <div className="flex items-center gap-2">
          {(["all", "active", "expiring", "expired", "revoked"] as const).map(
            (f) => (
              <button
                key={f}
                onClick={() => setStatusFilter(f)}
                className={`rounded-full px-3 py-1 text-xs font-medium first-letter:uppercase transition-colors ${
                  statusFilter === f
                    ? "bg-[var(--color-primary)]/10 text-[var(--color-primary)]"
                    : "text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-tertiary)]"
                }`}
              >
                {t(STATUS_LABEL[f])}
              </button>
            ),
          )}
          <div className="relative ms-auto">
            <Search
              size={14}
              className="absolute inset-s-2.5 top-1/2 -translate-y-1/2 text-[var(--color-text-muted)]"
            />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={t("shared-links.placeholder.filter")}
              className="rounded-lg border py-1.5 ps-8 pe-3 text-sm outline-none"
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
            {/* `table-fixed` is what keeps a long filename from breaking this
                layout. With auto layout the File column grows to fit its
                longest cell and shoves Region/Views/Expiry/Status off the
                edge; fixed layout honours the widths below and gives File
                whatever is left, so the name truncates instead. The fixed
                widths are deliberately tight: at a narrow window every spare
                pixel they hold is stolen from the filename. */}
            <table className="w-full table-fixed text-start text-sm">
              <thead>
                <tr className="border-b text-xs text-[var(--color-text-muted)]" style={{ borderColor: "var(--color-border)" }}>
                  <th className="py-2 text-start font-medium">{t("common.label.fileTitleCase")}</th>
                  <th className="py-2 text-start font-medium w-20">{t("files.label.region")}</th>
                  <th className="py-2 text-start font-medium w-14">{t("shared-links.column.views")}</th>
                  <th className="py-2 text-start font-medium w-24">{t("shared-links.column.expiry")}</th>
                  <th className="py-2 text-start font-medium w-20">{t("common.column.status")}</th>
                  <th className="py-2 text-start w-16"></th>
                </tr>
              </thead>
              <tbody>
                {links.map((link) => (
                  <tr
                    key={link.link_id}
                    className="border-b hover:bg-[var(--color-bg-secondary)] transition-colors"
                    style={{ borderColor: "var(--color-border)" }}
                  >
                    <td className="py-3 pe-3">
                      {/* min-w-0 is required for the truncate below: a flex
                          item defaults to min-width:auto and refuses to shrink
                          under its content, so the ellipsis never engages. */}
                      <div className="flex min-w-0 items-center gap-2">
                        <Link2 size={14} className="text-[var(--color-text-muted)] shrink-0" />
                        <span dir={ownDir} className="truncate font-medium" title={link.display_name}>
                          {link.display_name}
                        </span>
                        {link.is_password_protected === 1 && (
                          <Shield size={12} className="shrink-0 text-[var(--color-text-muted)]" />
                        )}
                      </div>
                    </td>
                    <td className="py-3 text-xs text-[var(--color-text-muted)]">
                      {link.region || "-"}
                    </td>
                    <td className="py-3 text-[var(--color-text-muted)]">
                      {link.view_count}
                    </td>
                    <td className="py-3 text-xs text-[var(--color-text-muted)]">
                      {link.expires_at
                        ? formatDate(link.expires_at)
                        : t("common.label.never")}
                    </td>
                    <td className="py-3">
                      <span
                        className="inline-block rounded-full px-2 py-0.5 text-xs font-medium first-letter:uppercase"
                        style={{
                          color: STATUS_COLORS[link.status],
                          background: STATUS_COLORS[link.status] + "15",
                        }}
                      >
                        {STATUS_LABEL[link.status] ? t(STATUS_LABEL[link.status]) : link.status}
                      </span>
                    </td>
                    <td className="py-3">
                      <div className="flex items-center gap-1">
                        <button
                          onClick={() => copyLink(link.url)}
                          className="rounded p-1.5 hover:bg-[var(--color-bg-tertiary)]"
                          title={t("common.action.copyLink")}
                        >
                          <Copy size={14} />
                        </button>
                        {link.is_mine && link.status !== "revoked" && (
                          <button
                            onClick={() => setRevokeTarget(link)}
                            className="rounded p-1.5 text-[var(--color-danger)] hover:bg-red-50"
                            title={t("common.action.revoke")}
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
                      {t("shared-links.empty.noShareLinksFound")}
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
          <h3 className="mb-3 text-sm font-semibold">{t("shared-links.heading.overview")}</h3>
          <div className="space-y-3">
            <StatRow label={t("shared-links.label.activeLinks")} value={stats?.active ?? 0} color="var(--color-primary)" />
            <StatRow label={t("shared-links.label.totalViews")} value={stats?.total_views ?? 0} color="#3b82f6" />
            <StatRow label={t("shared-links.label.expiringSoon")} value={stats?.expiring ?? 0} color="#f59e0b" />
            <StatRow label={t("shared-links.label.totalLinks")} value={stats?.total ?? 0} color="var(--color-text-secondary)" />
          </div>
        </div>
      </div>

      {/* Revoke Modal */}
      {revokeTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30">
          <div className="w-full max-w-sm rounded-xl bg-[var(--color-bg)] p-6 shadow-xl">
            <h3 className="mb-2 text-lg font-semibold">{t("shared-links.heading.revokeShareLink")}</h3>
            <p className="mb-4 text-sm text-[var(--color-text-secondary)]">
              {richText(t, "shared-links.description.areYouSureYouWantToRevokeTheShare", {}, {
                displayName: (
                  <span className="font-medium text-[var(--color-text)]">
                    {revokeTarget.display_name}
                  </span>
                ),
              })}
            </p>
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setRevokeTarget(null)}
                className="rounded-lg border px-4 py-2 text-sm"
                style={{ borderColor: "var(--color-border)" }}
              >
                {t("common.cancel")}
              </button>
              <button
                onClick={() => revokeMut.mutate(revokeTarget.link_id)}
                className="rounded-lg bg-[var(--color-danger)] px-4 py-2 text-sm font-medium text-white"
              >
                {t("common.action.revoke")}
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
