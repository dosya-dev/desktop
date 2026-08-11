import { useEffect, useState } from 'react';
import {
  decodePeaks, getCachedPeaks, putCachedPeaks, MAX_ANALYSE_BYTES,
} from '@dosya-dev/audio-player';

export type PeaksState = 'decoding' | 'ready' | 'unavailable';

/**
 * Peaks for the waveform: cache first, then decode.
 *
 * The decode runs here on the main thread because it has to - the Web Audio
 * API is exposed on Window only, and OfflineAudioContext does not exist in a
 * Worker. decodeAudioData is natively async and does its work off-thread
 * inside the browser, so this does not stall the UI; the only main-thread JS
 * is the peak reduction, one linear pass.
 *
 * Nothing here blocks playback. The transport is live while this runs, and a
 * file too large to analyse renders the plain seek bar instead.
 */
export function usePeaks(rawUrl: string, cacheKey: string, sizeBytes: number) {
  const [peaks, setPeaks] = useState<Float32Array | null>(null);
  const [state, setState] = useState<PeaksState>('decoding');

  useEffect(() => {
    let cancelled = false;
    setPeaks(null);

    if (sizeBytes > MAX_ANALYSE_BYTES) {
      setState('unavailable');
      return;
    }
    setState('decoding');

    (async () => {
      const cached = await getCachedPeaks(cacheKey);
      if (cancelled) return;
      if (cached) { setPeaks(cached); setState('ready'); return; }

      let bytes: ArrayBuffer;
      try {
        const res = await fetch(rawUrl, { credentials: 'include' });
        if (!res.ok) throw new Error(String(res.status));
        bytes = await res.arrayBuffer();
      } catch {
        if (!cancelled) setState('unavailable');
        return;
      }
      if (cancelled) return;

      try {
        const p = await decodePeaks(bytes);
        if (cancelled) return;
        setPeaks(p);
        setState('ready');
        void putCachedPeaks(cacheKey, p);
      } catch {
        // A codec the browser cannot decode, or a truncated file. The seek bar
        // still works; only the drawing is lost.
        if (!cancelled) setState('unavailable');
      }
    })();

    return () => { cancelled = true; };
  }, [rawUrl, cacheKey, sizeBytes]);

  return { peaks, state };
}
