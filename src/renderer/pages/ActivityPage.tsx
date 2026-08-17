import { useState, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api-client";
import { useAuth } from "@/lib/auth-context";
import { useWorkspace } from "@/lib/workspace-context";
import { useAvatarVersion, avatarUrl } from "@/lib/avatar-version";
import { formatRelative } from "@/lib/format";
import { actionLabel, actionColor } from "@/lib/activity-labels";
import { ErrorPanel } from "@/components/ErrorPanel";
import { ChevronLeft, ChevronRight } from "lucide-react";

interface Activity {
  id: string;
  action: string;
  entity_type: string;
  entity_id: string;
  created_at: number;
  user_name: string | null;
  user_id: string | null;
  user_email: string | null;
  user_avatar: string | null;
  meta: {
    name?: string;
    email?: string;
    old_name?: string;
    new_name?: string;
    file_count?: number;
    via?: string;
  } | null;
}

interface ActivityResponse {
  ok: boolean;
  activities: Activity[];
  pagination: {
    page: number;
    per_page: number;
    total: number;
    total_pages: number;
  };
}

function getInitials(name: string | null): string {
  if (!name) return "?";
  const parts = name.trim().split(/\s+/);
  return ((parts[0]?.[0] ?? "") + (parts[1]?.[0] ?? "")).toUpperCase() || "?";
}

export function ActivityPage() {
  const { active } = useWorkspace();
  const { user } = useAuth();
  const avatarVersion = useAvatarVersion((s) => s.version);
  const [page, setPage] = useState(1);
  const [apiBase, setApiBase] = useState("");
  const perPage = 50;

  useEffect(() => {
    window.electronAPI.getApiBase().then(setApiBase);
  }, []);

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ["activity", active?.id, page],
    queryFn: () =>
      api.get<ActivityResponse>(
        `/api/activity?workspace_id=${active?.id}&page=${page}&per_page=${perPage}`,
      ),
    enabled: !!active,
  });

  const activities = data?.activities ?? [];
  const pagination = data?.pagination;

  return (
    <div className="space-y-5">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-semibold">Activity log</h1>
        <p className="text-sm text-[var(--color-text-muted)]">
          {isLoading
            ? "Loading..."
            : isError
              ? "Couldn't load activity. Check your connection and try again."
              : pagination
                ? `${pagination.total} activities in this workspace`
                : activities.length > 0
                  ? `${activities.length} activities`
                  : "No activity yet"}
        </p>
      </div>

      {/* Activity List */}
      <div
        className="overflow-hidden rounded-xl border bg-[var(--color-bg)]"
        style={{ borderColor: "var(--color-border)" }}
      >
        {isLoading ? (
          <div className="space-y-0">
            {Array.from({ length: 8 }).map((_, i) => (
              <div
                key={i}
                className="flex items-start gap-3 border-b px-5 py-3.5"
                style={{ borderColor: "var(--color-bg-tertiary)" }}
              >
                <div className="h-9 w-9 shrink-0 animate-pulse rounded-full bg-[var(--color-bg-tertiary)]" />
                <div className="flex-1 space-y-2">
                  <div className="h-4 w-3/4 animate-pulse rounded bg-[var(--color-bg-tertiary)]" />
                  <div className="h-3 w-1/4 animate-pulse rounded bg-[var(--color-bg-tertiary)]" />
                </div>
              </div>
            ))}
          </div>
        ) : isError ? (
          <ErrorPanel message="Couldn't load activity." onRetry={() => refetch()} />
        ) : activities.length === 0 ? (
          <div className="py-16 text-center text-sm text-[var(--color-text-muted)]">
            No activity yet.
          </div>
        ) : (
          activities.map((a, i) => {
            const label = actionLabel(a.action);
            const color = actionColor(a.action);
            const initials = getInitials(a.user_name);
            const userName = a.user_name ?? "Someone";

            // Build meta tags
            const tags: string[] = [];
            if (a.meta?.name) tags.push(a.meta.name);
            if (a.meta?.email) tags.push(a.meta.email);
            if (a.meta?.old_name && a.meta?.new_name)
              tags.push(`${a.meta.old_name} → ${a.meta.new_name}`);
            if (a.meta?.file_count) tags.push(`${a.meta.file_count} files`);
            if (a.meta?.via) tags.push(`via ${a.meta.via}`);

            return (
              <div
                key={a.id}
                className="flex items-start gap-3 border-b px-5 py-3.5 transition-colors hover:bg-[var(--color-bg-secondary)]"
                style={{
                  borderColor:
                    i === activities.length - 1
                      ? "transparent"
                      : "var(--color-bg-tertiary)",
                }}
              >
                {/* Avatar - use /api/me/avatar for current user, initials for others */}
                {a.user_avatar && user && a.user_id === user.id && apiBase ? (
                  <img
                    key={user.id}
                    src={avatarUrl(apiBase, user.id, avatarVersion)}
                    alt=""
                    className="h-9 w-9 shrink-0 rounded-full object-cover"
                  />
                ) : (
                  <div
                    className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-xs font-bold text-white"
                    style={{ background: color }}
                  >
                    {initials}
                  </div>
                )}

                {/* Body */}
                <div className="min-w-0 flex-1">
                  <p className="text-sm leading-relaxed text-[var(--color-text-secondary)]">
                    <span className="font-semibold text-[var(--color-text)]">
                      {userName}
                    </span>{" "}
                    {label}
                  </p>
                  <p className="mt-0.5 text-xs text-[var(--color-text-muted)]">
                    {formatRelative(a.created_at)}
                  </p>
                  {tags.length > 0 && (
                    <div className="mt-1.5 flex flex-wrap gap-1.5">
                      {tags.map((tag, ti) => (
                        <span
                          key={ti}
                          className="rounded-full bg-[var(--color-bg-tertiary)] px-2 py-0.5 text-[11px] font-medium text-[var(--color-text-secondary)]"
                        >
                          {tag}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            );
          })
        )}
      </div>

      {/* Pagination */}
      {pagination && pagination.total_pages > 1 && (
        <div className="flex items-center justify-between">
          <p className="text-xs text-[var(--color-text-muted)]">
            <span className="font-medium text-[var(--color-text)]">
              {(pagination.page - 1) * pagination.per_page + 1} to{" "}
              {Math.min(
                pagination.page * pagination.per_page,
                pagination.total,
              )}
            </span>{" "}
            of{" "}
            <span className="font-medium text-[var(--color-text)]">
              {pagination.total}
            </span>
          </p>
          <div className="flex items-center gap-1">
            <button
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={page <= 1}
              className="flex h-8 w-8 items-center justify-center rounded-lg border text-sm disabled:opacity-30"
              style={{ borderColor: "var(--color-border)" }}
            >
              <ChevronLeft size={14} />
            </button>
            {buildPageNumbers(page, pagination.total_pages).map((p, i) =>
              p === "..." ? (
                <span
                  key={`dots-${i}`}
                  className="px-1 text-xs text-[var(--color-text-muted)]"
                >
                  ...
                </span>
              ) : (
                <button
                  key={p}
                  onClick={() => setPage(p as number)}
                  className={`flex h-8 min-w-8 items-center justify-center rounded-lg border px-2 text-xs font-medium ${
                    page === p
                      ? "border-[var(--color-text)] bg-[var(--color-text)] text-white"
                      : "hover:bg-[var(--color-bg-secondary)]"
                  }`}
                  style={{
                    borderColor:
                      page === p
                        ? "var(--color-text)"
                        : "var(--color-border)",
                  }}
                >
                  {p}
                </button>
              ),
            )}
            <button
              onClick={() =>
                setPage((p) => Math.min(pagination.total_pages, p + 1))
              }
              disabled={page >= pagination.total_pages}
              className="flex h-8 w-8 items-center justify-center rounded-lg border text-sm disabled:opacity-30"
              style={{ borderColor: "var(--color-border)" }}
            >
              <ChevronRight size={14} />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function buildPageNumbers(
  current: number,
  total: number,
): (number | "...")[] {
  if (total <= 7) {
    return Array.from({ length: total }, (_, i) => i + 1);
  }
  const pages: (number | "...")[] = [1];
  if (current > 3) pages.push("...");
  for (
    let i = Math.max(2, current - 1);
    i <= Math.min(total - 1, current + 1);
    i++
  ) {
    pages.push(i);
  }
  if (current < total - 2) pages.push("...");
  pages.push(total);
  return pages;
}
