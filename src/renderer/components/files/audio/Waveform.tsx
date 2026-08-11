import { useEffect, useRef, useCallback } from 'react';
import { mmss } from '@dosya-dev/audio-player';

const BAR_W = 3;
const BAR_GAP = 2;
const GROW_MS = 620;

/**
 * Theme tokens are oklch(); canvas fillStyle needs a concrete sRGB triple on
 * every target. Paint the colour onto a 1x1 canvas and read the pixel back -
 * the same trick file-viewer.tsx already uses for the Pintura theme bridge.
 */
function resolveRgb(cssColor: string): [number, number, number] {
  const value = cssColor.trim();
  const ctx = document.createElement('canvas').getContext('2d');
  if (!ctx || !value) return [128, 128, 128];
  const sentinel = '#010203';
  ctx.fillStyle = sentinel;
  ctx.fillStyle = value;
  if (ctx.fillStyle === sentinel && value.toLowerCase() !== sentinel) return [128, 128, 128];
  ctx.fillRect(0, 0, 1, 1);
  const d = ctx.getImageData(0, 0, 1, 1).data;
  return [d[0], d[1], d[2]];
}

function tokenRgba(el: HTMLElement, name: string, alpha: number): string {
  const [r, g, b] = resolveRgb(getComputedStyle(el).getPropertyValue(name));
  return `rgba(${r},${g},${b},${alpha})`;
}

function resample(peaks: Float32Array, n: number): Float32Array {
  const out = new Float32Array(n);
  if (peaks.length === 0) return out;
  const ratio = peaks.length / n;
  for (let i = 0; i < n; i++) {
    const s = Math.floor(i * ratio);
    const e = Math.max(s + 1, Math.floor((i + 1) * ratio));
    let m = 0;
    for (let j = s; j < e && j < peaks.length; j++) if (peaks[j] > m) m = peaks[j];
    out[i] = m;
  }
  return out;
}

interface Props {
  peaks: Float32Array;
  position: number;
  duration: number;
  loop: { a: number; b: number } | null;
  onSeek: (seconds: number) => void;
}

export function Waveform({ peaks, position, duration, loop, onSeek }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const tipRef = useRef<HTMLSpanElement>(null);

  const paint = useCallback((grow: number) => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return;
    const rect = canvas.getBoundingClientRect();
    if (rect.width < 2) return;

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.round(rect.width);
    const h = Math.round(rect.height);
    if (canvas.width !== Math.round(w * dpr)) canvas.width = Math.round(w * dpr);
    if (canvas.height !== Math.round(h * dpr)) canvas.height = Math.round(h * dpr);

    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const step = BAR_W + BAR_GAP;
    const count = Math.max(8, Math.floor(w / step));
    const bars = resample(peaks, count);
    const cy = h / 2;
    const maxH = h / 2 - 1;

    const played = tokenRgba(wrap, '--primary', 1);
    const ahead = tokenRgba(wrap, '--foreground', 0.28);
    const headX = duration > 0 ? (position / duration) * w : 0;

    // The loop region sits behind the bars so it never fights them.
    if (loop && duration > 0) {
      ctx.fillStyle = tokenRgba(wrap, '--primary', 0.1);
      const ax = (loop.a / duration) * w;
      const bx = (loop.b / duration) * w;
      ctx.fillRect(ax, 0, Math.max(1, bx - ax), h);
    }

    for (let i = 0; i < count; i++) {
      const x = i * step;
      let amp = bars[i];
      if (grow < 1) {
        const local = Math.min(1, Math.max(0, (grow - (i / count) * 0.4) / 0.6));
        amp *= 1 - Math.pow(1 - local, 3);
      }
      const bh = Math.max(1, amp * maxH);
      // The bar straddling the playhead is painted in two slices so the
      // boundary lands on the exact position, not on a bar edge.
      if (x < headX && x + BAR_W > headX) {
        ctx.fillStyle = played;
        ctx.fillRect(x, cy - bh, headX - x, bh * 2);
        ctx.fillStyle = ahead;
        ctx.fillRect(headX, cy - bh, x + BAR_W - headX, bh * 2);
      } else {
        ctx.fillStyle = x + BAR_W <= headX ? played : ahead;
        ctx.fillRect(x, cy - bh, BAR_W, bh * 2);
      }
    }

    if (loop && duration > 0) {
      ctx.fillStyle = played;
      ctx.fillRect((loop.a / duration) * w - 1, 0, 2, h);
      ctx.fillRect((loop.b / duration) * w - 1, 0, 2, h);
    }

    if (headX > 0) {
      ctx.fillStyle = tokenRgba(wrap, '--foreground', 1);
      ctx.fillRect(Math.min(w - 2, Math.max(0, headX - 1)), 0, 2, h);
    }
  }, [peaks, position, duration, loop]);

  // The one authored motion on this surface: bars rise into place when the
  // analysis lands, so the user sees that it finished.
  useEffect(() => {
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) { paint(1); return; }
    const start = performance.now();
    let raf = 0;
    const step = (now: number) => {
      const p = Math.min(1, (now - start) / GROW_MS);
      paint(p);
      if (p < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
    // Deliberately keyed on the peaks identity alone: this should replay when
    // a new track's analysis lands, not on every position tick.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [peaks]);

  useEffect(() => { paint(1); }, [position, loop, paint]);

  useEffect(() => {
    const onResize = () => paint(1);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [paint]);

  const secondsAt = (clientX: number) => {
    const canvas = canvasRef.current;
    if (!canvas) return 0;
    const r = canvas.getBoundingClientRect();
    return Math.min(1, Math.max(0, (clientX - r.left) / r.width)) * duration;
  };

  return (
    <div className="mt-[22px]">
      <div
        ref={wrapRef}
        className="relative h-[78px] cursor-pointer touch-none rounded focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-[var(--color-primary)]"
        role="slider"
        tabIndex={0}
        aria-label="Seek"
        aria-valuemin={0}
        aria-valuemax={Math.round(duration)}
        aria-valuenow={Math.round(position)}
        aria-valuetext={`${mmss(position)} of ${mmss(duration)}`}
        onPointerDown={(e) => {
          (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
          onSeek(secondsAt(e.clientX));
        }}
        onPointerMove={(e) => {
          const tip = tipRef.current;
          const canvas = canvasRef.current;
          if (tip && canvas) {
            const r = canvas.getBoundingClientRect();
            tip.style.left = `${Math.min(r.width - 4, Math.max(4, e.clientX - r.left))}px`;
            tip.textContent = mmss(secondsAt(e.clientX));
            tip.style.opacity = '1';
          }
          if (e.buttons === 1) onSeek(secondsAt(e.clientX));
        }}
        onPointerLeave={() => { if (tipRef.current) tipRef.current.style.opacity = '0'; }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowLeft') { onSeek(position - 5); e.preventDefault(); }
          if (e.key === 'ArrowRight') { onSeek(position + 5); e.preventDefault(); }
        }}
      >
        <canvas ref={canvasRef} className="block w-full h-full" />
        <span
          ref={tipRef}
          className="pointer-events-none absolute -top-2 z-10 -translate-x-1/2 -translate-y-full whitespace-nowrap rounded bg-[var(--color-text)] px-[7px] py-[3px] font-mono text-[11px] font-bold text-[var(--color-bg)] opacity-0 transition-opacity"
        />
      </div>
    </div>
  );
}
