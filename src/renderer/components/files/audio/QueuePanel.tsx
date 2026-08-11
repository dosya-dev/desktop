import { Play } from 'lucide-react';
import { stripExt } from '@dosya-dev/audio-player';
import { humanSize } from '@/lib/file-type';
import type { ViewerFile } from '../FileViewer';

interface Props {
  queue: ViewerFile[];
  activeIndex: number;
  playing: boolean;
  /** Folder path for the row subtitle. Empty when the caller has no folder context. */
  folder: string;
  onPick: (index: number) => void;
}

/** The rows only - the player owns the tab header above them. */
export function QueuePanel({ queue, activeIndex, playing, folder, onPick }: Props) {
  return (
    <>
      {queue.map((t, i) => {
          const active = i === activeIndex;
          return (
            <button
              key={t.id}
              data-track
              onClick={() => onPick(i)}
              aria-current={active ? 'true' : undefined}
              className={`group grid w-full grid-cols-[26px_1fr_auto] items-center gap-3.5 border-b border-[var(--color-border)] border-[color-mix(in_oklab,var(--color-border)_55%,transparent)] px-5 py-2 text-left transition-colors ${
                active ? 'bg-[color-mix(in_oklab,var(--color-primary)_10%,transparent)]' : 'hover:bg-[color-mix(in_oklab,var(--color-text)_5%,transparent)]'
              }`}
            >
              <span className="flex h-4 items-center justify-center font-mono text-xs tabular-nums text-[var(--color-text-secondary)]">
                {active ? (
                  // State, not decoration: the bars run while it plays and
                  // hold still when it is paused.
                  <span className="flex h-[13px] items-end gap-[2px]" aria-hidden>
                    <i className={`w-[2.5px] rounded-sm bg-[var(--color-primary)] h-[46%] ${playing ? 'animate-pulse' : ''}`} />
                    <i className={`w-[2.5px] rounded-sm bg-[var(--color-primary)] h-full ${playing ? 'animate-pulse' : ''}`} />
                    <i className={`w-[2.5px] rounded-sm bg-[var(--color-primary)] h-[68%] ${playing ? 'animate-pulse' : ''}`} />
                  </span>
                ) : (
                  <>
                    <span className="group-hover:hidden">{String(i + 1).padStart(2, '0')}</span>
                    <Play className="hidden size-3 fill-current text-[var(--color-text)] group-hover:block" />
                  </>
                )}
              </span>

              <span className="min-w-0">
                <span className={`block truncate text-sm leading-snug ${active ? 'font-bold' : 'font-medium'}`}>
                  {stripExt(t.name)}
                </span>
                {folder && (
                  <span data-subtitle className="block truncate text-xs text-[var(--color-text-secondary)]">
                    {folder}
                  </span>
                )}
              </span>

              {/* Size, not duration: a duration would mean downloading and
                  decoding every file in the folder just to fill a column. */}
              <span className="font-mono text-xs tabular-nums text-[var(--color-text-secondary)]">
                {humanSize(t.size_bytes)}
              </span>
            </button>
          );
      })}
    </>
  );
}
