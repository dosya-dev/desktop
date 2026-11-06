import { useEffect, useState, type CSSProperties } from "react";
import { apiBase } from "@/lib/api-client";
import { useWorkspaceIconVersion, workspaceIconUrl } from "@/lib/workspace-icon-version";
import { useAutoDir } from "@/lib/bidi-ui";

interface BadgeWorkspace {
  id: string;
  icon_initials?: string | null;
  icon_color?: string | null;
  icon_image_url?: string | null;
}

/**
 * A workspace's square badge: its uploaded logo when it has one, otherwise
 * its initials on the workspace colour. Size, radius and type size come from
 * `className`, so each surface keeps its own dimensions. A logo that fails to
 * load falls back to the initials instead of a broken image.
 */
export function WorkspaceBadge({ ws, className = "" }: { ws: BadgeWorkspace | null | undefined; className?: string }) {
  const ownDir = useAutoDir();
  const version = useWorkspaceIconVersion((s) => s.version);
  const src = ws?.icon_image_url ? workspaceIconUrl(apiBase(), ws.id, version) : null;
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  // A new URL (another workspace, or a fresh upload) gets a fresh attempt.
  useEffect(() => setFailedSrc(null), [src]);
  const showImage = !!src && failedSrc !== src;

  const style: CSSProperties = showImage
    ? { background: "var(--color-bg-tertiary)" }
    : { background: ws?.icon_color || "var(--color-primary)" };

  return (
    <div
      dir={ownDir}
      className={`flex shrink-0 items-center justify-center overflow-hidden font-semibold text-[var(--color-primary-fg)] ${className}`}
      style={style}
    >
      {showImage ? (
        <img src={src} alt="" className="h-full w-full object-cover" onError={() => setFailedSrc(src)} />
      ) : (
        ws?.icon_initials || "?"
      )}
    </div>
  );
}
