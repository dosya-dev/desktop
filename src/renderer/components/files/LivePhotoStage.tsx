// Ported from apps/web/src/components/live-photo-stage.tsx - keep in sync
// Desktop delta: no `zoom` prop (the desktop viewer has none).
import { useCallback, useEffect, useRef, useState } from 'react';
import { FilePreviewImage } from './FilePreviewImage';
import { fileRawUrl } from '@/lib/file-url';
import { fileIconSrc } from '@/components/files/FileIcon';
import { LiveBadge } from './LiveBadge';
import type { ViewerFile } from './FileViewer';

/**
 * A Live Photo on the viewer stage: the still, with its twin video laid over
 * it at opacity 0. Hover plays the twin once, muted, and fades it in; `ended`
 * fades back to the still; leaving pauses and rewinds. The badge is a button
 * so keyboard and touch users can play it, and it is the only trigger under
 * prefers-reduced-motion. The still never waits on the video: a twin that
 * fails to load leaves the still exactly as it was.
 */
export function LivePhotoStage({ file, twinId, version }: { file: ViewerFile; twinId: string; version?: number }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [playing, setPlaying] = useState(false);
  const [broken, setBroken] = useState(false);
  const reduced = typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

  const play = useCallback(() => {
    const v = videoRef.current;
    if (!v || broken) return;
    v.currentTime = 0;
    setPlaying(true);
    void v.play()?.catch(() => { setBroken(true); setPlaying(false); });
  }, [broken]);

  const stop = useCallback(() => {
    const v = videoRef.current;
    if (v) { v.pause(); v.currentTime = 0; }
    setPlaying(false);
  }, []);

  useEffect(() => () => stop(), [file.id, stop]);

  // React reuses this instance across navigation between two Live Photos (same
  // component type at the same position), so `playing`/`broken` state from the
  // last twin would otherwise leak into the next one: a failed twin would
  // disable the badge forever, and a still-hovered nav would leave the new
  // twin's video visible and unplayed. Reset hard whenever the twin changes.
  useEffect(() => {
    const v = videoRef.current;
    if (v) { v.pause(); v.currentTime = 0; }
    setPlaying(false);
    setBroken(false);
  }, [twinId]);

  return (
    <div
      data-testid="live-stage"
      className="relative max-w-full max-h-full flex items-center justify-center transition-transform duration-150"
      onPointerEnter={() => { if (!reduced) play(); }}
      onPointerLeave={stop}
    >
      <FilePreviewImage
        fileId={file.id}
        fileName={file.name}
        version={version}
        size={1600}
        className="max-w-full max-h-full object-contain rounded-md"
        alt={file.name}
        fallback={<img src={fileIconSrc(file.name)} alt={file.name} className="size-24" />}
      />
      <video
        ref={videoRef}
        data-testid="live-video"
        data-playing={playing ? 'true' : 'false'}
        src={fileRawUrl({ fileId: twinId })}
        muted
        playsInline
        preload="metadata"
        onEnded={() => setPlaying(false)}
        onError={() => { setBroken(true); setPlaying(false); }}
        className={`absolute inset-0 m-auto max-w-full max-h-full object-contain rounded-md pointer-events-none transition-opacity duration-150 ${playing ? 'opacity-100' : 'opacity-0'}`}
      />
      <button
        type="button"
        aria-label="Play Live Photo"
        title={broken ? 'Video unavailable' : 'Play Live Photo'}
        disabled={broken}
        onClick={(e) => { e.stopPropagation(); play(); }}
        className="absolute top-3 left-3 z-10 rounded-full focus-visible:ring-2 focus-visible:ring-white disabled:opacity-50"
      >
        <LiveBadge size="tile" style={playing ? { background: 'var(--brand)', color: 'var(--brand-foreground)' } : undefined} />
      </button>
    </div>
  );
}
