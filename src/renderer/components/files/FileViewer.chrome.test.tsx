import { describe, it, expect, afterEach, beforeAll, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { I18nProvider } from '@/lib/i18n';
import en from '../../../i18n/messages/en.json';

// The versions list goes through the api client; preview-pdf through fetch.
vi.mock('@/lib/api-client', async (orig) => ({
  ...(await orig<typeof import('@/lib/api-client')>()),
  apiBase: () => 'https://api.test',
  api: { get: vi.fn(async () => ({ ok: true, current_version: 4, versions: [] })) },
}));

import { FileViewer, type ViewerFile } from './FileViewer';
import { OfficePreview } from './OfficePreview';

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
  vi.useRealTimers();
});

const docx: ViewerFile = {
  id: 'f1', name: 'Report.docx', size_bytes: 200_000,
  mime_type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  extension: 'docx', region: 'eu', created_at: 1, updated_at: 1, current_version: 4,
  lock_mode: 'none', is_hidden: 0, uploader_name: null, share_count: 1, comment_count: 0,
};

async function mount(el: ReturnType<typeof createElement>) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(createElement(I18nProvider, { initial: 'en', initialMessages: en, children: el }));
  });
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  return container;
}

describe('FileViewer chrome (QA TC-032/033/037)', () => {
  it('has its own close button, outside the window drag region, that closes only the viewer', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 502 })));
    const onClose = vi.fn();
    const c = await mount(createElement(FileViewer, { file: docx, files: [docx], onClose, onNavigate: () => {} }));
    const header = c.querySelector('[data-testid="viewer-header"]')!;
    expect(header.classList.contains('titlebar-inset')).toBe(true);
    const close = c.querySelector<HTMLButtonElement>('[data-testid="viewer-close"]')!;
    expect(close).toBeTruthy();
    expect(close.closest('.titlebar-no-drag')).toBeTruthy();
    await act(async () => { close.click(); await new Promise((r) => setTimeout(r, 250)); });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('Escape closes the viewer', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 502 })));
    const onClose = vi.fn();
    await mount(createElement(FileViewer, { file: docx, files: [docx], onClose, onNavigate: () => {} }));
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
      await new Promise((r) => setTimeout(r, 250));
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('the stylesheet keeps title-bar-covering headers clear of the Windows caption buttons', () => {
    const css = readFileSync(resolve(__dirname, '../../styles/index.css'), 'utf8');
    expect(css).toMatch(/\.titlebar-inset\s*\{[^}]*padding-right:\s*max\(var\(--titlebar-inset-right\)/);
    expect(css).toMatch(/:root\[data-platform="win32"\]\s*\{[^}]*--titlebar-inset-right:/);
  });
});

describe('OfficePreview failure states (QA TC-036)', () => {
  it('offers Download when the conversion fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 502 })));
    const onDownload = vi.fn();
    const c = await mount(createElement(OfficePreview, { file: { id: 'f1', name: 'Report.docx' }, onDownload }));
    expect(c.querySelector('[data-testid="office-failed"]')).toBeTruthy();
    const btn = c.querySelector<HTMLButtonElement>('[data-testid="office-download"]')!;
    expect(btn.textContent).toContain('Download');
    act(() => btn.click());
    expect(onDownload).toHaveBeenCalledTimes(1);
  });

  it('shows no Download while still preparing', async () => {
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => {})));
    const c = await mount(createElement(OfficePreview, { file: { id: 'f1', name: 'Report.docx' }, onDownload: () => {} }));
    expect(c.querySelector('[data-testid="office-preparing"]')).toBeTruthy();
    expect(c.querySelector('[data-testid="office-download"]')).toBeNull();
  });
});
