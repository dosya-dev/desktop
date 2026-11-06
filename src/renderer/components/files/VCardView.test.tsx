import { describe, it, expect, afterEach, beforeAll, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { I18nProvider } from '@/lib/i18n';
import en from '../../../i18n/messages/en.json';
import tr from '../../../i18n/messages/tr.json';
import { VCardView } from './VCardView';

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

let root: Root | null = null;
let container: HTMLDivElement | null = null;
afterEach(() => {
  if (root) act(() => root!.unmount());
  container?.remove();
  root = null;
  container = null;
  vi.unstubAllGlobals();
});

const VCF = [
  'BEGIN:VCARD', 'VERSION:3.0', 'FN:Ada Lovelace',
  'TEL;TYPE=constructor:+44 1',
  'TEL;TYPE=__proto__:+44 2',
  'TEL;TYPE=main:+44 3',
  'EMAIL;TYPE=toString:ada@example.com',
  'END:VCARD',
].join('\r\n');

async function render(locale: 'en' | 'tr') {
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, text: async () => VCF })));
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(createElement(I18nProvider, {
      initial: locale,
      initialMessages: locale === 'tr' ? tr : en,
      children: createElement(VCardView, { file: { id: 'c', name: 'Ada.vcf', mime_type: 'text/vcard' }, rawUrl: 'https://x/raw' }),
    }));
  });
  // Let the fetch chain settle.
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  return container;
}

/** The small type caption above each field value. */
const captions = (c: HTMLElement) =>
  Array.from(c.querySelectorAll('p.capitalize')).map((p) => p.textContent);

describe('VCardView field types', () => {
  it('shows a type named after an Object property as the raw token, without throwing', async () => {
    const c = await render('en');
    expect(c.textContent).toContain('Ada Lovelace');
    expect(captions(c)).toEqual(expect.arrayContaining(['constructor', '__proto__', 'tostring']));
  });

  it('reads the main phone type in the chosen language', async () => {
    const c = await render('tr');
    expect(captions(c)).toContain('Ana');
    // The file's own words stay as written.
    expect(captions(c)).toContain('constructor');
  });
});
