import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useInfiniteQuery, useQueryClient } from "@tanstack/react-query";
import { Bell, CheckCheck, X, Loader2 } from "lucide-react";
import {
  mergeInboxPages, groupByDay, parseActions, isUnread, relativeTime, mapActionPath,
  type NotificationItem,
} from "@dosya-dev/shared";
import { fetchInbox, markRead, markAllRead, dismiss } from "@/lib/notifications-api";

/**
 * The full inbox. The dropdown in the title bar shows the latest 10; the API
 * caps a page at 50, so anyone with real history needs this paginated view.
 */
export function NotificationsPage() {
  const navigate = useNavigate();
  const qc = useQueryClient();

  const q = useInfiniteQuery({
    queryKey: ["notifications", "list"],
    queryFn: ({ pageParam }) => fetchInbox(pageParam as number | null),
    initialPageParam: null as number | null,
    getNextPageParam: (last) => last.nextBefore,
  });

  // Local edits are id sets projected over the server pages, not a snapshot of
  // the list: a snapshot goes stale when the next page loads, and a dismissed
  // row would reappear.
  const [readIds, setReadIds] = useState<Set<string>>(new Set());
  const [dismissedIds, setDismissedIds] = useState<Set<string>>(new Set());
  const [readAllAt, setReadAllAt] = useState<number | null>(null);

  const resetLocal = () => { setReadIds(new Set()); setDismissedIds(new Set()); setReadAllAt(null); };
  const refreshBadge = () => { void qc.invalidateQueries({ queryKey: ["notifications", "summary"] }); };

  const serverItems = mergeInboxPages((q.data?.pages ?? []).map((p) => p.items));
  const now = Math.floor(Date.now() / 1000);

  const items = serverItems
    .filter((i) => !dismissedIds.has(i.id))
    .map((i) => {
      if (i.read_at != null) return i;
      if (readAllAt != null) return { ...i, read_at: readAllAt };
      if (readIds.has(i.id)) return { ...i, read_at: now };
      return i;
    });

  const onRead = (item: NotificationItem) => {
    if (!isUnread(item)) return;
    setReadIds((prev) => new Set(prev).add(item.id));
    markRead(item.id).then(refreshBadge).catch(() => { resetLocal(); void q.refetch(); });
  };

  const onDismiss = (item: NotificationItem) => {
    setDismissedIds((prev) => new Set(prev).add(item.id));
    dismiss(item.id).then(refreshBadge).catch(() => { resetLocal(); void q.refetch(); });
  };

  const onReadAll = () => {
    setReadAllAt(now);
    markAllRead().then(refreshBadge).catch(() => { resetLocal(); void q.refetch(); });
  };

  const openItem = (item: NotificationItem) => {
    onRead(item);
    const to = mapActionPath(item.link_path, "desktop");
    if (to) navigate(to);
  };

  const groups = groupByDay(items, now);

  return (
    <div className="mx-auto max-w-3xl px-6 py-6">
      <div className="mb-5 flex items-center justify-between">
        <h1 className="text-xl font-semibold">Notifications</h1>
        {items.some(isUnread) && (
          <button
            data-testid="mark-all-read"
            onClick={onReadAll}
            className="inline-flex items-center gap-1.5 text-xs text-[var(--color-text-secondary)] hover:text-[var(--color-text)]"
          >
            <CheckCheck size={14} /> Mark all read
          </button>
        )}
      </div>

      {q.isLoading && (
        <div className="flex justify-center py-16"><Loader2 className="animate-spin" size={18} /></div>
      )}

      {!q.isLoading && items.length === 0 && (
        <div data-testid="inbox-empty" className="py-16 text-center">
          <Bell size={22} className="mx-auto mb-2 text-[var(--color-text-secondary)]" />
          <p className="text-sm text-[var(--color-text-secondary)]">You&rsquo;re all caught up.</p>
        </div>
      )}

      {groups.map((g) => (
        <section key={g.label} className="mb-6">
          <h2 className="mb-2 text-[11px] uppercase tracking-wide text-[var(--color-text-secondary)]">{g.label}</h2>
          <div className="overflow-hidden rounded-xl border" style={{ borderColor: "var(--color-border)" }}>
            {g.items.map((item) => {
              const actions = parseActions(item.actions);
              return (
                <div
                  key={item.id}
                  data-testid={`notification-${item.id}`}
                  className="flex gap-3 border-b px-4 py-3 last:border-b-0 hover:bg-black/5"
                  style={{ borderColor: "var(--color-border)" }}
                >
                  <span
                    data-testid={isUnread(item) ? `unread-dot-${item.id}` : undefined}
                    className="mt-2 size-2 shrink-0 rounded-full"
                    style={{ background: isUnread(item) ? "var(--color-primary)" : "transparent" }}
                  />
                  <button onClick={() => openItem(item)} className="min-w-0 flex-1 text-left">
                    <p className={`text-sm ${isUnread(item) ? "font-semibold" : ""}`}>{item.title}</p>
                    {item.body && (
                      <p className="mt-0.5 text-xs text-[var(--color-text-secondary)]">{item.body}</p>
                    )}
                    <p className="mt-1 text-[11px] text-[var(--color-text-secondary)]">
                      {relativeTime(item.created_at, now)}
                      {item.actor_name ? ` · ${item.actor_name}` : ""}
                    </p>
                  </button>
                  <div className="flex shrink-0 items-start gap-3">
                    {actions.map((a, i) => {
                      const to = a.handler === "navigate" ? mapActionPath(a.params?.path, "desktop") : null;
                      if (a.handler === "navigate" && !to) return null;
                      return (
                        <button
                          key={i}
                          data-testid={`action-${item.id}-${i}`}
                          onClick={() => {
                            if (a.handler === "dismiss") onDismiss(item);
                            else if (to) { onRead(item); navigate(to); }
                          }}
                          className="text-xs font-medium text-[var(--color-primary)] hover:underline"
                        >
                          {a.label}
                        </button>
                      );
                    })}
                    <button
                      data-testid={`dismiss-${item.id}`}
                      aria-label={`Dismiss ${item.title}`}
                      onClick={() => onDismiss(item)}
                      className="text-[var(--color-text-secondary)] hover:text-[var(--color-danger)]"
                    >
                      <X size={14} />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      ))}

      {q.hasNextPage && (
        <div className="flex justify-center pb-6">
          <button
            data-testid="load-more"
            onClick={() => void q.fetchNextPage()}
            disabled={q.isFetchingNextPage}
            className="inline-flex items-center gap-2 rounded-lg border px-3 py-1.5 text-xs hover:bg-black/5 disabled:opacity-60"
            style={{ borderColor: "var(--color-border)" }}
          >
            {q.isFetchingNextPage && <Loader2 size={13} className="animate-spin" />}
            {q.isFetchingNextPage ? "Loading…" : "Load older"}
          </button>
        </div>
      )}
    </div>
  );
}
