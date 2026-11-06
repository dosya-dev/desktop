// apps/desktop/src/renderer/components/personas/Grid.test.tsx
//
// Ported from apps/web/src/pages/personas/grid.test.tsx - keep the two in step.
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';

vi.mock('@/lib/api-client', async (orig) => ({
  ...(await orig<typeof import('@/lib/api-client')>()),
  apiBase: () => 'https://api.test',
}));

const { PersonasGrid } = await import('./Grid');
const { FakeEngine, card } = await import('@/lib/personas-device/__fixtures__/fake-host');
type Engine = import('@dosya-dev/personas-engine').PersonasEngine;

const PERSONAS = [
  card('p1', 'Emma', { face_count: 30, photo_count: 412 }),
  card('p2', null, { face_count: 41, photo_count: 41 }),
  card('p3', null, { face_count: 3, photo_count: 3 }),
];
let engine: InstanceType<typeof FakeEngine>;

beforeAll(() => { (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true; });

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let onChanged: ReturnType<typeof vi.fn<() => void>>;

beforeEach(() => {
  engine = new FakeEngine();
  engine.personas = PERSONAS.map((p) => ({ ...p }));
  onChanged = vi.fn<() => void>();
});
afterEach(() => {
  if (root) act(() => root!.unmount());
  container?.remove();
  root = null; container = null;
});

const flush = async () => { await act(async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); }); };

async function mount(reading = false) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(<MemoryRouter><PersonasGrid engine={engine as unknown as Engine} personas={PERSONAS} reading={reading} onChanged={onChanged} /></MemoryRouter>);
  });
  await flush();
}

const text = () => container!.textContent ?? '';
const buttons = (label: string) => [...container!.querySelectorAll('button')].filter((b) => b.textContent?.trim() === label);
async function typeInto(el: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
async function press(el: HTMLElement, key: string) {
  await act(async () => { el.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true })); });
  await flush();
}

describe('PersonasGrid', () => {
  it('splits Named and Not named yet, with counts', async () => {
    await mount();
    const named = container!.querySelector('[aria-labelledby="personas-named"]')!;
    const unnamed = container!.querySelector('[aria-labelledby="personas-unnamed"]')!;
    expect(named.querySelector('h2')!.textContent).toBe('Named1');
    expect(unnamed.querySelector('h2')!.textContent).toBe('Not named yet2');
    expect(named.textContent).toContain('Emma');
    expect(named.textContent).toContain('412 photos');
    expect(unnamed.textContent).toContain('41 photos');
    expect(text()).toContain('Add a name to find them in search.');
    expect(text()).toContain('A face needs to appear in at least 3 photos before it shows here.');
  });

  it('links a named persona to its page, with the cover as an image named after it', async () => {
    await mount();
    const link = container!.querySelector<HTMLAnchorElement>('a[href="/personas/p1"]')!;
    expect(link).toBeTruthy();
    const img = link.querySelector('img')!;
    expect(img.getAttribute('alt')).toBe('Emma');
    // The cover is a CSS crop of the cover photo's thumbnail.
    expect(img.getAttribute('src')).toMatch(/\/api\/files\/file-p1\/thumb\?w=256$/);
  });

  it('gives each unnamed group "Add a name", which renames inline', async () => {
    await mount();
    expect(buttons('Add a name')).toHaveLength(2);
    // Unnamed faces are described as "Face".
    expect(container!.querySelector('[aria-labelledby="personas-unnamed"] img')!.getAttribute('alt')).toBe('Face');
    await act(async () => { buttons('Add a name')[0].click(); });
    const input = container!.querySelector<HTMLInputElement>('input[aria-label="Name"]')!;
    expect(input).toBeTruthy();
    await typeInto(input, 'Leo');
    await press(input, 'Enter');
    expect(engine.rename).toHaveBeenCalledWith('p2', 'Leo');
    expect(onChanged).toHaveBeenCalled();
  });

  it('keeps the field open and says why when the name is taken', async () => {
    await mount();
    await act(async () => { buttons('Add a name')[0].click(); });
    const input = container!.querySelector<HTMLInputElement>('input[aria-label="Name"]')!;
    await typeInto(input, 'Emma');
    await press(input, 'Enter');
    expect(text()).toContain('Another persona already has this name.');
    expect(container!.querySelector('input[aria-label="Name"]')).toBeTruthy();
    expect(onChanged).not.toHaveBeenCalled();
  });

  it('Escape leaves the name unchanged', async () => {
    await mount();
    await act(async () => { buttons('Add a name')[0].click(); });
    const input = container!.querySelector<HTMLInputElement>('input[aria-label="Name"]')!;
    await typeInto(input, 'Leo');
    await press(input, 'Escape');
    expect(container!.querySelector('input[aria-label="Name"]')).toBeNull();
    expect(engine.rename).not.toHaveBeenCalled();
  });

  it('closes the not-named section with "More coming" while photos are being read', async () => {
    await mount(true);
    expect(container!.querySelector('[data-testid="personas-more-coming"]')).toBeTruthy();
  });

  it('names no server, workspace-wide face data or policy', async () => {
    await mount();
    expect(text()).not.toMatch(/stays in this workspace|policy|server/i);
  });
});
