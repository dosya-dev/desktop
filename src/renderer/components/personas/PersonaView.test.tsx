// apps/desktop/src/renderer/components/personas/PersonaView.test.tsx
//
// Ported from apps/web/src/pages/personas/persona.test.tsx - keep the two in step.
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { act, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';

vi.mock('@/lib/api-client', async (orig) => ({
  ...(await orig<typeof import('@/lib/api-client')>()),
  apiBase: () => 'https://api.test',
}));
vi.mock('@/lib/personas-device/engine-host', () => import('@/lib/personas-device/__fixtures__/fake-host'));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
// The viewer is heavy and not under test here: a stand-in that names the file.
vi.mock('@/components/files/FileViewer', () => ({
  FileViewer: ({ file }: { file: { name: string } }) => <div data-testid="viewer">{file.name}</div>,
}));

const { fakeHost, card, photoRow } = await import('@/lib/personas-device/__fixtures__/fake-host');
const { PersonaView } = await import('./PersonaView');
type Engine = import('@dosya-dev/personas-engine').PersonasEngine;

// Mid-month UTC noon, so every time zone files them in the same month.
const OCT = Date.UTC(2026, 9, 15, 12) / 1000;
const SEP = Date.UTC(2026, 8, 15, 12) / 1000;
const BOX = { x: 0.2, y: 0.2, w: 0.3, h: 0.3 };

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const w = window as unknown as { PointerEvent?: typeof MouseEvent; MouseEvent: typeof MouseEvent };
  if (!w.PointerEvent) w.PointerEvent = w.MouseEvent;
});

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let location = '';

function Where() {
  const here = useLocation();
  useEffect(() => { location = `${here.pathname}${here.search}`; }, [here]);
  return null;
}

beforeEach(() => {
  fakeHost.reset();
  const e = fakeHost.engine;
  e.personas = [card('p1', 'Emma', { photo_count: 3 }), card('p2', null)];
  e.photos.set('p1', [
    { file_id: 'a', face_id: 'fa', box: BOX },
    { file_id: 'b', face_id: 'fb', box: BOX },
    { file_id: 'c', face_id: 'fc', box: BOX },
  ]);
  fakeHost.rows = new Map([
    ['a', photoRow('a', { name: 'IMG_a.jpg', taken_at: OCT, folder_id: 'd1' })],
    ['b', photoRow('b', { name: 'IMG_b.jpg', taken_at: OCT - 60 })],
    ['c', photoRow('c', { name: 'IMG_c.jpg', taken_at: SEP })],
  ]);
});
afterEach(() => {
  if (root) act(() => root!.unmount());
  container?.remove();
  root = null; container = null;
  document.body.innerHTML = '';
});

const flush = async () => { await act(async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); }); };

async function mount(pid = 'p1') {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <MemoryRouter initialEntries={[`/personas/${pid}`]}>
        <Where />
        <Routes>
          <Route path="/personas/:personaId" element={<PersonaView wsId="ws1" personaId={pid} engine={fakeHost.engine as unknown as Engine} />} />
          <Route path="*" element={null} />
        </Routes>
      </MemoryRouter>,
    );
  });
  await flush();
}

const text = () => document.body.textContent ?? '';
const byText = (label: string, sel = 'button') => [...document.querySelectorAll<HTMLElement>(sel)].find((b) => b.textContent?.trim() === label);
const click = async (el: Element | null | undefined) => { expect(el).toBeTruthy(); await act(async () => { (el as HTMLElement).click(); }); await flush(); };

const escape = async () => { await act(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); }); await flush(); };

