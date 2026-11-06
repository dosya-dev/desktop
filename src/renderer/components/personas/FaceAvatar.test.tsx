// apps/desktop/src/renderer/components/personas/FaceAvatar.test.tsx
//
// Ported from apps/web/src/components/personas/face-avatar.test.tsx - keep the two in step.
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
vi.mock('@/lib/api-client', async (orig) => ({
  ...(await orig<typeof import('@/lib/api-client')>()),
  apiBase: () => 'https://api.test',
}));

const { FaceAvatar } = await import('./FaceAvatar');

beforeAll(() => { (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true; });

let root: Root | null = null;
let container: HTMLDivElement | null = null;
afterEach(() => {
  if (root) act(() => root!.unmount());
  container?.remove();
  root = null; container = null;
});

function mount(el: React.ReactElement) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root!.render(el));
}

function load(img: HTMLImageElement, w: number, h: number) {
  Object.defineProperty(img, 'naturalWidth', { value: w, configurable: true });
  Object.defineProperty(img, 'naturalHeight', { value: h, configurable: true });
  act(() => { img.dispatchEvent(new Event('load')); });
}

describe('FaceAvatar', () => {
  it('crops the file thumbnail to the face box with CSS (no face image route)', () => {
    mount(<FaceAvatar fileId="file1" box={{ x: 0.25, y: 0.25, w: 0.25, h: 0.5 }} name="Emma" className="size-10" />);
    const img = container!.querySelector('img')!;
    expect(img.getAttribute('src')).toBe('https://api.test/api/files/file1/thumb?w=256');
    expect(img.getAttribute('src')).not.toContain('/personas/');
    expect(img.getAttribute('alt')).toBe('Emma');
    // Hidden until its size is known, so it never flashes uncropped.
    expect(img.style.opacity).toBe('0');
    load(img, 400, 200);
    expect(img.style.opacity).toBe('1');
    expect(img.style.position).toBe('absolute');
    // The face (100 x 100 px) with its margin fills the square; the image keeps its 2:1 aspect.
    const width = parseFloat(img.style.width);
    const height = parseFloat(img.style.height);
    expect(width / height).toBeCloseTo(2);
    expect(width).toBeGreaterThan(100);
  });

  it('reads "Face" without a name and shows a person icon when the thumbnail fails', () => {
    mount(<FaceAvatar fileId="file1" box={{ x: 0, y: 0, w: 1, h: 1 }} name={null} />);
    const img = container!.querySelector('img')!;
    expect(img.getAttribute('alt')).toBe('Face');
    act(() => { img.dispatchEvent(new Event('error')); });
    expect(container!.querySelector('img')).toBeNull();
    expect(container!.querySelector('[role="img"]')!.getAttribute('aria-label')).toBe('Face');
  });
});
