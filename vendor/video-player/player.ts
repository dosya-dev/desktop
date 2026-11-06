import videojs from 'video.js/core.es.js';
import { addKeysButton, addReportButton, closeSpeedMenu, fitSpeedMenu, injectIcons, keepSpeedFocusStill, videojsOptions, watchSpeedMenu, type VjsPlayer } from './controls';
import { mmss } from './format';
import { icons } from './icons';
import { bindPlayerKeys } from './keys';
import { markerLeftPercent } from './markers';
import type { ReportDiagnostics } from './report/payload';
import { mountReportPopover, type ReportPopover } from './report/popover';
import type { ReportConfig } from './report/types';
import { fitBox } from './fit';
import { resolveLabels, type PartialVideoPlayerLabels } from './labels';
import { mountShortcuts, type ShortcutsOverlay } from './shortcuts';
import { createStage } from './stage';

export interface PlayerMarker { id: string; ms: number; label: string; dim?: boolean }

export interface PlayerOptions {
  src: string;
  /** Shown only in fullscreen (and on the loading stage). */
  title?: string;
  /** Default false. */
  autoplay?: boolean;
  /** Default 'auto'. 'metadata' spares bandwidth where the viewer may never press play. */
  preload?: 'auto' | 'metadata';
  /** null hides Download in the failure card (view-only shares). */
  downloadUrl?: string | null;
  /** When set, the failure card's Download is a button that calls this; downloadUrl is ignored. */
  onDownloadClick?(): void;
  /** Host-specific copy under "Couldn't load this video". */
  failureText: string;
  markers?: PlayerMarker[];
  onMarkerSelect?(id: string): void;
  onDuration?(seconds: number): void;
  onFailed?(): void;
  /** Absent means no flag button. */
  report?: ReportConfig;
  /** Default: matchMedia('(prefers-reduced-motion: reduce)'). */
  reducedMotion?: boolean;
  /**
   * A small preview (a file detail panel). Default false. The bar keeps
   * progress, play, time, speed, picture-in-picture and fullscreen; there is
   * no volume, no "?" or shortcuts overlay, no report flag (`report` is
   * ignored) and no comment markers (`markers` is ignored). The root fills
   * the host box, the loading stage drops the file name, and the failure card
   * is one line plus a small Download.
   */
  compact?: boolean;
  /**
   * Keyboard shortcuts. 'global' (the default) acts on keys anywhere on the
   * page while the player is shown. 'focus' acts only while focus is inside
   * the player, so a preview never takes arrows or Space from a file list
   * beside it. 'none' binds nothing. Compact defaults to 'focus'.
   */
  keys?: 'global' | 'focus' | 'none';
  /**
   * The words the player writes itself (control labels, the loading and
   * failure texts, the shortcuts overlay, the report popover). Any subset;
   * what is left out stays English. Read when the player mounts.
   */
  labels?: PartialVideoPlayerLabels;
}

export interface DosyaPlayer {
  el: HTMLElement;
  video: HTMLVideoElement;
  update(next: Partial<Pick<PlayerOptions, 'markers' | 'title' | 'report' | 'onMarkerSelect'>>): void;
  currentTimeMs(): number;
  seekMs(ms: number): void;
  pause(): void;
  play(): Promise<void>;
  /** Disposes Video.js, unbinds keys, removes el. */
  destroy(): void;
}

/** No bytes and no metadata for this long means the load has failed. */
export const STALL_FAIL_MS = 20_000;
/** A click on the picture waits this long for a second click before toggling. */
const CLICK_DELAY_MS = 220;
/** Elements that take focus themselves on a press; 'focus' key mode leaves them be. */
const OWN_FOCUS = 'button, a[href], input, select, textarea, [role="slider"], [role^="menuitem"], [tabindex]:not([tabindex="-1"])';

