// apps/desktop/src/renderer/components/personas/ProgressCard.test.tsx
//
// Ported from apps/web/src/components/personas/progress-card.test.tsx - keep the two in step.
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { EngineStatus } from '@dosya-dev/personas-engine';
import { PersonasProgressCard } from './ProgressCard';
import { progressView } from '@/lib/personas-progress';

beforeAll(() => { (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true; });

type Ready = Extract<EngineStatus, { state: 'ready' }>;
const ready = (over: Partial<Ready> = {}): Ready => ({ state: 'ready', read: 3, total: 10, reading: true, paused: false, ...over });

let root: Root | null = null;
let container: HTMLDivElement | null = null;
afterEach(() => {
  if (root) act(() => root!.unmount());
  container?.remove();
  root = null; container = null;
});

function mount(status: Ready, supported = true, onPause = vi.fn()) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root!.render(<PersonasProgressCard status={status} supported={supported} onPause={onPause} />));
  return onPause;
}

const button = (label: string) => [...container!.querySelectorAll('button')].find((b) => b.textContent?.trim() === label);

describe('progressView', () => {
  it('is hidden once every photo is read, and says so for an unsupported browser', () => {
    expect(progressView(ready({ read: 10, total: 10 }), true)).toBe('hidden');
    expect(progressView(ready({ read: 3, total: 10 }), true)).toBe('reading');
    expect(progressView(ready({ read: 0, total: null }), true)).toBe('finding');
    expect(progressView(ready({ read: 0, total: 0 }), true)).toBe('hidden');
    expect(progressView(ready({ read: 3, total: null }), false)).toBe('unsupported');
  });
});

describe('PersonasProgressCard', () => {
  it('says how many photos this device has read, with a bar and Pause', () => {
    const onPause = mount(ready());
    expect(container!.textContent).toContain('Read 3 of 10 photos on this device');
    const bar = container!.querySelector('[role="progressbar"]')!;
    expect(bar.getAttribute('aria-valuenow')).toBe('3');
    expect(bar.getAttribute('aria-valuemax')).toBe('10');
    act(() => button('Pause')!.click());
    expect(onPause).toHaveBeenCalledWith(true);
  });

  it('offers Resume while paused', () => {
    const onPause = mount(ready({ paused: true }));
    expect(button('Pause')).toBeUndefined();
    act(() => button('Resume')!.click());
    expect(onPause).toHaveBeenCalledWith(false);
  });

  it('is gone when every photo is read', () => {
    mount(ready({ read: 10, total: 10 }));
    expect(container!.textContent).toBe('');
  });

  it('says the photos are being found before the first count', () => {
    mount(ready({ read: 0, total: null }));
    expect(container!.textContent).toContain('Finding your photos');
  });

  it('says this browser cannot read photos, but other devices can', () => {
    mount(ready({ read: 0, total: null }), false);
    expect(container!.textContent).toContain("This device can't read photos. Your other devices can.");
    expect(button('Pause')).toBeUndefined();
  });

  it('never names a server, a region or a plan', () => {
    mount(ready());
    expect(container!.textContent).not.toMatch(/server|region|plan/i);
  });
});
