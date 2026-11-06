import { useT } from "@/lib/i18n";

/** A red count for unseen live chat replies (Help & contact tab, Live chat row, sidebar avatar). */
export function UnreadBadge({ count, className = "" }: { count: number; className?: string }) {
  const t = useT();
  return (
    <span
      data-testid="support-chat-unread"
      className={`min-w-[18px] shrink-0 rounded-full bg-[var(--color-danger)] px-1.5 text-center text-xs font-semibold leading-[18px] text-white ${className}`}
      aria-label={t("support-chat.label.unreadCount", { count })}
    >
      {count > 99 ? "99+" : count}
    </span>
  );
}
