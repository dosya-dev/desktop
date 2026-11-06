// apps/desktop/src/renderer/components/personas/PeopleChips.test.tsx
//
// Ported from apps/web/src/components/personas/people-chips.test.tsx - keep the two in step.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';

vi.mock('@/lib/api-client', async (orig) => ({
  ...(await orig<typeof import('@/lib/api-client')>()),
  apiBase: () => 'https://api.test',
}));
vi.mock('@/lib/personas-device/engine-host', () => import('@/lib/personas-device/__fixtures__/fake-host'));
const { fakeHost, card } = await import('@/lib/personas-device/__fixtures__/fake-host');
const { PeopleChips } = await import('./PeopleChips');

beforeAll(() => { (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true; });

let root: Root | null = null;
let container: HTMLDivElement | null = null;
const BOX = { x: 0.1, y: 0.1, w: 0.2, h: 0.2 };

beforeEach(() => {
  fakeHost.reset();
  fakeHost.engine.personas = [card('p1', 'Emma'), card('p2', null)];
  fakeHost.engine.faces.set('file1', [
    { persona_id: 'p1', name: 'Emma', face_id: 'f1', box: BOX },
    { persona_id: 'p1', name: 'Emma', face_id: 'f1b', box: BOX },
    { persona_id: 'p2', name: null, face_id: 'f2', box: BOX },
    { persona_id: null, name: null, face_id: 'f3', box: BOX },
  ]);
});
afterEach(() => {
  if (root) act(() => root!.unmount());
  container?.remove();
  root = null; container = null;
});

const flush = async () => { await act(async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); }); };

async function mount(fileId = 'file1') {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => { root!.render(<MemoryRouter><PeopleChips wsId="ws1" fileId={fileId} /></MemoryRouter>); });
  await flush();
}

describe('PeopleChips', () => {
  it('shows one chip per person found in the photo on this device, each linking to the persona page', async () => {
    await mount();
    expect(container!.textContent).toContain('In this photo');
    const links = [...container!.querySelectorAll('a')];
    expect(links.map((a) => a.getAttribute('href'))).toEqual(['/personas/p1', '/personas/p2']);
    expect(links[0].textContent).toContain('Emma');
    expect(links[1].textContent).toContain('Unnamed');
    expect(fakeHost.engine.peopleInFile).toHaveBeenCalledWith('file1');
    // The avatar is a crop of this photo's own thumbnail.
    expect(links[0].querySelector('img')!.getAttribute('src')).toMatch(/\/api\/files\/file1\/thumb\?w=256$/);
  });

  it('follows the index: a new name shows without reopening the photo', async () => {
    await mount();
    fakeHost.engine.faces.set('file1', [{ persona_id: 'p1', name: 'Emma Walker', face_id: 'f1', box: BOX }]);
    act(() => fakeHost.engine.changed());
    await flush();
    expect(container!.textContent).toContain('Emma Walker');
  });

  it('shows nothing when nobody is in the photo, while Personas is off or locked, or signed out', async () => {
    await mount('other');
    expect(container!.textContent).toBe('');
    act(() => root!.unmount()); container!.remove(); root = null;

    for (const status of [{ state: 'off' }, { state: 'needs_unlock' }, { state: 'needs_identity' }] as const) {
      fakeHost.reset(status);
      fakeHost.engine.faces.set('file1', [{ persona_id: 'p1', name: 'Emma', face_id: 'f1', box: BOX }]);
      await mount();
      expect(container!.textContent, status.state).toBe('');
      expect(fakeHost.engine.peopleInFile).not.toHaveBeenCalled();
      act(() => root!.unmount()); container!.remove(); root = null;
    }

    fakeHost.set({ engine: null, status: null });
    await mount();
    expect(container!.textContent).toBe('');
  });

  it('never asks a server Personas route', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    await mount();
    expect(fetchSpy.mock.calls.filter(([u]) => /personas|\/people/.test(String(u)))).toEqual([]);
    fetchSpy.mockRestore();
  });
});
