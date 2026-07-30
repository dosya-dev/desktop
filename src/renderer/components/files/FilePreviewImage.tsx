// Ported from apps/web/src/components/file-preview-image.tsx - keep in sync with the web copy.
import { useEffect, useEffectEvent, useRef, useState } from "react";
import { fileThumbUrl, fileRawUrl, type ThumbSize } from "@/lib/file-url";
import { getHeicPreviewUrl, releaseHeicPreviewUrl } from "@/lib/heic";
import { isImage, isHeic } from "@/lib/file-type";

interface FilePreviewImageProps {
  fileId: string;
  fileName: string;
  version?: number;
  /** Extra query params, e.g. `ut=<unlock token>`. */
  query?: string;
  /** Longest edge of the thumbnail. */
  size?: ThumbSize;
  className?: string;
  alt?: string;
  /** Shown when the file isn't an image, or every preview path has failed. */
  fallback: React.ReactNode;
}

/**
 * The one place a file preview image is rendered.
 *
 * Non-HEIC images render natively from the original bytes (`/raw`). HEIC is
 * handled with a hybrid strategy: ask the server for a WebP thumbnail
 * (`/thumb`); when the server can't decode it (415 for photos too large for
 * the Worker's memory budget), decode in-renderer via the WASM worker pool;
 * if that fails too, show the `fallback` icon.
 *
 * This wrapper picks a `key` from the file identity so React fully remounts
 * the inner component whenever it's pointed at a different file/version/query/
 * size (e.g. next/prev navigation in the viewer), resetting failure state.
 */
export function FilePreviewImage(props: FilePreviewImageProps) {
  const resetKey = `${props.fileId}:${props.version ?? 0}:${props.query ?? ""}:${props.size ?? 256}`;
  return <FilePreviewImageForFile key={resetKey} {...props} />;
}

function FilePreviewImageForFile({
  fileId,
  fileName,
  version,
  query,
  size = 256,
  className,
  alt = "",
  fallback,
}: FilePreviewImageProps) {
  // `failed` = every path exhausted → show the fallback icon.
  const [failed, setFailed] = useState(false);
  // `serverFailed` = the server couldn't make a thumbnail (e.g. 415 for a photo
  // too large to decode in a Worker) → decode it in the renderer instead.
  const [serverFailed, setServerFailed] = useState(false);
  // `thumbFailed` = the server thumbnail didn't load for a non-HEIC image →
  // fall back to the raw original for this file.
  const [thumbFailed, setThumbFailed] = useState(false);

  if (!isImage(fileName) || failed) return <>{fallback}</>;

  if (isHeic(fileName)) {
    if (!serverFailed) {
      return (
        <img
          src={fileThumbUrl({ fileId, version, query, size })}
          alt={alt}
          className={className}
          loading="lazy"
          onError={() => setServerFailed(true)}
        />
      );
    }
    return (
      <HeicPreview
        fileId={fileId}
        version={version}
        query={query}
        maxDim={size}
        className={className}
        alt={alt}
        onFail={() => setFailed(true)}
      />
    );
  }

  // Every other image format: request a server-generated thumbnail sized to the
  // caller's `size` - a 28px table row or a grid tile shouldn't download and
  // decode the full-resolution original. Fall back to the raw original only if
  // the thumbnail itself fails to load.
  if (!thumbFailed) {
    return (
      <img
        src={fileThumbUrl({ fileId, version, query, size })}
        alt={alt}
        className={className}
        loading="lazy"
        onError={() => setThumbFailed(true)}
      />
    );
  }
  return (
    <img
      src={fileRawUrl({ fileId, version, query })}
      alt={alt}
      className={className}
      loading="lazy"
      onError={() => setFailed(true)}
    />
  );
}

/**
 * Renderer-side HEIC decode, used only when the server couldn't produce a
 * thumbnail. Decodes the original bytes to an object URL via the WASM worker
 * pool, gated on an IntersectionObserver so a big grid only decodes what's
 * actually visible (an object URL can't use `loading="lazy"`).
 */
function HeicPreview({
  fileId,
  version,
  query,
  maxDim,
  className,
  alt,
  onFail,
}: {
  fileId: string;
  version?: number;
  query?: string;
  maxDim: number;
  className?: string;
  alt: string;
  onFail: () => void;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [visible, setVisible] = useState(false);

  // `onFail` is a fresh closure every render; useEffectEvent gives the decode
  // effect a stable function that always sees the latest one, so it doesn't need
  // to be a dependency and doesn't re-trigger the decode on every re-render.
  const handleFail = useEffectEvent(() => {
    onFail();
  });

  useEffect(() => {
    const host = hostRef.current;
    if (!host || visible) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setVisible(true);
          observer.disconnect();
        }
      },
      { rootMargin: "200px" },
    );
    observer.observe(host);
    return () => observer.disconnect();
  }, [visible]);

  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    const req = { fileId, version, query, maxDim };

    // `getHeicPreviewUrl` takes a live refcount on the cache entry; the cleanup
    // below releases it. This pairs exactly one acquire with one release per
    // effect run (the early `return` above skips both), so the cache knows when
    // no component is displaying this URL and can safely revoke it.
    getHeicPreviewUrl(req)
      .then((decoded) => {
        if (!cancelled) setUrl(decoded);
      })
      .catch(() => {
        if (!cancelled) handleFail();
      });

    return () => {
      cancelled = true;
      releaseHeicPreviewUrl(req);
    };
  }, [visible, fileId, version, query, maxDim]);

  // NB: the object URL is owned and revoked by the LRU cache in heic-cache.ts -
  // never revoke it here (other mounted components may still be showing it). We
  // only release our refcount on unmount so the cache can revoke it once the
  // last displaying component is gone.
  if (!url) {
    return <div ref={hostRef} className={`${className ?? ""} animate-pulse bg-[var(--color-bg-tertiary)]`} />;
  }

  return <img src={url} alt={alt} className={className} />;
}
