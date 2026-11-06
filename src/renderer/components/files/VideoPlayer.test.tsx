import { describe, it, expect, afterEach, beforeAll, beforeEach, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

// fileRawUrl() and the report call resolve through api-client, which throws
// until main.tsx's IPC round trip primes it - mock the module (see
// LivePhotoStage.test.tsx).
vi.mock('@/lib/api-client', () => ({
  apiBase: () => 'https://api.example.com',
  apiRequest: vi.fn(),
  ApiError: class ApiError extends Error {},
}));

const { VideoPlayer } = await import('./VideoPlayer');
const { I18nProvider, useLocale } = await import('@/lib/i18n');
import type { ViewerFile } from './FileViewer';

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

const file = { id: 'f1', name: 'Clip.mp4' } as unknown as ViewerFile;
const RAW = 'https://api.example.com/api/files/f1/raw';

let root: Root | null = null;
let container: HTMLDivElement | null = null;
afterEach(() => { if (root) act(() => root!.unmount()); container?.remove(); root = null; container = null; });
beforeEach(() => {
  vi.useFakeTimers();
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
afterEach(() => { vi.useRealTimers(); });

function render(node: React.ReactElement) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => { root!.render(node); });
  return container;
}

describe('VideoPlayer', () => {
  it('renders the Video.js player', () => {
    const c = render(<VideoPlayer file={file} rawUrl={RAW} onDownload={() => {}} />);
    expect(c.querySelector('.video-js')).not.toBeNull();
    expect(c.querySelector('video')!.getAttribute('src')).toBe(RAW);
  });

  it('keeps the video node when re-rendered with the same file and version', () => {
    const c = render(<VideoPlayer file={file} rawUrl={RAW} version={2} onDownload={() => {}} />);
    const before = c.querySelector('video');
    act(() => { root!.render(<VideoPlayer file={{ ...file }} rawUrl={`${RAW}?t=2`} version={2} onDownload={() => {}} />); });
    expect(c.querySelector('video')).toBe(before);
  });

  it('a decode failure offers Download, which calls onDownload', () => {
    const onDownload = vi.fn();
    const c = render(<VideoPlayer file={file} rawUrl={RAW} onDownload={onDownload} />);
    act(() => { c.querySelector('video')!.dispatchEvent(new Event('error')); });
    expect(c.querySelector('.dp-stage-failure')!.textContent).toContain("This app can't decode this video");
    expect(c.querySelector('a.dp-download')).toBeNull();
    act(() => { c.querySelector<HTMLButtonElement>('button.dp-download')!.click(); });
    expect(onDownload).toHaveBeenCalledTimes(1);
  });

  it('the failure card follows a language switch made while it is showing', async () => {
    (window as unknown as { electronAPI: unknown }).electronAPI = { setLocale: vi.fn().mockResolvedValue(undefined) };
    let picker: ReturnType<typeof useLocale> | null = null;
    function Picker() { picker = useLocale(); return null; }
    const c = render(
      <I18nProvider initial="en">
        <Picker />
        <VideoPlayer file={file} rawUrl={RAW} onDownload={() => {}} />
      </I18nProvider>,
    );
    act(() => { c.querySelector('video')!.dispatchEvent(new Event('error')); });
    expect(c.querySelector('.dp-stage-failure')!.textContent).toContain("This app can't decode this video");
    const video = c.querySelector('video');

    await act(async () => { await picker!.setLocale('tr'); });
    expect(c.querySelector('.dp-stage-failure')!.textContent).toContain('Bu video uygulamada çözümlenemiyor');
    // Same player: the switch did not remount (and so did not reload) it.
    expect(c.querySelector('video')).toBe(video);

    await act(async () => { await picker!.setLocale('en'); });
    expect(c.querySelector('.dp-stage-failure')!.textContent).toContain("This app can't decode this video");
  });
});