export function collectDiagnostics(video: HTMLVideoElement, codecHint: string): ReportDiagnostics {
  const w = video.videoWidth;
  const h = video.videoHeight;
  return {
    ua: navigator.userAgent,
    platform: navigator.platform,
    codec: codecHint,
    resolution: w > 0 && h > 0 ? `${w}x${h}` : '',
    position_ms: Math.round((video.currentTime || 0) * 1000),
    media_error: video.error ? video.error.code : null,
    ready_state: video.readyState,
    network_state: video.networkState,
  };
}

function div(className: string, text?: string): HTMLDivElement {
  const d = document.createElement('div');
  d.className = className;
  if (text !== undefined) d.textContent = text;
  return d;
}

/** Remove then re-add a class so its CSS animation runs again. */
function rearm(node: HTMLElement, cls: string): void {
  node.classList.remove(cls);
  void node.offsetWidth;
  node.classList.add(cls);
}

function prefersReducedMotion(): boolean {
  try {
    return typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

export function mountDosyaPlayer(host: HTMLElement, opts: PlayerOptions): DosyaPlayer {
  let markers = opts.markers ?? [];
  let onMarkerSelect = opts.onMarkerSelect;
  let title = opts.title ?? '';
  const compact = opts.compact ?? false;
  const labels = resolveLabels(opts.labels);
  const keyMode = opts.keys ?? (compact ? 'focus' : 'global');
  let report = compact ? undefined : opts.report;

  const root = div('dp dp-loading');
  if (compact) root.classList.add('dp-compact');
  // Focusable but out of the tab order, so 'focus' mode has a place to land
  // when the viewer clicks the picture.
  if (keyMode === 'focus') root.setAttribute('tabindex', '-1');
  if (opts.reducedMotion ?? prefersReducedMotion()) root.classList.add('dp-reduced-motion');

  const tag = document.createElement('video');
  tag.className = 'video-js';
  tag.setAttribute('playsinline', '');
  tag.setAttribute('preload', opts.preload ?? 'auto');
  // Set on the tag, not through Video.js `sources`: share and raw URLs carry no
  // file extension or type, and Video.js's source selection would reject them.
  // Never set crossorigin: share playback relies on cookies.
  tag.setAttribute('src', opts.src);
  root.append(tag);
  host.append(root);

  const player: VjsPlayer = videojs(tag, videojsOptions(opts.autoplay ?? false, opts.preload ?? 'auto', compact, opts.labels ? labels : undefined));
  const pel = player.el() as HTMLElement;
  const video = (pel.querySelector('video') ?? tag) as HTMLVideoElement;
  const bar = pel.querySelector<HTMLElement>('.vjs-control-bar')!;
  const holder = pel.querySelector<HTMLElement>('.vjs-progress-holder');
  injectIcons(bar);

  // Overlays live inside the Video.js element so fullscreen carries them.
  const shadeTop = div('dp-shade dp-shade-t');
  const shadeBottom = div('dp-shade dp-shade-b');
  const titleRow = div('dp-title');
  const titleText = document.createElement('span');
  titleText.className = 'dp-title-text';
  titleText.textContent = title;
  const titleMeta = document.createElement('span');
  titleMeta.className = 'dp-title-meta';
  titleRow.append(titleText, titleMeta);
  const spin = div('dp-spin');
  const big = document.createElement('button');
  big.type = 'button';
  big.className = 'dp-big';
  big.setAttribute('aria-label', labels.play);
  big.innerHTML = icons.play;
  const skipL = div('dp-skip l', labels.skipBack);
  const skipR = div('dp-skip r', labels.skipForward);
  const stage = createStage(title, compact, labels);
  pel.insertBefore(shadeTop, bar);
  pel.insertBefore(shadeBottom, bar);
  pel.insertBefore(titleRow, bar);
  pel.insertBefore(spin, bar);
  pel.insertBefore(big, bar);
  pel.insertBefore(skipL, bar);
  pel.insertBefore(skipR, bar);
  pel.append(stage.el);

  // ---- menu-open bookkeeping (speed menu, report popover, shortcuts) ----
  // Only one is ever open: opening one closes the others.
  const openMenus = new Set<string>();
  let shortcuts: ShortcutsOverlay | null = null;
  let reportPopover: ReportPopover | null = null;
  const setMenu = (name: string, open: boolean) => {
    if (open) {
      openMenus.add(name);
      if (name !== 'keys') shortcuts?.close(false);
      if (name !== 'report' && reportPopover?.isOpen()) reportPopover.close();
      if (name !== 'speed' && openMenus.has('speed')) closeSpeedMenu(player);
    } else {
      openMenus.delete(name);
    }
    root.classList.toggle('dp-menu-open', openMenus.size > 0);
  };
  const unwatchSpeed = watchSpeedMenu(bar, (open) => {
    fitSpeedMenu(root, bar, open);
    // Focus on the first rate can scroll the clipped root; undo that.
    if (open && root.scrollTop) root.scrollTop = 0;
    if (open && root.scrollLeft) root.scrollLeft = 0;
    setMenu('speed', open);
  });
  // Fit before Video.js opens the menu and focuses a rate, so that focus never
  // has an off-player row to scroll to. The open handler above refits.
  const rateEl = bar.querySelector<HTMLElement>('.vjs-playback-rate');
  const preFitSpeed = () => {
    keepSpeedFocusStill(bar);
    if (!openMenus.has('speed')) fitSpeedMenu(root, bar, true);
  };
  keepSpeedFocusStill(bar);
  // Capture on the control runs before Video.js's own click on its button.
  rateEl?.addEventListener('pointerdown', preFitSpeed, true);
  rateEl?.addEventListener('keydown', preFitSpeed, true);
  rateEl?.addEventListener('click', preFitSpeed, true);

  // ---- keyboard shortcuts overlay (not in compact: no room, no "?") ----
  let keysButton: ReturnType<typeof addKeysButton> | null = null;
  if (!compact) {
    shortcuts = mountShortcuts(pel, (open) => {
      keysButton?.el?.setAttribute('aria-expanded', String(open));
      setMenu('keys', open);
    }, () => keysButton?.el ?? null, labels);
    keysButton = addKeysButton(player, () => shortcuts?.toggle(), labels.keyboardShortcuts);
  }

  // ---- report slot (popover is the report module's) ----
  let reportAnchor: HTMLElement | null = null;
  let removeReportButton: (() => void) | null = null;
  // The host may omit diagnostics; the player then reads its own video element.
  const codecHint = () => (title.match(/\.([A-Za-z0-9]{1,5})$/)?.[1] ?? '').toLowerCase();
  const resolveReport = (cfg: ReportConfig): ReportConfig => ({
    ...cfg,
    labels: cfg.labels ?? labels.reportPopover,
    diagnostics: cfg.diagnostics ?? (() => collectDiagnostics(video, codecHint())),
  });
  const syncReport = () => {
    if (report && !removeReportButton) {
      reportAnchor = div('dp-report-anchor');
      pel.append(reportAnchor);
      reportPopover = mountReportPopover(reportAnchor, resolveReport(report), (open) => setMenu('report', open));
      removeReportButton = addReportButton(player, () => {
        if (reportPopover!.isOpen()) reportPopover!.close(); else reportPopover!.open();
      }, labels.report);
    } else if (report && reportPopover) {
      reportPopover.setConfig(resolveReport(report));
    } else if (!report && removeReportButton) {
      removeReportButton();
      removeReportButton = null;
      reportPopover?.destroy();
      reportPopover = null;
      reportAnchor?.remove();
      reportAnchor = null;
      setMenu('report', false);
      stage.el.querySelector('.dp-report-fail')?.remove();
    }
  };
  syncReport();

  // ---- playback helpers ----
  const duration = () => (Number.isFinite(video.duration) && video.duration > 0 ? video.duration : 0);
  const clampSec = (sec: number) => {
    const d = duration();
    const t = Math.max(0, sec);
    return d ? Math.min(d, t) : t;
  };
  const play = () => Promise.resolve(player.play()).then(() => undefined);
  const toggle = () => { if (video.paused) play().catch(() => {}); else player.pause(); };
  const flashSkip = (seconds: number) => rearm(seconds > 0 ? skipR : skipL, 'dp-go');
  const skip = (seconds: number) => {
    const d = duration();
    const next = Math.max(0, video.currentTime + seconds);
    video.currentTime = d ? Math.min(d, next) : next;
    flashSkip(seconds);
  };

  // ---- markers ----
  const stop = (e: Event) => e.stopPropagation();
  const onMarkerClick = (e: MouseEvent) => {
    const m = e.currentTarget as HTMLElement;
    e.stopPropagation();
    e.preventDefault();
    video.currentTime = clampSec(Number(m.dataset.ms) / 1000);
    player.pause();
    onMarkerSelect?.(m.dataset.id!);
  };
  const renderMarkers = () => {
    if (!holder || compact) return;
    holder.querySelectorAll('.dp-marker').forEach((m) => m.remove());
    const d = duration();
    if (!d) return;
    for (const m of markers) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = m.dim ? 'dp-marker dp-dim' : 'dp-marker';
      b.dataset.id = m.id;
      b.dataset.ms = String(m.ms);
      b.setAttribute('aria-label', labels.comment(m.label));
      b.style.left = `${markerLeftPercent(m.ms, d)}%`;
      // The holder IS the Video.js SeekBar, whose own listeners sit on it, so a
      // marker must stop these events itself before they bubble there.
      for (const type of ['mousedown', 'touchstart', 'pointerdown']) b.addEventListener(type, stop, { passive: true });
      b.addEventListener('click', onMarkerClick);
      holder.append(b);
    }
  };

  // ---- loading, failure ----
  let loaded = false;
  let failed = false;
  let sawProgress = false;
  let readyTimer: ReturnType<typeof setTimeout> | null = null;
  const clearReady = () => {
    root.classList.remove('dp-ready');
    if (readyTimer) { clearTimeout(readyTimer); readyTimer = null; }
  };
  const reveal = () => {
    if (loaded || failed) return;
    loaded = true;
    stage.complete();
    root.classList.remove('dp-loading');
    root.classList.add('dp-ready');
    // animationend is the normal exit; the timer covers a pop-in that never ran.
    readyTimer = setTimeout(clearReady, 1000);
  };
  const fail = () => {
    if (failed) return;
    failed = true;
    clearTimeout(stallTimer);
    shortcuts?.close(false);
    clearReady();
    // The flag lives in the hidden control bar, so the card carries its own way in.
    const onReport = report ? () => {
      if (!reportPopover) return;
      if (reportPopover.isOpen()) reportPopover.close(); else reportPopover.open();
    } : undefined;
    stage.fail(opts.failureText, opts.downloadUrl, opts.onDownloadClick, onReport);
    root.classList.remove('dp-loading');
    root.classList.add('dp-failed');
    opts.onFailed?.();
  };
  // Browsers defer media loading in background tabs, so the stall clock only
  // runs while the page is visible and restarts when it comes back.
  let stallTimer: ReturnType<typeof setTimeout> | undefined;
  const armStall = () => {
    clearTimeout(stallTimer);
    stallTimer = undefined;
    if (loaded || failed || sawProgress || document.hidden) return;
    stallTimer = setTimeout(() => {
      if (!sawProgress && video.readyState < 1) fail();
    }, STALL_FAIL_MS);
  };
  armStall();
  document.addEventListener('visibilitychange', armStall);

  // ---- size: aspect ratio from the video, exact fit inside the host ----
  let ratio = 16 / 9;
  const fit = () => {
    // Compact fills the host box (a fixed-height panel) and letterboxes the
    // picture, so the bar keeps the panel's full width for a portrait video.
    // Read the host's own box with the root out of flow: an auto-height host's
    // clientHeight would otherwise be the root's height, and the fit would pin
    // the root to whatever size it already has.
    const prev = root.style.position;
    root.style.position = 'absolute';
    const hostW = host.clientWidth;
    const hostH = host.clientHeight;
    const box = compact ? fitBox(hostW, hostH, hostH > 0 ? hostW / hostH : 0) : fitBox(hostW, hostH, ratio);
    root.style.position = prev;
    root.style.width = box ? `${box.width}px` : '';
    root.style.height = box ? `${box.height}px` : '';
  };
  // An open speed menu was fitted to the old size: refit it with the new one.
  const onResize = () => {
    fit();
    if (openMenus.has('speed')) fitSpeedMenu(root, bar, true);
  };
  const resizeObserver = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(onResize) : null;
  resizeObserver?.observe(host);
  fit();

  const onMeta = () => {
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    if (vw > 0 && vh > 0) {
      root.style.setProperty('--dp-aspect', `${vw} / ${vh}`);
      ratio = vw / vh;
      fit();
    }
    stage.metadata();
    const d = duration();
    const h = video.videoHeight;
    titleMeta.textContent = d ? (h > 0 ? `${mmss(d)} · ${h}p` : mmss(d)) : '';
    if (d) opts.onDuration?.(d);
    renderMarkers();
  };
  const onPlay = () => {
    clearReady();
    rearm(big, 'dp-burst');
    big.setAttribute('aria-label', labels.pause);
  };
  const onPause = () => {
    big.classList.remove('dp-burst');
    big.setAttribute('aria-label', labels.play);
  };
  const listeners: Array<[string, EventListener]> = [
    ['loadedmetadata', onMeta],
    ['durationchange', renderMarkers],
    ['loadeddata', reveal],
    ['canplay', reveal],
    ['progress', () => { sawProgress = true; }],
    ['error', fail],
    ['play', onPlay],
    ['pause', onPause],
  ];
  for (const [type, fn] of listeners) video.addEventListener(type, fn);
  big.addEventListener('animationend', clearReady);
  big.addEventListener('click', toggle);

  // ---- picture clicks: single toggles (delayed), double skips by half ----
  let clickTimer: ReturnType<typeof setTimeout> | null = null;
  const onPictureClick = (e: MouseEvent) => {
    if (e.target !== video) return;
    // Video.js would toggle on every click of a double-click; we own the click.
    e.stopPropagation();
    if (clickTimer) clearTimeout(clickTimer);
    clickTimer = setTimeout(() => { clickTimer = null; toggle(); }, CLICK_DELAY_MS);
  };
  const onPictureDblClick = (e: MouseEvent) => {
    if (e.target !== video) return;
    if (clickTimer) { clearTimeout(clickTimer); clickTimer = null; }
    const r = video.getBoundingClientRect();
    skip(e.clientX - r.left > r.width / 2 ? 10 : -10);
  };
  pel.addEventListener('click', onPictureClick, true);
  pel.addEventListener('dblclick', onPictureDblClick);

  // ---- focus: pointer clicks on controls and markers release focus ----
  // Keyboard activation (detail 0) keeps focus so tab users keep their place.
  // In 'focus' key mode the root takes the focus instead, so the keys keep
  // working after a click on play.
  // Capture phase, because markers and sliders stop their clicks. Deferred so
  // Video.js's own handler runs with the focus it expects. The speed control is
  // skipped: blurring its menu would close the menu as it opens.
  let blurTimer: ReturnType<typeof setTimeout> | null = null;
  const onBarClick = (e: MouseEvent) => {
    if (e.detail === 0) return;
    if (blurTimer) clearTimeout(blurTimer);
    blurTimer = setTimeout(() => {
      blurTimer = null;
      const a = document.activeElement;
      if (a instanceof HTMLElement && bar.contains(a) && !a.closest('.vjs-playback-rate')) {
        if (keyMode === 'focus') root.focus({ preventScroll: true }); else a.blur();
      }
    }, 0);
  };
  bar.addEventListener('click', onBarClick, true);

  // 'focus' key mode: a press on the picture (or any part of the player that
  // is not itself a control) focuses the root, so the keys start working.
  const onRootPointerDown = (e: PointerEvent) => {
    const t = e.target as Element | null;
    if (t?.closest?.(OWN_FOCUS)) return;
    if (!root.contains(document.activeElement)) root.focus({ preventScroll: true });
  };
  if (keyMode === 'focus') root.addEventListener('pointerdown', onRootPointerDown, true);
  // The centre play button sits outside the bar, so onBarClick never sees it:
  // a pointer click on it would leave focus on a button, where the key
  // handler leaves arrows and letters alone. Hand focus to the root instead.
  const onBigClick = (e: MouseEvent) => {
    if (e.detail === 0) return;
    if (document.activeElement === big || !root.contains(document.activeElement)) root.focus({ preventScroll: true });
  };
  if (keyMode === 'focus') big.addEventListener('click', onBigClick);

  // ---- keyboard ----
  const keysActive = () =>
    root.isConnected && !failed && !root.classList.contains('dp-menu-open') &&
    (keyMode !== 'focus' || root.contains(document.activeElement));
  const unbindKeys = keyMode === 'none' ? () => {} : bindPlayerKeys(
    {
      toggle,
      skip,
      volume(delta) {
        video.volume = Math.min(1, Math.max(0, video.volume + delta));
        if (delta > 0) video.muted = false;
      },
      mute() { video.muted = !video.muted; },
      fullscreen() {
        const p = player.isFullscreen() ? player.exitFullscreen() : player.requestFullscreen();
        Promise.resolve(p).catch(() => {});
      },
      pip() {
        const p = player.isInPictureInPicture() ? player.exitPictureInPicture() : player.requestPictureInPicture();
        Promise.resolve(p).catch(() => {});
      },
      seekFraction(f) {
        const d = duration();
        if (d) video.currentTime = d * f;
      },
      shortcuts() { shortcuts?.open(); },
    },
    keysActive,
    root,
  );

  let destroyed = false;
  return {
    el: root,
    video,
    update(next) {
      if ('onMarkerSelect' in next) onMarkerSelect = next.onMarkerSelect;
      if ('markers' in next) { markers = next.markers ?? []; renderMarkers(); }
      if ('title' in next) {
        title = next.title ?? '';
        titleText.textContent = title;
        stage.setName(title);
      }
      if ('report' in next && !compact) { report = next.report; syncReport(); }
    },
    currentTimeMs: () => Math.round((video.currentTime || 0) * 1000),
    seekMs(ms) { video.currentTime = clampSec(ms / 1000); },
    pause() { player.pause(); },
    play,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      resizeObserver?.disconnect();
      clearTimeout(stallTimer);
      document.removeEventListener('visibilitychange', armStall);
      clearReady();
      if (clickTimer) clearTimeout(clickTimer);
      if (blurTimer) clearTimeout(blurTimer);
      bar.removeEventListener('click', onBarClick, true);
      root.removeEventListener('pointerdown', onRootPointerDown, true);
      big.removeEventListener('click', onBigClick);
      rateEl?.removeEventListener('pointerdown', preFitSpeed, true);
      rateEl?.removeEventListener('keydown', preFitSpeed, true);
      rateEl?.removeEventListener('click', preFitSpeed, true);
      shortcuts?.destroy();
      shortcuts = null;
      keysButton?.remove();
      keysButton = null;
      stage.destroy();
      unbindKeys();
      unwatchSpeed();
      for (const [type, fn] of listeners) video.removeEventListener(type, fn);
      pel.removeEventListener('click', onPictureClick, true);
      pel.removeEventListener('dblclick', onPictureDblClick);
      removeReportButton?.();
      reportPopover?.destroy();
      player.dispose();
      root.remove();
    },
  };
}
