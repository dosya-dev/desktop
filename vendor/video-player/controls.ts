import videojs from 'video.js/core.es.js';
import { icons } from './icons';
import type { VideoPlayerLabels } from './labels';

export type VjsPlayer = ReturnType<typeof videojs>;

/** The full control bar, left to right. */
const FULL_BAR = [
  'progressControl',
  'playToggle',
  'volumePanel',
  'currentTimeDisplay',
  'timeDivider',
  'durationDisplay',
  'customControlSpacer',
  'playbackRateMenuButton',
  'pictureInPictureToggle',
  'fullscreenToggle',
];

/**
 * The compact bar (a ~300 px detail panel): no volume panel and no mute
 * toggle, since the row must hold play, time, speed, PiP and fullscreen in
 * about 270 px. The host adds no flag or "?" to it either.
 */
const COMPACT_BAR = FULL_BAR.filter((c) => c !== 'volumePanel');

/** Video.js's English control text, keyed to the host's words for it. */
function videojsDictionary(l: VideoPlayerLabels): Record<string, string> {
  return {
    Play: l.play,
    Pause: l.pause,
    Mute: l.shortcutMute,
    Fullscreen: l.shortcutFullscreen,
    'Progress Bar': l.progressBar,
    'Current Time': l.currentTime,
    Duration: l.duration,
    'Remaining Time': l.remainingTime,
    'Playback Rate': l.playbackRate,
    'Picture-in-Picture': l.pictureInPicture,
    'Exit Fullscreen': l.exitFullscreen,
  };
}

/** The Video.js option object. Values are fixed by the plan; do not tune per host. */
export function videojsOptions(autoplay: boolean, preload: 'auto' | 'metadata' = 'auto', compact = false, labels?: VideoPlayerLabels) {
  return {
    // Video.js writes the control text ("Play", "Mute", "Fullscreen") through its
    // own dictionary. A host that passed labels gets one for the words we have;
    // the rest stays Video.js's English.
    ...(labels ? { language: 'dp', languages: { dp: videojsDictionary(labels) } } : {}),
    controls: true,
    autoplay,
    preload,
    playbackRates: [0.5, 0.75, 1, 1.25, 1.5, 2],
    inactivityTimeout: 2500,
    userActions: { hotkeys: false, doubleClick: false },
    bigPlayButton: false,
    loadingSpinner: false,
    errorDisplay: false,
    // Our own CSS tooltips read `.vjs-control-text`; native titles would double them.
    noUITitleAttributes: true,
    // A volumePanel option adds the panel even when `children` leaves it out,
    // so the compact bar passes `false` instead.
    controlBar: compact
      ? { children: COMPACT_BAR, volumePanel: false }
      : { children: FULL_BAR, volumePanel: { inline: true } },
  };
}

/** Puts our SVG glyphs next to each button's (hidden) icon-font placeholder. */
export function injectIcons(bar: HTMLElement): void {
  const put = (selector: string, html: string) => {
    const btn = bar.querySelector<HTMLElement>(selector);
    if (!btn || btn.querySelector('.dp-glyph')) return;
    const glyph = document.createElement('span');
    glyph.className = 'dp-glyph';
    glyph.setAttribute('aria-hidden', 'true');
    glyph.innerHTML = html;
    btn.prepend(glyph);
  };
  put('.vjs-play-control', `<span class="dp-g-play">${icons.play}</span><span class="dp-g-pause">${icons.pause}</span>`);
  put('.vjs-mute-control', `<span class="dp-g-vol">${icons.volume}</span><span class="dp-g-muted">${icons.muted}</span>`);
  put('.vjs-picture-in-picture-control', icons.pip);
  put('.vjs-fullscreen-control', `<span class="dp-g-fs">${icons.fullscreen}</span><span class="dp-g-exit">${icons.exitFullscreen}</span>`);
}

interface ButtonLike {
  el(): HTMLElement;
  controlText(text: string): void;
  dispose(): void;
}
type ButtonCtor = new (player: VjsPlayer, options?: Record<string, unknown>) => ButtonLike;

const REPORT_BUTTON = 'DosyaReportButton';

/**
 * The control-bar slot for the report flag. The popover itself is mounted by
 * the report module; this button only reports clicks through `onPress`.
 */
