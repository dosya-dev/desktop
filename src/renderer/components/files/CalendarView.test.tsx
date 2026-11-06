// Ported from apps/web/src/components/calendar-viewer.test.tsx - keep in sync with the web copy.
import { describe, it, expect, afterEach, beforeAll, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { parseIcal } from '@dosya-dev/shared/files/ical';
import { I18nProvider, t } from '@/lib/i18n';
import { describeRule } from '@/lib/calendar-read';
import { isCalendar } from '@/lib/file-type';
import en from '../../../i18n/messages/en.json';
import de from '../../../i18n/messages/de.json';
import { CalendarView } from './CalendarView';

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

let root: Root | null = null;
let container: HTMLDivElement | null = null;
const unmount = () => {
  if (root) act(() => root!.unmount());
  container?.remove();
  root = null;
  container = null;
};
afterEach(() => { unmount(); vi.unstubAllGlobals(); });

const ics = (...lines: string[]) => ['BEGIN:VCALENDAR', 'X-WR-CALNAME:Personal', ...lines, 'END:VCALENDAR'].join('\r\n');

// Dates far ahead, so "today" never passes them and the agenda opens on them.
const CALENDAR = ics(
  'BEGIN:VEVENT', 'UID:a', 'SUMMARY:Team standup', 'DTSTART:20990105T090000Z', 'DTEND:20990105T093000Z',
  'RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;COUNT=10', 'LOCATION:Room 4',
  'ORGANIZER;CN=Priya Shah:mailto:priya@example.com',
  'ATTENDEE;PARTSTAT=ACCEPTED;CN=Alex Morgan:mailto:alex@example.com',
  'DESCRIPTION:Join https://meet.google.com/abc-defg-hij',
  'BEGIN:VALARM', 'TRIGGER:-PT10M', 'END:VALARM',
  'END:VEVENT',
  'BEGIN:VEVENT', 'UID:b', 'SUMMARY:Dentist', 'DTSTART;VALUE=DATE:20990107', 'DTEND;VALUE=DATE:20990108', 'END:VEVENT',
);

const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });

async function show(body: string, name = 'Personal.ics', size = 2000, locale: 'en' | 'de' = 'en') {
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, text: async () => body })));
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(createElement(I18nProvider, {
      initial: locale,
      initialMessages: locale === 'de' ? de : en,
      children: createElement(CalendarView, {
        file: { name, size_bytes: size },
        rawUrl: `https://x/${name}`,
        source: createElement('div', { 'data-testid': 'source' }, 'SOURCE'),
        oversize: createElement('div', null, 'OVERSIZE'),
      }),
    }));
  });
  await flush();
  await flush();
  return container;
}

const click = async (el: Element | null | undefined) => {
  expect(el).toBeTruthy();
  await act(async () => { (el as HTMLElement).click(); });
};
const buttonWith = (root: HTMLElement, text: string) => [...root.querySelectorAll('button')].find((b) => b.textContent?.includes(text));

