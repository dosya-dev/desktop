import { useEffect, useRef } from 'react';

interface Handlers {
  toggle(): void;
  seekBy(delta: number): void;
  nextTrack(dir: number): void;
  toggleMute(): void;
}

/**
 * In audio mode the arrows seek. The viewer's own Left/Right file navigation
 * keeps its header buttons but loses its shortcut here, because a listener
 * pressing Right means "skip forward a few seconds", not "open the next
 * file". Shift + arrow moves between tracks.
 *
 * Bound in the capture phase so it wins over the viewer's own handler, and
 * held in a ref so a re-render does not detach and reattach the listener on
 * every position tick.
 */
export function useAudioKeys(handlers: Handlers) {
  const ref = useRef(handlers);
  ref.current = handlers;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      const tag = (t?.tagName || '').toLowerCase();
      if (tag === 'input' || tag === 'textarea' || tag === 'select' || t?.isContentEditable) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;

      const h = ref.current;
      switch (e.key) {
        case ' ':
        case 'k':
        case 'K':
          h.toggle(); e.preventDefault(); e.stopPropagation(); break;
        case 'ArrowLeft':
          if (e.shiftKey) h.nextTrack(-1); else h.seekBy(-5);
          e.preventDefault(); e.stopPropagation(); break;
        case 'ArrowRight':
          if (e.shiftKey) h.nextTrack(1); else h.seekBy(5);
          e.preventDefault(); e.stopPropagation(); break;
        case 'j': case 'J': h.seekBy(-15); break;
        case 'l': case 'L': h.seekBy(15); break;
        case 'm': case 'M': h.toggleMute(); break;
        default: break;
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);
}