function reportButtonClass(): string {
  if (videojs.getComponent(REPORT_BUTTON)) return REPORT_BUTTON;
  const Button = videojs.getComponent('Button') as unknown as ButtonCtor;
  class DosyaReportButton extends Button {
    private readonly onPress: () => void;
    constructor(player: VjsPlayer, options: Record<string, unknown> = {}) {
      super(player, options);
      this.onPress = (options.onPress as () => void) ?? (() => {});
      this.controlText((options.text as string | undefined) ?? 'Report');
      const glyph = document.createElement('span');
      glyph.className = 'dp-glyph';
      glyph.setAttribute('aria-hidden', 'true');
      glyph.innerHTML = icons.flag;
      this.el().prepend(glyph);
    }
    buildCSSClass(): string {
      return `dp-report-btn vjs-control vjs-button`;
    }
    handleClick(): void {
      this.onPress();
    }
  }
  videojs.registerComponent(REPORT_BUTTON, DosyaReportButton as never);
  return REPORT_BUTTON;
}

/** Adds the report button just before picture-in-picture. Returns its remover. */
export function addReportButton(player: VjsPlayer, onPress: () => void, text?: string): () => void {
  const bar = player.getChild('ControlBar');
  if (!bar) return () => {};
  const pip = bar.getChild('PictureInPictureToggle');
  const kids = bar.children() as unknown[];
  const index = pip ? kids.indexOf(pip) : kids.length;
  const button = bar.addChild(reportButtonClass(), { onPress, text }, index);
  return () => {
    bar.removeChild(button);
    button.dispose();
  };
}

const KEYS_BUTTON = 'DosyaKeysButton';

/** The control-bar "?" that opens the keyboard shortcuts overlay. */
function keysButtonClass(): string {
  if (videojs.getComponent(KEYS_BUTTON)) return KEYS_BUTTON;
  const Button = videojs.getComponent('Button') as unknown as ButtonCtor;
  class DosyaKeysButton extends Button {
    private readonly onPress: () => void;
    constructor(player: VjsPlayer, options: Record<string, unknown> = {}) {
      super(player, options);
      this.onPress = (options.onPress as () => void) ?? (() => {});
      this.controlText((options.text as string | undefined) ?? 'Keyboard shortcuts');
      const el = this.el();
      el.setAttribute('aria-haspopup', 'dialog');
      el.setAttribute('aria-expanded', 'false');
      const glyph = document.createElement('span');
      glyph.className = 'dp-glyph';
      glyph.setAttribute('aria-hidden', 'true');
      glyph.innerHTML = icons.help;
      el.prepend(glyph);
    }
    buildCSSClass(): string {
      return `dp-keys-btn vjs-control vjs-button`;
    }
    handleClick(): void {
      this.onPress();
    }
  }
  videojs.registerComponent(KEYS_BUTTON, DosyaKeysButton as never);
  return KEYS_BUTTON;
}

const RATE_GROUP = 'DosyaRateGroup';

/** The speed control, wherever addKeysButton has put it. */
function speedControl(player: VjsPlayer) {
  const bar = player.getChild('ControlBar');
  return bar?.getChild(RATE_GROUP)?.getChild('PlaybackRateMenuButton') ?? bar?.getChild('PlaybackRateMenuButton');
}

/**
 * Adds the shortcuts button just before the speed control. Both move into one
 * `.dp-rate-group` (skin.css keeps it from wrapping), so a narrow bar that
 * wraps never puts "?" and speed on different rows. Returns the button
 * element and a remover that puts the speed control back.
 */
export function addKeysButton(player: VjsPlayer, onPress: () => void, text?: string): { el: HTMLElement | null; remove(): void } {
  const bar = player.getChild('ControlBar');
  if (!bar) return { el: null, remove: () => {} };
  const rate = bar.getChild('PlaybackRateMenuButton');
  if (!rate) {
    const lone = bar.addChild(keysButtonClass(), { onPress, text });
    return { el: lone.el() as HTMLElement, remove() { bar.removeChild(lone); lone.dispose(); } };
  }
  const kids = bar.children() as unknown[];
  const index = kids.indexOf(rate);
  const group = bar.addChild('Component', { name: RATE_GROUP, className: 'dp-rate-group' }, index);
  const button = group.addChild(keysButtonClass(), { onPress, text });
  // Video.js moves the component (and its element) out of the bar.
  group.addChild(rate);
  return {
    el: button.el() as HTMLElement,
    remove() {
      const at = (bar.children() as unknown[]).indexOf(group);
      bar.addChild(rate, {}, at);
      bar.removeChild(group);
      group.dispose();
    },
  };
}

