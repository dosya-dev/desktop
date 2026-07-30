// Ported from apps/web/src/lib/use-in-file-find.ts - keep in sync with the web copy.
import { useCallback, useEffect, useRef, useState } from 'react';
import { collectMatchRanges } from '@/lib/find-matches';

// Minimal typing for the CSS Custom Highlight API (not in lib.dom yet everywhere).
interface HighlightRegistry { set(name: string, hl: unknown): void; delete(name: string): void; }
function highlights(): HighlightRegistry | null {
  const c = (globalThis as unknown as { CSS?: { highlights?: HighlightRegistry } }).CSS;
  return c && c.highlights ? c.highlights : null;
}
function makeHighlight(ranges: Range[]): unknown | null {
  const H = (globalThis as unknown as { Highlight?: new (...r: Range[]) => unknown }).Highlight;
  return H ? new H(...ranges) : null;
}

export function useInFileFind<T extends HTMLElement = HTMLElement>(containerRef: React.RefObject<T | null>) {
  const [query, setQueryState] = useState('');
  const [count, setCount] = useState(0);
  const [current, setCurrent] = useState(0); // 1-based; 0 = none
  const rangesRef = useRef<Range[]>([]);

  const paint = useCallback((activeIdx: number) => {
    const reg = highlights();
    if (!reg) return;
    reg.delete('find-match');
    reg.delete('find-current');
    const ranges = rangesRef.current;
    if (!ranges.length) return;
    const all = makeHighlight(ranges);
    if (all) reg.set('find-match', all);
    const active = ranges[activeIdx - 1];
    if (active) {
      const cur = makeHighlight([active]);
      if (cur) reg.set('find-current', cur);
      const rect = active.getBoundingClientRect?.();
      if (rect) active.startContainer.parentElement?.scrollIntoView({ block: 'nearest' });
    }
  }, []);

  const run = useCallback((q: string) => {
    const container = containerRef.current;
    const ranges = container && q ? collectMatchRanges(container, q) : [];
    rangesRef.current = ranges;
    setCount(ranges.length);
    const cur = ranges.length ? 1 : 0;
    setCurrent(cur);
    paint(cur);
  }, [containerRef, paint]);

  const setQuery = useCallback((q: string) => { setQueryState(q); run(q); }, [run]);
  const refresh = useCallback(() => run(query), [run, query]);

  const step = useCallback((delta: number) => {
    setCurrent((prev) => {
      const n = rangesRef.current.length;
      if (!n) return 0;
      let next = prev + delta;
      if (next < 1) next = n;
      if (next > n) next = 1;
      paint(next);
      return next;
    });
  }, [paint]);

  const next = useCallback(() => step(1), [step]);
  const prev = useCallback(() => step(-1), [step]);

  const clear = useCallback(() => {
    setQueryState('');
    rangesRef.current = [];
    setCount(0);
    setCurrent(0);
    const reg = highlights();
    reg?.delete('find-match');
    reg?.delete('find-current');
  }, []);

  // Clear the document-global highlight registry when the hook unmounts
  // (viewer close / file navigation) so highlights never linger on the page.
  useEffect(() => {
    return () => {
      const reg = highlights();
      reg?.delete('find-match');
      reg?.delete('find-current');
    };
  }, []);

  return { query, setQuery, count, current, next, prev, clear, refresh };
}
