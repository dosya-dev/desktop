// apps/desktop/src/renderer/components/personas/FaceAvatar.tsx
//
// Ported from apps/web/src/components/personas/face-avatar.tsx - keep in step.
//
// A round face picture: a CSS crop of the photo's own 256 px thumbnail around
// the face box the engine keeps on this device (no face image is made or
// stored anywhere). The image stays hidden until its size is known, so it
// never shows uncropped; a thumbnail that cannot load shows a person icon.
import { useState } from "react";
import { UserRound } from "lucide-react";
import { useT } from "@/lib/i18n";
import { faceCrop, faceThumbUrl, type FaceBox } from "@/lib/personas";

export function FaceAvatar({ fileId, box, name, className = "size-24" }: {
  /** The photo the face is in. */
  fileId: string;
  /** The face, as fractions of that photo. */
  box: FaceBox;
  /** The person's name; null or empty reads as "Face". */
  name: string | null;
  /** Size and any extra classes; `size-24` when not given. */
  className?: string;
}) {
  const t = useT();
  const src = faceThumbUrl(fileId);
  const [size, setSize] = useState<{ src: string; w: number; h: number } | null>(null);
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const alt = name?.trim() ? name : t("personas.label.face");
  const base = `relative inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full bg-[var(--color-bg-tertiary)] ${className}`;

  if (failedSrc === src) {
    return (
      <span role="img" aria-label={alt} className={base}>
        <UserRound className="size-1/2 text-[var(--color-text-muted)]" aria-hidden="true" />
      </span>
    );
  }
  const crop = size && size.src === src ? faceCrop(box, size.w, size.h) : null;
  return (
    <span className={base}>
      <img
        src={src}
        alt={alt}
        loading="lazy"
        decoding="async"
        draggable={false}
        className="max-w-none"
        style={{
          position: "absolute",
          opacity: crop ? 1 : 0,
          width: `${crop?.width ?? 100}%`,
          height: `${crop?.height ?? 100}%`,
          // rtl-ok: physical geometry, the photo is never mirrored
          left: `${crop?.x ?? 0}%`,
          top: `${crop?.y ?? 0}%`,
        }}
        onLoad={(e) => {
          const img = e.currentTarget;
          if (img.naturalWidth > 0 && img.naturalHeight > 0) setSize({ src, w: img.naturalWidth, h: img.naturalHeight });
        }}
        onError={() => setFailedSrc(src)}
      />
    </span>
  );
}
