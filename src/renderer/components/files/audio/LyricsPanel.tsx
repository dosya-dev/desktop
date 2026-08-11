import { useEffect, useMemo, useRef } from 'react';
import { MicVocal } from 'lucide-react';
import type { LyricLine } from '@dosya-dev/audio-player';

interface Props {
  lines: LyricLine[] | null;
  /** True when the lines carry real cues. Untimed lyrics render as plain text. */
  synced: boolean;
  position: number;
}

export function LyricsPanel({ lines, synced, position }: Props) {
  const bodyRef = useRef<HTMLDivElement>(null);
  const activeRef = useRef<HTMLLIElement>(null);

  const activeIndex = useMemo(() => {
    if (!lines || !synced) return -1;
    let idx = -1;
    for (let i = 0; i < lines.length; i++) if (lines[i].t <= position) idx = i;
    return idx;
  }, [lines, synced, position]);

  useEffect(() => {
    const li = activeRef.current;
    const body = bodyRef.current;
    if (!li || !body) return;
    const want = li.offsetTop - body.clientHeight / 2 + li.offsetHeight / 2;
    if (Math.abs(body.scrollTop - want) > 8) {
      body.scrollTo({
        top: want,
        behavior: window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
      });
    }
  }, [activeIndex]);

  if (!lines || lines.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 px-6 py-12 text-center">
        <MicVocal className="size-[26px] text-[var(--color-text-secondary)] opacity-80" />
        <h4 className="m-0 text-sm font-semibold">No lyrics in this file</h4>
        <p className="m-0 max-w-[42ch] text-[13px] leading-relaxed text-[var(--color-text-secondary)]">
          Lyrics show up when the file carries them in its own tags.
        </p>
      </div>
    );
  }

  return (
    // position: relative so offsetTop is measured against this scroller. Without
    // it the auto-scroll computes a page-relative offset and slams to the end.
    <div ref={bodyRef} className="relative h-full overflow-y-auto">
      <ol className="m-0 mx-auto max-w-[44ch] list-none px-5 pb-14 pt-6">
        {lines.map((l, i) => (
          <li
            key={`${l.t}-${i}`}
            ref={i === activeIndex ? activeRef : undefined}
            className={`py-px text-base leading-[1.85] transition-opacity duration-300 ${
              i === activeIndex
                ? 'font-bold text-[var(--color-text)] opacity-100'
                : 'font-medium text-[var(--color-text-secondary)] opacity-[0.88]'
            }`}
          >
            {l.line}
          </li>
        ))}
      </ol>
    </div>
  );
}
