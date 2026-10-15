import type { LucideIcon } from "lucide-react";
import {
  Ban, Bell, Calendar, CalendarClock, CircleCheck, CirclePause, CircleStop, CircleX, Clock,
  CloudDownload, CloudOff, Copy, CreditCard, Crown, Database, Download, Eye, FileClock,
  FileText, Flame, Folder, FolderOpen, Gift, HardDrive, Hourglass, Inbox, KeyRound, LifeBuoy,
  Link, List, ListOrdered, Lock, LockKeyholeOpen, LockOpen, LogOut, Mail, MailCheck,
  MessageSquare, MessageSquareReply, MonitorSmartphone, Package, Plug, Recycle, RefreshCw,
  RotateCcw, RotateCw, Send, Server, Settings, Share2, Shield, ShieldAlert, ShieldCheck,
  ShieldOff, Sparkles, Ticket, TicketCheck, Trash, TrendingUp, TriangleAlert, Undo2, Unplug,
  Upload, UserCheck, UserCog, UserMinus, UserPlus, UserRound, UserX, UsersRound, Webhook,
  WebhookOff, Wrench,
} from "lucide-react";
import {
  NOTIFICATION_ICON_KEYS,
  notificationTone,
  resolveNotificationIcon,
  type NotificationIconKey,
} from "@dosya-dev/shared";

/**
 * Every icon key the API can write, as the Lucide component that draws it. The
 * key list is imported from @dosya-dev/shared (desktop can; web and mobile
 * carry a generated copy), and `Record<NotificationIconKey, …>` makes a key
 * with no drawing a type error.
 */
export const NOTIFICATION_ICON_COMPONENTS: Record<NotificationIconKey, LucideIcon> = {
  "bell": Bell,
  "shield": Shield,
  "shield-alert": ShieldAlert,
  "shield-check": ShieldCheck,
  "shield-off": ShieldOff,
  "key-round": KeyRound,
  "lock": Lock,
  "lock-open": LockOpen,
  "lock-keyhole-open": LockKeyholeOpen,
  "monitor-smartphone": MonitorSmartphone,
  "mail": Mail,
  "mail-check": MailCheck,
  "list-ordered": ListOrdered,
  "log-out": LogOut,
  "life-buoy": LifeBuoy,
  "triangle-alert": TriangleAlert,
  "user-round": UserRound,
  "users-round": UsersRound,
  "user-plus": UserPlus,
  "user-minus": UserMinus,
  "user-x": UserX,
  "user-check": UserCheck,
  "user-cog": UserCog,
  "crown": Crown,
  "settings": Settings,
  "wrench": Wrench,
  "package": Package,
  "calendar": Calendar,
  "calendar-clock": CalendarClock,
  "clock": Clock,
  "hourglass": Hourglass,
  "circle-check": CircleCheck,
  "circle-x": CircleX,
  "circle-stop": CircleStop,
  "circle-pause": CirclePause,
  "trash": Trash,
  "flame": Flame,
  "folder": Folder,
  "folder-open": FolderOpen,
  "link": Link,
  "share-2": Share2,
  "eye": Eye,
  "trending-up": TrendingUp,
  "download": Download,
  "upload": Upload,
  "file-clock": FileClock,
  "file-text": FileText,
  "rotate-ccw": RotateCcw,
  "list": List,
  "copy": Copy,
  "inbox": Inbox,
  "undo-2": Undo2,
  "message-square": MessageSquare,
  "message-square-reply": MessageSquareReply,
  "refresh-cw": RefreshCw,
  "rotate-cw": RotateCw,
  "cloud-download": CloudDownload,
  "cloud-off": CloudOff,
  "plug": Plug,
  "unplug": Unplug,
  "webhook": Webhook,
  "webhook-off": WebhookOff,
  "database": Database,
  "credit-card": CreditCard,
  "hard-drive": HardDrive,
  "gift": Gift,
  "ban": Ban,
  "ticket": Ticket,
  "ticket-check": TicketCheck,
  "recycle": Recycle,
  "send": Send,
  "sparkles": Sparkles,
  "server": Server,
};

export const KNOWN_ICON_KEYS = NOTIFICATION_ICON_KEYS;

/**
 * The inbox row's glyph: a hairline ring around a 16px line icon. Same rules as
 * the web component: unread sharpens the ring to the text colour, important
 * takes the warning hue, critical the danger hue, everything else stays muted.
 */
export function NotificationIcon({
  icon, category, priority, unread = false, size = 32,
}: {
  icon: string | null | undefined;
  category: string | null | undefined;
  priority: string | null | undefined;
  unread?: boolean;
  /** Outer diameter in px. The dropdown is denser than the full page. */
  size?: number;
}) {
  const key = resolveNotificationIcon(icon, category);
  const tone = notificationTone(priority);
  const Glyph = NOTIFICATION_ICON_COMPONENTS[key];
  const color =
    tone === "critical" ? "var(--color-danger)"
    : tone === "important" ? "var(--color-warning)"
    : unread ? "var(--color-text)"
    : "var(--color-text-secondary)";
  const emphasised = tone !== "normal" || unread;
  return (
    <span
      data-icon={key}
      data-tone={tone}
      aria-hidden="true"
      className="flex shrink-0 items-center justify-center rounded-full border"
      style={{
        width: size,
        height: size,
        color,
        borderColor: emphasised ? `color-mix(in srgb, ${color} 45%, transparent)` : "var(--color-border)",
      }}
    >
      <Glyph size={Math.round(size / 2)} strokeWidth={1.75} />
    </span>
  );
}