describe('PersonaView', () => {
  it('shows the name, rename, Change cover, Merge with…, Remove person and the photos by month', async () => {
    await mount();
    expect(container!.querySelector('h1')!.textContent).toBe('Emma');
    expect(container!.querySelector('[aria-label="Rename Emma"]')).toBeTruthy();
    expect(text()).toContain('3 photos');
    expect(byText('Change cover')).toBeTruthy();
    expect(byText('Merge with…')).toBeTruthy();
    expect(byText('Remove person')).toBeTruthy();
    const months = [...container!.querySelectorAll('section h2')].map((h) => h.textContent);
    expect(months).toEqual(['October 2026 · 2', 'September 2026 · 1']);
    expect(container!.querySelector('a[href="/personas"]')!.textContent).toContain('Personas');
    expect(fakeHost.engine.personaPhotos).toHaveBeenCalledWith('p1', null, 60);
  });

  it('leaves out a photo that is not in the listing any more (trashed, hidden or locked)', async () => {
    fakeHost.rows.delete('b');
    await mount();
    expect(container!.querySelector('[aria-label="IMG_a.jpg"]')).toBeTruthy();
    expect(container!.querySelector('[aria-label="IMG_b.jpg"]')).toBeNull();
  });

  it('links to Personas settings for every member', async () => {
    await mount();
    const link = container!.querySelector<HTMLAnchorElement>('a[href="/personas/settings"]')!;
    expect(link.textContent).toContain('Personas settings');
    await click(link);
    expect(location).toBe('/personas/settings');
  });

  it('the photo menu offers Not Emma, Set as cover and Show in folder', async () => {
    await mount();
    await click(container!.querySelectorAll('[aria-label="Photo options"]')[0]);
    const items = [...document.querySelectorAll('[role="menuitem"]')].map((i) => i.textContent?.trim());
    expect(items).toEqual(['Not Emma', 'Set as cover', 'Show in folder']);
  });

  it('Not Emma takes that face out of the persona and drops the photo', async () => {
    await mount();
    await click(container!.querySelectorAll('[aria-label="Photo options"]')[0]);
    await click(byText('Not Emma', '[role="menuitem"]'));
    expect(fakeHost.engine.notThisPerson).toHaveBeenCalledWith('fa');
    expect(container!.querySelector('[aria-label="IMG_a.jpg"]')).toBeNull();
    expect(container!.querySelector('[aria-label="IMG_b.jpg"]')).toBeTruthy();
    expect(container!.querySelectorAll('[aria-label="Photo options"]')).toHaveLength(2);
  });

  it('Set as cover sets this photo\'s face as the cover, from the menu or by picking with Change cover', async () => {
    await mount();
    await click(container!.querySelectorAll('[aria-label="Photo options"]')[0]);
    await click(byText('Set as cover', '[role="menuitem"]'));
    expect(fakeHost.engine.setCover).toHaveBeenCalledWith('p1', 'fa');
    await click(byText('Change cover'));
    await click(container!.querySelector('[aria-label="Use IMG_b.jpg as the cover"]'));
    expect(fakeHost.engine.setCover).toHaveBeenLastCalledWith('p1', 'fb');
  });

  it('Show in folder opens the file in Files', async () => {
    await mount();
    await click(container!.querySelectorAll('[aria-label="Photo options"]')[0]);
    await click(byText('Show in folder', '[role="menuitem"]'));
    // The desktop deep link: the photo's folder with its detail panel open.
    expect(location).toBe('/files?folder=d1&panel=a');
  });

  it('Remove person asks "Are you sure?" naming the person, then removes on every device and goes back', async () => {
    await mount();
    await click(byText('Remove person'));
    const dialog = document.querySelector('[role="dialog"]')!;
    expect(dialog.textContent).toContain('Are you sure?');
    expect(dialog.textContent).toContain('You are removing Emma. Their face data is deleted from all your devices.');
    expect(dialog.querySelector('strong')!.textContent).toBe('Emma');
    expect(fakeHost.engine.removePersona).not.toHaveBeenCalled();
    await click([...dialog.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Remove person'));
    expect(fakeHost.engine.removePersona).toHaveBeenCalledWith('p1');
    expect(location).toBe('/personas');
  });

  it('renames from the header', async () => {
    await mount();
    await click(container!.querySelector('[aria-label="Rename Emma"]'));
    const input = container!.querySelector<HTMLInputElement>('input[aria-label="Name"]')!;
    expect(input.value).toBe('Emma');
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'Emma Stone');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => { input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); });
    await flush();
    expect(fakeHost.engine.rename).toHaveBeenCalledWith('p1', 'Emma Stone');
    expect(container!.querySelector('h1')!.textContent).toBe('Emma Stone');
  });

  it('merges with another person from Merge with…', async () => {
    await mount();
    await click(byText('Merge with…'));
    const dialog = document.querySelector('[role="dialog"]')!;
    await click(dialog.querySelector('input[type="radio"]'));
    await click([...dialog.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Merge into Emma'));
    expect(fakeHost.engine.merge).toHaveBeenCalledWith('p1', 'p2');
  });

  it('an unnamed persona offers "Add a name", "Not this person" and a statement without a name', async () => {
    fakeHost.engine.personas = [card('p1', null, { photo_count: 3 })];
    await mount();
    expect(container!.querySelector('h1')!.textContent).toBe('Unnamed');
    expect(container!.querySelector('[aria-label="Add a name"]')).toBeTruthy();
    await click(byText('Remove person'));
    expect(document.querySelector('[role="dialog"]')!.textContent).toContain('You are removing this person. Their face data is deleted from all your devices.');
    await click(byText('Cancel'));
    await click(container!.querySelectorAll('[aria-label="Photo options"]')[0]);
    expect(byText('Not this person', '[role="menuitem"]')).toBeTruthy();
  });

  it('opens a photo in the viewer', async () => {
    await mount();
    await click(container!.querySelector('[aria-label="IMG_a.jpg"]'));
    expect(container!.querySelector('[data-testid="viewer"]')!.textContent).toBe('IMG_a.jpg');
  });

  it('pages with Load more', async () => {
    const many = Array.from({ length: 70 }, (_, i) => ({ file_id: `m${i}`, face_id: `fm${i}`, box: BOX }));
    fakeHost.engine.photos.set('p1', many);
    fakeHost.rows = new Map(many.map((m) => [m.file_id, photoRow(m.file_id, { taken_at: OCT })]));
    await mount();
    expect(container!.querySelectorAll('[aria-label="Photo options"]')).toHaveLength(60);
    await click(byText('Load more'));
    expect(container!.querySelectorAll('[aria-label="Photo options"]')).toHaveLength(70);
    expect(byText('Load more')).toBeUndefined();
  });

  it('says so when the persona is gone', async () => {
    await mount('nobody');
    expect(text()).toContain('This persona is no longer here.');
  });
});

// The desktop dialogs and menu: Escape and focus as the other desktop dialogs.
describe('PersonaView, desktop dialogs', () => {
  it('the photo menu has no overflow-hidden ancestor, and Escape closes it', async () => {
    await mount();
    const opener = container!.querySelectorAll<HTMLElement>('[aria-label="Photo options"]')[0];
    await click(opener);
    const menu = document.querySelector<HTMLElement>('[role="menu"]')!;
    const clipping: string[] = [];
    for (let el = menu.parentElement; el; el = el.parentElement) {
      if (el.classList.contains('overflow-hidden')) clipping.push(el.tagName.toLowerCase());
    }
    expect(clipping).toEqual([]);
    expect(opener.getAttribute('aria-expanded')).toBe('true');
    await escape();
    expect(opener.getAttribute('aria-expanded')).toBe('false');
  });

  it('Escape closes the Remove person dialog without removing; Cancel takes focus and gives it back', async () => {
    await mount();
    const opener = byText('Remove person')!;
    opener.focus();
    await click(opener);
    const dialog = document.querySelector('[role="dialog"]')!;
    const cancel = [...dialog.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Cancel')!;
    expect(document.activeElement).toBe(cancel);
    await escape();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(fakeHost.engine.removePersona).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(opener);
  });

  it('never asks a server Personas route', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    await mount();
    await click(container!.querySelectorAll('[aria-label="Photo options"]')[0]);
    await click(byText('Not Emma', '[role="menuitem"]'));
    expect(fetchSpy.mock.calls.filter(([u]) => /personas|\/people/.test(String(u)))).toEqual([]);
    fetchSpy.mockRestore();
  });
});
