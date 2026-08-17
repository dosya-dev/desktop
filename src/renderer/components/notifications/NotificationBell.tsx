import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Bell, CheckCheck, X, Settings } from "lucide-react";
import {
  groupByDay, parseActions, isUnread, relativeTime, mapActionPath,
  type NotificationItem,
} from "@dosya-dev/shared";
import { fetchInbox, fetchSummary, markRead, markAllRead, dismiss } from "@/lib/notifications-api";

/** Two digits fit the dot; past that the exact number stops being the point. */
export function badgeLabel(unread: number): string {
  return unread > 99 ? "99+" : String(unread);
}

/**
 * `align` names which edge of the bell the dropdown pins to. The titlebar
 * puts the bell in the right cluster on macOS ("right": panel grows leftward,
 * staying on-screen) but in the LEFT cluster on Windows/Linux, where the
 * panel must grow rightward instead - right-aligned there, most of its 320px
 * hangs past the window's left edge.
 */
export function NotificationBell({ align = "right" }: { align?: "left" | "right" } = {}) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  const summary = useQuery({
    queryKey: ["notifications", "summary"],
    queryFn: fetchSummary,
    // The endpoint is KV-cached server-side, so a slow poll costs almost
    // nothing and the badge does not sit stale for a whole session.
    refetchInterval: 60_000,
  });

  const list = useQuery({
    queryKey: ["notifications", "peek"],
    queryFn: () => fetchInbox(null, 10),
    enabled: open,
  });

  // Outside click and Escape, matching how the file browser's context menu
  // closes. Registered only while open so it is not a permanent listener.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ["notifications"] });
  };

  const unread = summary.data?.unread ?? 0;
  const items = list.data?.items ?? [];
  const now = Math.floor(Date.now() / 1000);
  const groups = groupByDay(items, now);

  const openItem = (item: NotificationItem) => {
    if (isUnread(item)) void markRead(item.id).then(refresh).catch(() => {});
    // Stored paths are WEB routes; null means desktop has no equivalent, so the
    // row stays readable but goes nowhere rather than opening a dead route.
    const to = mapActionPath(item.link_path, "desktop");
    if (to) { setOpen(false); navigate(to); }
  };

  return (
    <div ref={wrapRef} className="titlebar-no-drag relative">
      <button
        onClick={() => setOpen((v) => !v)}
        aria-label={unread > 0 ? `Notifications, ${unread} unread` : "Notifications"}
        title="Notifications"
        data-testid="open-notifications"
        className="relative flex items-center rounded-lg px-2.5 py-1 text-[var(--color-text-secondary)] transition-colors hover:bg-black/5"
      >
        <Bell size={13} />
        {unread > 0 && (
          <span
            data-testid="notification-badge"
            className="absolute -right-0.5 -top-0.5 flex h-3.5 min-w-3.5 items-center justify-center rounded-full px-1 text-[9px] font-bold text-white"
            style={{ background: "var(--color-primary)" }}
          >
            {badgeLabel(unread)}
          </span>
        )}
      </button>

      {open && (
        <div
          data-testid="notification-dropdown"
          className={`anim-pop-in absolute ${align === "left" ? "left-0" : "right-0"} top-full z-50 mt-2 flex max-h-[70vh] w-80 flex-col overflow-hidden rounded-xl border shadow-xl`}
          style={{ background: "var(--color-bg)", borderColor: "var(--color-border)", transformOrigin: align === "left" ? "top left" : "top right" }}
        >
          <div className="flex items-center justify-between border-b px-3 py-2" style={{ borderColor: "var(--color-border)" }}>
            <span className="text-sm font-semibold">Notifications</span>
            {items.some(isUnread) && (
              <button
                data-testid="mark-all-read"
                onClick={() => void markAllRead().then(refresh).catch(() => {})}
                className="inline-flex items-center gap-1 text-xs text-[var(--color-text-secondary)] hover:text-[var(--color-text)]"
              >
                <CheckCheck size={13} /> Mark all read
              </button>
            )}
          </div>

          <div className="flex-1 overflow-y-auto">
            {list.isLoading && (
              <p className="px-3 py-6 text-center text-sm text-[var(--color-text-secondary)]">Loading…</p>
            )}
            {!list.isLoading && items.length === 0 && (
              <p data-testid="inbox-empty" className="px-3 py-6 text-center text-sm text-[var(--color-text-secondary)]">
                You&rsquo;re all caught up.
              </p>
            )}
            {groups.map((g) => (
              <div key={g.label}>
                <div className="px-3 pb-1 pt-2 text-[11px] uppercase tracking-wide text-[var(--color-text-secondary)]">
                  {g.label}
                </div>
                {g.items.map((item) => {
                  const actions = parseActions(item.actions);
                  return (
                    <div
                      key={item.id}
                      data-testid={`notification-${item.id}`}
                      className="flex gap-2 border-b px-3 py-2 last:border-b-0 hover:bg-black/5"
                      style={{ borderColor: "var(--color-border)" }}
                    >
                      {/* Unread is a dot, not a tinted row: colouring every
                          unread row turns the whole list into an alert. */}
                      <span
                        data-testid={isUnread(item) ? `unread-dot-${item.id}` : undefined}
                        className="mt-1.5 size-1.5 shrink-0 rounded-full"
                        style={{ background: isUnread(item) ? "var(--color-primary)" : "transparent" }}
                      />
                      <button onClick={() => openItem(item)} className="min-w-0 flex-1 text-left">
                        <p className={`truncate text-xs ${isUnread(item) ? "font-semibold" : ""}`}>{item.title}</p>
                        {item.body && (
                          <p className="mt-0.5 line-clamp-2 text-[11px] text-[var(--color-text-secondary)]">{item.body}</p>
                        )}
                        <p className="mt-0.5 text-[10px] text-[var(--color-text-secondary)]">
                          {relativeTime(item.created_at, now)}
                          {item.actor_name ? ` · ${item.actor_name}` : ""}
                        </p>
                        {actions.length > 0 && (
                          <span className="mt-1 flex gap-3">
                            {actions.map((a, i) => {
                              const to = a.handler === "navigate" ? mapActionPath(a.params?.path, "desktop") : null;
                              // A navigate action with no desktop route renders
                              // nothing; a visible button that does nothing is
                              // worse than its absence.
                              if (a.handler === "navigate" && !to) return null;
                              return (
                                <span
                                  key={i}
                                  data-testid={`action-${item.id}-${i}`}
                                  className="text-[11px] font-medium text-[var(--color-primary)] hover:underline"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    if (a.handler === "dismiss") void dismiss(item.id).then(refresh).catch(() => {});
                                    else if (to) { setOpen(false); navigate(to); }
                                  }}
                                >
                                  {a.label}
                                </span>
                              );
                            })}
                          </span>
                        )}
                      </button>
                      <button
                        data-testid={`dismiss-${item.id}`}
                        aria-label={`Dismiss ${item.title}`}
                        onClick={() => void dismiss(item.id).then(refresh).catch(() => {})}
                        className="shrink-0 self-start text-[var(--color-text-secondary)] hover:text-[var(--color-danger)]"
                      >
                        <X size={12} />
                      </button>
                    </div>
                  );
                })}
              </div>
            ))}
          </div>

          <div className="flex items-center justify-between border-t px-3 py-2 text-xs" style={{ borderColor: "var(--color-border)" }}>
            <button
              data-testid="view-all-notifications"
              onClick={() => { setOpen(false); navigate("/notifications"); }}
              className="text-[var(--color-text-secondary)] hover:text-[var(--color-text)]"
            >
              View all
            </button>
            <button
              onClick={() => { setOpen(false); navigate("/profile"); }}
              className="inline-flex items-center gap-1 text-[var(--color-text-secondary)] hover:text-[var(--color-text)]"
            >
              <Settings size={13} /> Settings
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
