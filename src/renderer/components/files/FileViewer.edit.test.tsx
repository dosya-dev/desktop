// The viewer's Edit button: the way from reading a Markdown or text file to
// editing it. Offered only for files the text editor takes, and only when the
// caller passes onEdit (it leaves it out without upload permission).
import { describe, it, expect, afterEach, beforeAll, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { I18nProvider } from '@/lib/i18n';
import en from '../../../i18n/messages/en.json';

vi.mock('@/lib/api-client', async (orig) => ({
  ...(await orig<typeof import('@/lib/api-client')>()),
  apiBase: () => 'https://api.test',
  api: { get: vi.fn(async () => ({ ok: true, current_version: 1, versions: [] })) },
}));

import { FileViewer, type ViewerFile } from './FileViewer';

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

const base: ViewerFile = {
  id: 'f1', name: 'notes.md', size_bytes: 20, mime_type: 'text/markdown', extension: 'md', region: 'eu',
  created_at: 1, updated_at: 1, current_version: 1, lock_mode: 'none', is_hidden: 0, uploader_name: null,
  share_count: 0, comment_count: 0,
};

async function mount(file: ViewerFile, onEdit?: (f: ViewerFile) => void) {
  vi.stubGlobal('fetch', vi.fn(async () => new Response('# hi', { status: 200 })));
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(createElement(I18nProvider, {
      initial: 'en', initialMessages: en,
      children: createElement(FileViewer, { file, files: [file], onClose: () => {}, onNavigate: () => {}, onEdit }),
    }));
  });
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  return container;
}
const edit = () => container!.querySelector<HTMLButtonElement>('[data-testid="viewer-edit"]');

describe('FileViewer Edit button', () => {
  it('opens the editor for Markdown, from outside the drag region', async () => {
    const onEdit = vi.fn();
    await mount(base, onEdit);
    expect(edit()?.textContent).toContain('Edit');
    expect(edit()!.closest('.titlebar-no-drag')).toBeTruthy();
    act(() => edit()!.click());
    expect(onEdit).toHaveBeenCalledWith(base);
  });

  it('is offered for plain text too', async () => {
    await mount({ ...base, name: 'todo.txt', mime_type: 'text/plain', extension: 'txt' }, vi.fn());
    expect(edit()).not.toBeNull();
  });

  it('is not offered without onEdit, for other files, over 2 MB, or when password locked', async () => {
    await mount(base);
    expect(edit()).toBeNull();
    act(() => root!.unmount()); root = null; container!.remove();
    await mount({ ...base, name: 'data.json', extension: 'json' }, vi.fn());
    expect(edit()).toBeNull();
    act(() => root!.unmount()); root = null; container!.remove();
    await mount({ ...base, size_bytes: 3 * 1024 * 1024 }, vi.fn());
    expect(edit()).toBeNull();
    act(() => root!.unmount()); root = null; container!.remove();
    await mount({ ...base, lock_mode: 'full_lock' }, vi.fn());
    expect(edit()).toBeNull();
  });

  it('revalidates the text instead of trusting an hour-old cached copy', async () => {
    await mount(base, vi.fn());
    expect(fetch).toHaveBeenCalledWith(expect.stringContaining('/api/files/f1/raw'), expect.objectContaining({ cache: 'no-cache' }));
  });
});
