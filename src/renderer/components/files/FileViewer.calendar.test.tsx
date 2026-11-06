// An .ics opens as a calendar, with the text viewer one tab away, and a file
// that holds no events opens as text.
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

const ICS = [
  'BEGIN:VCALENDAR', 'X-WR-CALNAME:Holidays',
  'BEGIN:VEVENT', 'UID:a', 'SUMMARY:New Year', 'DTSTART;VALUE=DATE:20990101', 'RRULE:FREQ=YEARLY;COUNT=3', 'END:VEVENT',
  'END:VCALENDAR',
].join('\r\n');

const base: ViewerFile = {
  id: 'f1', name: 'Holidays.ics', size_bytes: ICS.length, mime_type: 'text/calendar', extension: 'ics', region: 'eu',
  created_at: 1, updated_at: 1, current_version: 1, lock_mode: 'none', is_hidden: 0, uploader_name: null,
  share_count: 0, comment_count: 0,
};

async function mount(file: ViewerFile, body: string) {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(body, { status: 200 })));
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(createElement(I18nProvider, {
      initial: 'en', initialMessages: en,
      children: createElement(FileViewer, { file, files: [file], onClose: () => {}, onNavigate: () => {} }),
    }));
  });
  for (let i = 0; i < 3; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  return container;
}
const tabs = (c: HTMLElement) => [...c.querySelectorAll('[role=tab]')];

describe('FileViewer calendar files', () => {
  it('opens an .ics as an agenda, with the text one tab away', async () => {
    const c = await mount(base, ICS);
    expect(c.textContent).toContain('Holidays');
    expect(c.textContent).toContain('New Year');
    expect(tabs(c).map((b) => b.textContent)).toEqual(['Agenda', 'Month', 'source']);
    await act(async () => { (tabs(c)[2] as HTMLElement).click(); });
    for (let i = 0; i < 2; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    expect(c.textContent).toContain('BEGIN:VEVENT');
  });

  it('shows a calendar file with no events as text', async () => {
    const c = await mount({ ...base, name: 'empty.ics' }, 'BEGIN:VCALENDAR\r\nEND:VCALENDAR');
    expect(tabs(c)).toHaveLength(0);
    expect(c.textContent).toContain('BEGIN:VCALENDAR');
  });
});
