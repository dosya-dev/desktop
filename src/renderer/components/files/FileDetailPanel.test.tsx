import { describe, it, expect, afterEach, beforeAll, beforeEach, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

// fileRawUrl() resolves through api-client, which throws until main.tsx's IPC
// round trip primes it - mock the module (see VideoPlayer.test.tsx).
vi.mock('@/lib/api-client', () => ({
  apiBase: () => 'https://api.example.com',
  api: vi.fn(),
  apiRequest: vi.fn(),
  ApiError: class ApiError extends Error {},
}));

const { FilePreview } = await import('./FileDetailPanel');
import type { ViewerFile } from './FileViewer';

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

let root: Root | null = null;
let container: HTMLDivElement | null = null;
afterEach(() => { if (root) act(() => root!.unmount()); container?.remove(); root = null; container = null; });
beforeEach(() => {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    configurable: true,
    value: (q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }),
  });
  HTMLMediaElement.prototype.play = vi.fn().mockResolvedValue(undefined);
  HTMLMediaElement.prototype.pause = vi.fn();
  HTMLMediaElement.prototype.load = vi.fn();
  HTMLMediaElement.prototype.canPlayType = () => 'maybe';
});

const file = { id: 'f1', name: 'Clip.mp4' } as unknown as ViewerFile;

function render() {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => { root!.render(<FilePreview file={file} utSuffix="?ut=tok" />); });
  return container;
}

describe('FilePreview video', () => {
  it('renders the compact dosya player, not native controls', () => {
    const c = render();
    const player = c.querySelector('.dp.dp-compact');
    expect(player).not.toBeNull();
    expect(c.querySelector('video[controls]')).toBeNull();
    const v = player!.querySelector('video')!;
    expect(v.getAttribute('src')).toBe('https://api.example.com/api/files/f1/raw?ut=tok');
    expect(v.getAttribute('preload')).toBe('metadata');
    expect(player!.querySelector('.dp-report-btn, .dp-keys-btn')).toBeNull();
  });

  it('leaves Space to the file list while focus is outside the player', () => {
    render();
    const e = new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true });
    document.body.dispatchEvent(e);
    expect(e.defaultPrevented).toBe(false);
  });

  it('a playback failure swaps in the panel icon fallback', () => {
    const c = render();
    act(() => { c.querySelector('video')!.dispatchEvent(new Event('error')); });
    expect(c.querySelector('.dp')).toBeNull();
    expect(c.querySelector('img[alt="MP4"]')).not.toBeNull();
  });
});