describe('CalendarView', () => {
  it('lists events as an agenda with the calendar name and count', async () => {
    const root = await show(CALENDAR);
    expect(root.textContent).toContain('Personal');
    expect(root.textContent).toContain('2 events');
    expect(root.textContent).toContain('Team standup');
    expect(root.textContent).toContain('Dentist');
    expect(root.textContent).toContain('All day');
    // Ten weekday standups plus the dentist.
    expect(root.querySelectorAll('button[aria-pressed]').length).toBe(11);
  });

  it('opens an event with its repeat, guests, reminder and call link', async () => {
    const root = await show(CALENDAR);
    await click(buttonWith(root, 'Team standup'));
    const text = root.textContent ?? '';
    expect(text).toContain('Every weekday, 10 times');
    expect(text).toContain('Priya Shah');
    expect(text).toContain('Organizer');
    expect(text).toContain('Going');
    expect(text).toContain('Reminder 10 minutes before');
    // A new window, which the main process hands to the system browser.
    const call = root.querySelector<HTMLAnchorElement>('a[href="https://meet.google.com/abc-defg-hij"]');
    expect(call?.textContent).toBe('Join call');
    expect(call?.target).toBe('_blank');
    expect(root.querySelector<HTMLAnchorElement>('a[href^="https://calendar.google.com/"]')?.target).toBe('_blank');
  });

  it('saves one event as its own .ics', async () => {
    const root = await show(CALENDAR);
    await click(buttonWith(root, 'Dentist'));
    const saved: { name: string; href: string }[] = [];
    const anchorClick = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      saved.push({ name: this.download, href: this.href });
    });
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: vi.fn(() => 'blob:x'), revokeObjectURL: vi.fn() }));
    await click(buttonWith(root, 'Download event'));
    anchorClick.mockRestore();
    expect(saved).toEqual([{ name: 'Dentist.ics', href: 'blob:x' }]);
  });

  it('filters by search and switches to the month grid and the source', async () => {
    const root = await show(CALENDAR);
    const input = root.querySelector<HTMLInputElement>('input[type=search]')!;
    await act(async () => {
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      set.call(input, 'dent');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 200));
    });
    expect(root.textContent).toContain('Dentist');
    expect(root.textContent).not.toContain('Team standup');

    await click([...root.querySelectorAll('[role=tab]')].find((b) => b.textContent === 'Month'));
    expect(root.querySelectorAll('.grid-cols-7').length).toBeGreaterThan(0);

    await click([...root.querySelectorAll('[role=tab]')].find((b) => b.textContent === 'source'));
    expect(root.querySelector('[data-testid=source]')).toBeTruthy();
  });

  it('shows a file with one event as a card', async () => {
    const root = await show(ics('BEGIN:VEVENT', 'UID:x', 'SUMMARY:Flight QF 512', 'DTSTART:20990301T204000Z', 'DTEND:20990301T221500Z', 'END:VEVENT'), 'invite.ics');
    expect(root.textContent).toContain('Flight QF 512');
    expect(root.textContent).toContain('Add to Google Calendar');
    expect([...root.querySelectorAll('[role=tab]')].map((b) => b.textContent)).toEqual(['Details', 'source']);
  });

  it('falls back to the source for a file with no events, and to the oversize card for a huge one', async () => {
    let root = await show('just some text', 'notes.ics');
    expect(root.querySelector('[data-testid=source]')).toBeTruthy();
    unmount();
    root = await show(CALENDAR, 'big.ics', 50 * 1024 * 1024);
    expect(root.textContent).toContain('OVERSIZE');
  });

  it('speaks the chosen language', async () => {
    const root = await show(CALENDAR, 'Personal.ics', 2000, 'de');
    expect(root.textContent).toContain('2 Termine');
    expect(root.textContent).toContain('Ganztägig');
    expect(root.textContent).not.toContain('All day');
  });
});

describe('describeRule', () => {
  // `t` reads the last language a provider switched to; the German test above leaves German.
  beforeAll(async () => {
    container = document.createElement('div');
    root = createRoot(container);
    await act(async () => { root!.render(createElement(I18nProvider, { initial: 'en', initialMessages: en, children: null })); });
    unmount();
  });
  const rule = (rrule: string) => {
    const cal = parseIcal(ics('BEGIN:VEVENT', 'UID:x', 'SUMMARY:x', 'DTSTART:20261102T090000Z', `RRULE:${rrule}`, 'END:VEVENT'));
    const ev = cal.events[0];
    return describeRule(ev.rule!, ev.start, t);
  };
  it('says common repeats in words', () => {
    expect(rule('FREQ=DAILY;INTERVAL=2')).toBe('Every 2 days');
    expect(rule('FREQ=WEEKLY;BYDAY=MO,TH')).toBe('Every week on Monday and Thursday');
    expect(rule('FREQ=MONTHLY;BYDAY=2TU')).toBe('Every month on the second Tuesday');
    expect(rule('FREQ=MONTHLY;BYDAY=-1FR')).toBe('Every month on the last Friday');
    expect(rule('FREQ=MONTHLY;BYMONTHDAY=-1')).toBe('Every month on the last day');
    expect(rule('FREQ=YEARLY')).toBe('Every year on November 2');
    expect(rule('FREQ=HOURLY')).toBe('Repeats');
    expect(rule('FREQ=DAILY;UNTIL=20261218T235959Z')).toBe('Every day, until December 18, 2026');
  });
});

describe('isCalendar', () => {
  it('claims the iCalendar extensions, and the mime only for a name without one', () => {
    expect(['a.ics', 'B.ICS', 'c.ical', 'd.icalendar'].every((n) => isCalendar(n))).toBe(true);
    expect(isCalendar('invite', 'text/calendar; charset=utf-8')).toBe(true);
    expect(isCalendar('notes.txt', 'text/calendar')).toBe(false);
    expect(isCalendar('photo.png', 'text/calendar')).toBe(false);
    expect(isCalendar('cal.vcs')).toBe(false);
  });
});
