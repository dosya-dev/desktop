// Ported from apps/web/src/components/live-photo-stage.test.tsx - keep in sync
import { describe, it, expect, afterEach, beforeAll, beforeEach, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

vi.mock('./FilePreviewImage', () => ({ FilePreviewImage: () => <img alt="still" /> }));
// Desktop delta from the web test: fileRawUrl() resolves through apiBase(),
// which throws until main.tsx's IPC round trip primes it - mock the module
// the same way the web test mocks '@/api/client' for its API_BASE constant.
vi.mock('@/lib/api-client', () => ({ apiBase: () => 'https://api.example.com' }));

const { LivePhotoStage } = await import('./LivePhotoStage');
import type { ViewerFile } from './FileViewer';

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

const still = { id: 's', name: 'IMG_1.HEIC', live_video_id: 'v' } as unknown as ViewerFile;

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let reduce = false;
afterEach(() => { if (root) act(() => root!.unmount()); container?.remove(); root = null; container = null; });
beforeEach(() => {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: (q: string) => ({ matches: q.includes('reduce') && reduce, addEventListener() {}, removeEventListener() {} }),
  });
  HTMLMediaElement.prototype.play = vi.fn().mockResolvedValue(undefined);
  HTMLMediaElement.prototype.pause = vi.fn();
});
function render(node: React.ReactElement) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => { root!.render(node); });
  return container;
}
const stage = (c: HTMLElement) => c.querySelector('[data-testid="live-stage"]') as HTMLElement;
const video = (c: HTMLElement) => c.querySelector('[data-testid="live-video"]') as HTMLVideoElement;
const badgeButton = (c: HTMLElement) => c.querySelector('button[aria-label="Play Live Photo"]') as HTMLButtonElement;
const badge = (c: HTMLElement) => c.querySelector('[data-testid="live-badge"]') as HTMLElement;

describe('LivePhotoStage', () => {
  it('points the video at the twin, muted, and plays on hover then returns on ended', () => {
    reduce = false;
    const c = render(<LivePhotoStage file={still} twinId="v" />);
    expect(video(c).src).toContain('/api/files/v/raw');
    expect(video(c).muted).toBe(true);
    act(() => { stage(c).dispatchEvent(new MouseEvent('pointerover', { bubbles: true, relatedTarget: document.body } as MouseEventInit)); });
    expect(HTMLMediaElement.prototype.play).toHaveBeenCalled();
    expect(video(c).dataset.playing).toBe('true');
    expect(badge(c).style.color).toBe('var(--brand-foreground)');
    act(() => { video(c).dispatchEvent(new Event('ended')); });
    expect(video(c).dataset.playing).toBe('false');
    expect(badge(c).style.color).toBe('');
  });

  it('pointer leave pauses and rewinds', () => {
    reduce = false;
    const c = render(<LivePhotoStage file={still} twinId="v" />);
    act(() => { stage(c).dispatchEvent(new MouseEvent('pointerover', { bubbles: true, relatedTarget: document.body } as MouseEventInit)); });
    act(() => { stage(c).dispatchEvent(new MouseEvent('pointerout', { bubbles: true, relatedTarget: document.body } as MouseEventInit)); });
    expect(HTMLMediaElement.prototype.pause).toHaveBeenCalled();
    expect(video(c).dataset.playing).toBe('false');
  });

  it('badge click replays, and hover is ignored under reduced motion', () => {
    reduce = true;
    const c = render(<LivePhotoStage file={still} twinId="v" />);
    act(() => { stage(c).dispatchEvent(new MouseEvent('pointerover', { bubbles: true, relatedTarget: document.body } as MouseEventInit)); });
    expect(HTMLMediaElement.prototype.play).not.toHaveBeenCalled();
    act(() => { badgeButton(c).click(); });
    expect(HTMLMediaElement.prototype.play).toHaveBeenCalledTimes(1);
  });

  it('a twin that fails to load leaves the still and disables the badge', () => {
    reduce = false;
    const c = render(<LivePhotoStage file={still} twinId="v" />);
    act(() => { video(c).dispatchEvent(new Event('error')); });
    expect(badgeButton(c).disabled).toBe(true);
    expect(badgeButton(c).title).toBe('Video unavailable');
    expect(c.querySelector('img[alt="still"]')).not.toBeNull();
  });

  it('navigating to a new twin resets broken/playing state instead of leaking it', () => {
    reduce = false;
    const c = render(<LivePhotoStage file={still} twinId="v" />);
    act(() => { video(c).dispatchEvent(new Event('error')); });
    expect(badgeButton(c).disabled).toBe(true);
    act(() => { root!.render(<LivePhotoStage file={still} twinId="v2" />); });
    expect(badgeButton(c).disabled).toBe(false);
    expect(video(c).src).toContain('/api/files/v2/raw');
  });
});
