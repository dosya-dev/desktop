import { icons } from './icons';
import { DEFAULT_LABELS, type VideoPlayerLabels } from './labels';

/**
 * First-open loading stage and failure card: a slow light sweep, a ring with a
 * play glyph, the file name, a pulsing status dot, and a 2 px hairline that
 * creeps toward 88 % and completes on first playable data. On failure the same
 * surface turns red and offers a download and, with a report config, a way
 * to report the failure.
 *
 * Compact (a detail panel): the failure card is the red ring, one line and,
 * with a download, a small Download. The host's long copy and the report
 * button are left out; skin.css hides the name line and shrinks the ring.
 */
export interface Stage {
  el: HTMLElement;
  setName(name: string): void;
  /** Metadata is known: switch the status line. */
  metadata(): void;
  /** First playable data: run the hairline to 100 %. */
  complete(): void;
  /** `onReport` adds a "Report a problem" button beside Download. */
  fail(failureText: string, downloadUrl: string | null | undefined, onDownloadClick?: () => void, onReport?: () => void): void;
  destroy(): void;
}

const CREEP_TARGET = 0.88;
const CREEP_MS = 180;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export function createStage(name: string, compact = false, labels: VideoPlayerLabels = DEFAULT_LABELS): Stage {
  const root = el('div', 'dp-stage');
  root.setAttribute('role', 'status');
  root.setAttribute('aria-live', 'polite');

  const sweep = el('div', 'dp-stage-sweep');
  const card = el('div', 'dp-stage-card');
  const ring = el('div', 'dp-stage-ring');
  ring.innerHTML = icons.play;
  const nameEl = el('div', 'dp-stage-name', name);
  const statusRow = el('div', 'dp-stage-status-row');
  const dot = el('i', 'dp-stage-dot');
  const status = el('span', 'dp-stage-status', labels.loadingVideo);
  statusRow.append(dot, status);
  const failure = el('p', 'dp-stage-failure');
  card.append(ring, nameEl, statusRow, failure);
  const line = el('div', 'dp-stage-line');
  root.append(sweep, card, line);

  let progress = 0;
  const paint = () => { line.style.transform = `scaleX(${progress})`; };
  paint();
  let creep: ReturnType<typeof setInterval> | null = setInterval(() => {
    progress += (CREEP_TARGET - progress) * 0.08;
    paint();
  }, CREEP_MS);
  const stopCreep = () => { if (creep !== null) { clearInterval(creep); creep = null; } };

  return {
    el: root,
    setName(next) { nameEl.textContent = next; },
    metadata() { status.textContent = labels.bufferingFirstFrames; },
    complete() {
      stopCreep();
      progress = 1;
      paint();
    },
    fail(failureText, downloadUrl, onDownloadClick, onReport) {
      stopCreep();
      progress = 1;
      paint();
      status.textContent = compact ? labels.cantPlayHere : labels.couldntLoad;
      failure.textContent = compact ? '' : failureText;
      card.querySelector('.dp-stage-actions')?.remove();
      const actions = el('div', 'dp-stage-actions');
      if (onDownloadClick) {
        const b = el('button', 'dp-download');
        b.type = 'button';
        b.innerHTML = `${icons.download}<span></span>`;
        b.querySelector('span')!.textContent = labels.download;
        b.addEventListener('click', onDownloadClick);
        actions.append(b);
      } else if (typeof downloadUrl === 'string') {
        const a = el('a', 'dp-download');
        a.href = downloadUrl;
        a.setAttribute('download', '');
        a.innerHTML = `${icons.download}<span></span>`;
        a.querySelector('span')!.textContent = labels.download;
        actions.append(a);
      }
      if (onReport && !compact) {
        const r = el('button', 'dp-report-fail', labels.reportAProblem);
        r.type = 'button';
        r.addEventListener('click', onReport);
        actions.append(r);
      }
      if (actions.childElementCount) card.append(actions);
    },
    destroy() { stopCreep(); },
  };
}
