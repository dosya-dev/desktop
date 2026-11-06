// Ported from apps/web/src/components/video-poster.tsx - keep in sync with the web copy.
import { useEffect, useState } from "react";
import { fileThumbUrl } from "@/lib/file-url";
import { ensurePoster } from "@/lib/video-poster";

interface VideoPosterProps {
  file: { id: string; current_version?: number | null; lock_mode?: string | null };
  /** Unlock token for a full_lock video the viewer has opened this session. */
  unlockToken?: string | null;
  className?: string;
}

/**
 * A video's still frame, filling its (positioned) parent. Renders nothing
 * until there is a picture, so the card's own plate shows through meanwhile.
 *
 * The server's poster first (/thumb); when there is none, a frame grabbed in
 * this tab (lib/video-poster.ts), which is also offered to the server. A
 * locked video is never grabbed: the server refuses its poster anyway.
 */
export function VideoPoster(props: VideoPosterProps) {
  // A new key per video and version: a recycled card starts over cleanly.
  const { file, unlockToken } = props;
  return <PosterImage key={`${file.id}:${file.current_version ?? 1}:${file.lock_mode ?? ""}:${unlockToken ?? ""}`} {...props} />;
}

function PosterImage({ file, unlockToken, className = "" }: VideoPosterProps) {
  const locked = file.lock_mode === "full_lock";
  const version = file.current_version ?? undefined;
  const serverSrc = fileThumbUrl({ fileId: file.id, version, size: 512, query: unlockToken ? `ut=${unlockToken}` : undefined });
  const [src, setSrc] = useState<string | null>(locked && !unlockToken ? null : serverSrc);
  const [loaded, setLoaded] = useState(false);
  const [grab, setGrab] = useState(false);

  useEffect(() => {
    if (!grab) return;
    let alive = true;
    ensurePoster({ id: file.id, current_version: version }).then((url) => {
      if (alive) setSrc(url);
    });
    return () => { alive = false; };
  }, [grab, file.id, version]);

  if (!src) return null;
  return (
    <img
      src={src}
      alt=""
      aria-hidden
      draggable={false}
      data-testid={`video-poster-${file.id}`}
      className={`absolute inset-0 size-full object-cover transition-opacity duration-200 ${loaded ? "opacity-100" : "opacity-0"} ${className}`}
      onLoad={() => setLoaded(true)}
      onError={() => {
        // The server has none yet (or the tab-made one failed): grab once, then give up.
        setSrc(null);
        if (src === serverSrc && !locked) setGrab(true);
      }}
    />
  );
}
