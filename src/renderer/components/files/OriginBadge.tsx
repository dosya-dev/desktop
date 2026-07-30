// Ported from apps/web/src/components/origin-badge.tsx - keep in sync with the web copy.
import { Monitor, Smartphone, Terminal, Plug, type LucideIcon } from "lucide-react";
import { originLabel } from "@/lib/file-type";

// webdav/s3/ftp/import share one generic "integration" badge - the Origin
// list column shows the precise name. web and legacy (null) rows get none.
const BADGE_STYLE: Record<string, { icon: LucideIcon; bg: string }> = {
  desktop: { icon: Monitor, bg: "bg-green-600" },
  mobile: { icon: Smartphone, bg: "bg-blue-500" },
  cli: { icon: Terminal, bg: "bg-zinc-700" },
  webdav: { icon: Plug, bg: "bg-orange-500" },
  s3: { icon: Plug, bg: "bg-orange-500" },
  ftp: { icon: Plug, bg: "bg-orange-500" },
  import: { icon: Plug, bg: "bg-orange-500" },
};

/** Top-left origin dot for a file/folder icon. Parent element must be `relative`. */
export function OriginBadge({ origin }: { origin?: string | null }) {
  if (!origin || !(origin in BADGE_STYLE)) return null;
  const { icon: Icon, bg } = BADGE_STYLE[origin];
  return (
    <span
      title={`Added via ${originLabel(origin)}`}
      className={`absolute -top-1 -left-1 z-10 flex h-3.5 w-3.5 items-center justify-center rounded-full ring-2 ring-[var(--color-bg)] ${bg}`}
    >
      <Icon size={8} className="text-white" />
    </span>
  );
}
