// apps/desktop/src/renderer/pages/PersonasPage.test.tsx
//
// Ported from apps/web/src/pages/personas/index.test.tsx - keep the two in step.
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const get = vi.fn();
vi.mock('@/lib/api-client', async (orig) => ({
  ...(await orig<typeof import('@/lib/api-client')>()),
  api: { get: (p: string) => get(p), put: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
  apiBase: () => 'https://api.test',
}));
const wsState = vi.hoisted(() => ({ active: { id: 'ws1', name: 'Family photos' } as { id: string; name: string } }));
vi.mock('@/lib/workspace-context', () => ({
  useWorkspace: () => ({ active: wsState.active, workspaces: [wsState.active], setActive: () => {}, isLoading: false, isError: false, refetch: () => {} }),
}));
vi.mock('@/lib/personas-device/engine-host', () => import('@/lib/personas-device/__fixtures__/fake-host'));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const { fakeHost, card, READY } = await import('@/lib/personas-device/__fixtures__/fake-host');
const { PersonasPage } = await import('./PersonasPage');

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const w = window as unknown as { PointerEvent?: typeof MouseEvent; MouseEvent: typeof MouseEvent };
  if (!w.PointerEvent) w.PointerEvent = w.MouseEvent;
});

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeEach(() => {
  fakeHost.reset();
  fakeHost.engine.personas = [card('p1', 'Emma', { photo_count: 9 }), card('p2', null, { photo_count: 3 })];
  localStorage.clear();
  wsState.active = { id: 'ws1', name: 'Family photos' };
  location = '';
  get.mockReset();
  get.mockResolvedValue({ ok: true });
});
afterEach(() => {
  if (root) act(() => root!.unmount());
  container?.remove();
  root = null; container = null;
  document.body.innerHTML = '';
});

let location = '';
function Where() {
  const here = useLocation();
  location = `${here.pathname}${here.search}`;
  return null;
}

const flush = async () => { await act(async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); }); };

const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
const tree = (path: string) => (
  <QueryClientProvider client={qc}>
    <MemoryRouter initialEntries={[path]}>
      <Where />
      <Routes>
        <Route path="/personas" element={<PersonasPage />} />
        <Route path="/personas/:personaId" element={<PersonasPage />} />
        <Route path="/files" element={<p>files page</p>} />
      </Routes>
    </MemoryRouter>
  </QueryClientProvider>
);

async function mount(path = '/personas') {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={[path]}>
          <Where />
          <Routes>
            <Route path="/personas" element={<PersonasPage />} />
            <Route path="/personas/:personaId" element={<PersonasPage />} />
            <Route path="/files" element={<p>files page</p>} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
  await flush();
}

const text = () => container!.textContent ?? '';
const personasApiCalls = () => get.mock.calls.filter(([p]) => typeof p === 'string' && /personas|\/people/.test(p));

describe('/personas', () => {
  it('shows a spinner until the engine answers, then the grid', async () => {
    fakeHost.set({ status: null });
    await mount();
    expect(container!.querySelector('[role="status"]')).toBeTruthy();
    act(() => fakeHost.set({ status: READY }));
    await flush();
    expect(container!.querySelector('h1')!.textContent).toBe('Personas');
    expect(container!.querySelector('a[href="/personas/p1"]')!.textContent).toContain('Emma');
    expect(text()).toContain('Not named yet');
    expect(container!.querySelector('a[href="/personas/settings"]')!.textContent).toContain('Personas settings');
  });

  it('shows no spinning "More coming" while reading is paused', async () => {
    fakeHost.set({ status: { ...READY, read: 4, total: 10, paused: true } });
    await mount();
    expect(container!.querySelector('[data-testid="personas-more-coming"]')).toBeNull();
    act(() => fakeHost.set({ status: { ...READY, read: 4, total: 10, paused: false } }));
    await flush();
    expect(container!.querySelector('[data-testid="personas-more-coming"]')).toBeTruthy();
  });

  it('is there for every signed-in member: no plan, owner or server check, no redirect', async () => {
    fakeHost.set({ status: { state: 'off' } });
    await mount();
    expect(text()).not.toContain('files page');
    expect(text()).toContain('Find people in your photos');
    expect(personasApiCalls()).toEqual([]);
  });

  it('shows the Vault setup and unlock steps for those states', async () => {
    fakeHost.set({ status: { state: 'needs_identity' } });
    await mount();
    expect(text()).toContain('Personas uses your Vault passphrase to protect your people. Set it up to continue.');
    act(() => fakeHost.set({ status: { state: 'needs_unlock' } }));
    await flush();
    expect(text()).toContain('Unlock with your Vault passphrase to open your people on this device.');
  });

  it('turning on swaps to the grid with the progress card', async () => {
    fakeHost.set({ status: { state: 'off' } });
    await mount();
    await act(async () => { [...container!.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Start reading on this device')!.click(); });
    await flush();
    expect(fakeHost.engine.turnOn).toHaveBeenCalled();
    expect(text()).toContain('Finding your photos');
  });

  it('shows the progress card while photos are left to read, and Pause pauses this device', async () => {
    fakeHost.set({ status: { ...READY, read: 4, total: 10 } });
    await mount();
    expect(text()).toContain('Read 4 of 10 photos on this device');
    await act(async () => { [...container!.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Pause')!.click(); });
    expect(fakeHost.engine.setPaused).toHaveBeenCalledWith(true);
  });

  it('still shows the grid in a browser that cannot read photos', async () => {
    fakeHost.supported = false;
    fakeHost.set({ status: { ...READY, read: 0, total: null } });
    await mount();
    expect(text()).toContain("This device can't read photos. Your other devices can.");
    expect(container!.querySelector('a[href="/personas/p1"]')).toBeTruthy();
  });

  it('says "No people found yet" once everything is read and nobody was found', async () => {
    fakeHost.engine.personas = [];
    await mount();
    expect(text()).toContain('No people found yet');
  });

  it('follows the engine: a new person shows without a reload', async () => {
    await mount();
    fakeHost.engine.personas = [...fakeHost.engine.personas, card('p3', 'Leo')];
    act(() => fakeHost.engine.changed());
    await flush();
    expect(container!.querySelector('a[href="/personas/p3"]')).toBeTruthy();
  });

  it('says so with a retry when the engine cannot answer', async () => {
    fakeHost.set({ status: null, error: new Error('offline') });
    await mount();
    expect(text()).toContain('Personas could not be loaded.');
    await act(async () => { [...container!.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Try again')!.click(); });
    expect(fakeHost.refresh).toHaveBeenCalled();
  });

  it('opens one persona on /personas/:id', async () => {
    fakeHost.engine.photos.set('p1', []);
    await mount('/personas/p1');
    expect(container!.querySelector('h1')!.textContent).toBe('Emma');
  });

  it('a workspace switch on a persona page goes to /personas of the new workspace', async () => {
    fakeHost.engine.photos.set('p1', []);
    await mount('/personas/p1');
    expect(location).toBe('/personas/p1');
    wsState.active = { id: 'ws2', name: 'Work' };
    await act(async () => { root!.render(tree('/personas/p1')); });
    await flush();
    expect(location).toBe('/personas');
  });

  it('a persona page while Personas is off shows the first run', async () => {
    fakeHost.set({ status: { state: 'off' } });
    await mount('/personas/p1');
    expect(text()).toContain('Find people in your photos');
  });
});