/** Closes the speed menu the way Video.js does itself. */
export function closeSpeedMenu(player: VjsPlayer): void {
  const rate = speedControl(player) as unknown as { unpressButton?(): void } | undefined;
  rate?.unpressButton?.();
}

/**
 * Fits the open speed menu into the room between the player's top edge and
 * its button, so a short player (a phone) does not clip the upper rates
 * behind `.dp { overflow: hidden }`. The menu scrolls inside instead, with
 * the selected rate brought into view. Closing clears the cap.
 */
export function fitSpeedMenu(root: HTMLElement, bar: HTMLElement, open: boolean): void {
  const rate = bar.querySelector<HTMLElement>('.vjs-playback-rate');
  const menu = rate?.querySelector<HTMLElement>('.vjs-menu');
  if (!rate || !menu) return;
  menu.style.right = '';
  if (!open) {
    menu.style.maxHeight = '';
    menu.style.overflowY = '';
    return;
  }
  const rootBox = root.getBoundingClientRect();
  const rateBox = rate.getBoundingClientRect();
  // The menu sits 8px above the button (skin.css: bottom 46px on a 38px
  // control) and keeps another 8px under the player's top edge, so its
  // rounded corners are never cut.
  const available = Math.max(0, Math.floor(rateBox.top - rootBox.top - 8 - 8));
  menu.style.maxHeight = `${available}px`;
  menu.style.overflowY = 'auto';
  // Horizontally: the menu is right-aligned to its button, so when a wrapped
  // bar puts speed at the far left it hangs past the player's left edge.
  // Shift it back inside with an 8px margin (inline `right`, not transform:
  // the open animation owns transform). The box comes from layout, not the
  // menu's own rect: mid dp-pop it is scale(0.92) from its bottom-right
  // corner, about 10px narrower than it settles. `right: 0` puts its right
  // edge on the speed control's right edge. Hidden menus are 0 wide: skip.
  const width = menu.offsetWidth;
  if (width > 0) {
    const right = rateBox.right;
    const left = right - width;
    let dx = 0;
    if (left < rootBox.left + 8) dx = rootBox.left + 8 - left;
    else if (right > rootBox.right - 8) dx = Math.max(rootBox.left + 8 - left, rootBox.right - 8 - right);
    if (dx) menu.style.right = `${-Math.sign(dx) * Math.ceil(Math.abs(dx))}px`;
  }
  // Scroll arithmetic, not scrollIntoView: the page itself must never move.
  const selected = menu.querySelector<HTMLElement>('.vjs-menu-item.vjs-selected');
  const view = menu.clientHeight || available;
  if (!selected) { menu.scrollTop = 0; return; }
  const top = selected.offsetTop;
  const bottom = top + selected.offsetHeight;
  menu.scrollTop = bottom > view ? Math.min(top, bottom - view + 6) : 0;
}

const STILL = new WeakSet<HTMLElement>();

/**
 * Video.js focuses the speed menu's first rate when it opens (Menu.focus ->
 * item.el_.focus()), each rate on arrow keys, and the speed button again
 * after a pick, all without preventScroll: with the player mostly off
 * screen that drags the page. This wraps `focus` on those elements only
 * (never a prototype) so every call keeps the page still and still moves
 * focus. Idempotent; call it again whenever Video.js may have rebuilt items.
 */
export function keepSpeedFocusStill(bar: HTMLElement): void {
  const rate = bar.querySelector('.vjs-playback-rate');
  if (!rate) return;
  rate.querySelectorAll<HTMLElement>('.vjs-menu-button, .vjs-menu-item').forEach((el) => {
    if (STILL.has(el)) return;
    STILL.add(el);
    el.focus = (options?: FocusOptions) => HTMLElement.prototype.focus.call(el, { ...options, preventScroll: true });
  });
}

/**
 * Calls `onChange(open)` whenever the speed menu opens or closes. Video.js
 * reflects that on the menu button's `aria-expanded`.
 */
export function watchSpeedMenu(bar: HTMLElement, onChange: (open: boolean) => void): () => void {
  const btn = bar.querySelector('.vjs-playback-rate .vjs-menu-button');
  if (!btn) return () => {};
  const obs = new MutationObserver(() => onChange(btn.getAttribute('aria-expanded') === 'true'));
  obs.observe(btn, { attributes: true, attributeFilter: ['aria-expanded'] });
  return () => obs.disconnect();
}
