import { useMemo } from 'react';
import { parseLrc, type LyricLine, type AudioTags } from '@dosya-dev/audio-player';

export interface Lyrics {
  lines: LyricLine[];
  /** True when the file carried real timestamps, so the active line can lead. */
  synced: boolean;
}

/**
 * Lyrics come from the file's own USLT frame. A sibling .lrc lookup would need
 * a folder listing the viewer does not hold, so that is not wired here; the
 * empty state says where lyrics come from.
 */
export function useLyrics(tags: AudioTags): Lyrics | null {
  return useMemo(() => {
    const raw = tags.lyrics;
    if (!raw) return null;

    const timed = parseLrc(raw);
    if (timed.length > 0) return { lines: timed, synced: true };

    // Untimed lyrics still display - one entry per non-empty line, no cue.
    const plain = raw
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean)
      .map((line) => ({ t: 0, line }));
    return plain.length > 0 ? { lines: plain, synced: false } : null;
  }, [tags.lyrics]);
}
