import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import { mountDosyaPlayer, type DosyaPlayer, type PlayerOptions } from './player';

export interface DosyaVideoHandle {
  currentTimeMs(): number;
  seekMs(ms: number): void;
  pause(): void;
}

export interface DosyaVideoProps extends Omit<PlayerOptions, 'src'> {
  /** `${fileId}:${version ?? 'current'}`. A change destroys and re-mounts the player. */
  identity: string;
  /** Read only when a player mounts. A new src with the same identity is ignored. */
  src: string;
  className?: string;
}

export const DosyaVideo = forwardRef<DosyaVideoHandle, DosyaVideoProps>(function DosyaVideo(props, ref) {
  const { identity, className } = props;
  const hostRef = useRef<HTMLDivElement>(null);
  const playerRef = useRef<DosyaPlayer | null>(null);
  // Latest props, read by the mount effect and by callbacks without re-mounting.
  const latest = useRef(props);
  latest.current = props;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const p = latest.current;
    const player = mountDosyaPlayer(host, {
      src: p.src,
      title: p.title,
      autoplay: p.autoplay,
      preload: p.preload,
      compact: p.compact,
      keys: p.keys,
      downloadUrl: p.downloadUrl,
      onDownloadClick: p.onDownloadClick ? () => latest.current.onDownloadClick?.() : undefined,
      failureText: p.failureText,
      markers: p.markers,
      report: p.report,
      reducedMotion: p.reducedMotion,
      labels: p.labels,
      onMarkerSelect: (id) => latest.current.onMarkerSelect?.(id),
      onDuration: (s) => latest.current.onDuration?.(s),
      onFailed: () => latest.current.onFailed?.(),
    });
    playerRef.current = player;
    return () => {
      player.destroy();
      playerRef.current = null;
    };
  }, [identity]);

  const { markers, title, report } = props;
  useEffect(() => {
    playerRef.current?.update({ markers, title, report });
  }, [markers, title, report]);

  useImperativeHandle(
    ref,
    () => ({
      currentTimeMs: () => playerRef.current?.currentTimeMs() ?? 0,
      seekMs: (ms) => playerRef.current?.seekMs(ms),
      pause: () => playerRef.current?.pause(),
    }),
    [],
  );

  return <div ref={hostRef} className={className} />;
});
