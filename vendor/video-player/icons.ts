/**
 * Inline SVG glyphs (lucide-style, 24 viewBox, 2 px round strokes; play and
 * pause are filled so they read at small sizes). They replace Video.js's icon
 * font, which this package never loads.
 */
const svg = (body: string, filled = false) =>
  `<svg class="dp-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false" ${
    filled
      ? 'fill="currentColor" stroke="none"'
      : 'fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"'
  }>${body}</svg>`;

export const icons = {
  play: svg('<path d="M7 4.5v15a1 1 0 0 0 1.5.86l12.4-7.5a1 1 0 0 0 0-1.72L8.5 3.64A1 1 0 0 0 7 4.5z"/>', true),
  pause: svg('<rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/>', true),
  volume: svg('<path d="M11 4.7a.7.7 0 0 0-1.2-.5L6.4 7.6A2 2 0 0 1 5 8.2H3a1 1 0 0 0-1 1v5.6a1 1 0 0 0 1 1h2a2 2 0 0 1 1.4.6l3.4 3.4a.7.7 0 0 0 1.2-.5z"/><path d="M16 9a5 5 0 0 1 0 6"/><path d="M19.4 18.4a9 9 0 0 0 0-12.8"/>'),
  muted: svg('<path d="M11 4.7a.7.7 0 0 0-1.2-.5L6.4 7.6A2 2 0 0 1 5 8.2H3a1 1 0 0 0-1 1v5.6a1 1 0 0 0 1 1h2a2 2 0 0 1 1.4.6l3.4 3.4a.7.7 0 0 0 1.2-.5z"/><line x1="22" x2="16" y1="9" y2="15"/><line x1="16" x2="22" y1="9" y2="15"/>'),
  pip: svg('<path d="M21 9V6a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h4"/><rect x="12" y="13" width="10" height="7" rx="2"/>'),
  fullscreen: svg('<path d="M8 3H5a2 2 0 0 0-2 2v3"/><path d="M21 8V5a2 2 0 0 0-2-2h-3"/><path d="M3 16v3a2 2 0 0 0 2 2h3"/><path d="M16 21h3a2 2 0 0 0 2-2v-3"/>'),
  exitFullscreen: svg('<path d="M8 3v3a2 2 0 0 1-2 2H3"/><path d="M21 8h-3a2 2 0 0 1-2-2V3"/><path d="M3 16h3a2 2 0 0 1 2 2v3"/><path d="M16 21v-3a2 2 0 0 1 2-2h3"/>'),
  flag: svg('<path d="M4 22V4"/><path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1"/>'),
  help: svg('<circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><path d="M12 17h.01"/>'),
  close: svg('<path d="M18 6 6 18"/><path d="m6 6 12 12"/>'),
  download: svg('<path d="M12 15V3"/><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/>'),
} as const;

export type IconName = keyof typeof icons;
