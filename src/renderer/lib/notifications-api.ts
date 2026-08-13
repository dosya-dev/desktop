import { api } from "@/lib/api-client";
import type { NotificationItem, NotificationSummary } from "@dosya-dev/shared";

export interface InboxPage {
  items: NotificationItem[];
  /** Cursor for the next page, or null at the end of the list. */
  nextBefore: number | null;
}

/** `limit` is capped at 50 server-side; `before` is the previous page's nextBefore. */
export async function fetchInbox(before?: number | null, limit = 30): Promise<InboxPage> {
  const qs = new URLSearchParams({ limit: String(limit) });
  if (before != null) qs.set("before", String(before));
  const res = await api.get<{ ok: boolean; items: NotificationItem[]; nextBefore: number | null }>(
    `/api/notifications?${qs.toString()}`,
  );
  return { items: res.items ?? [], nextBefore: res.nextBefore ?? null };
}

export async function fetchSummary(): Promise<NotificationSummary> {
  const res = await api.get<{ ok: boolean } & NotificationSummary>("/api/notifications/summary");
  return { unread: res.unread ?? 0, latest: res.latest ?? null };
}

export async function markRead(id: string): Promise<void> {
  await api.post(`/api/notifications/${id}/read`);
}

export async function markAllRead(): Promise<void> {
  await api.post("/api/notifications/read-all");
}

export async function dismiss(id: string): Promise<void> {
  await api.post(`/api/notifications/${id}/dismiss`);
}
