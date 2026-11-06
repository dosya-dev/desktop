import { icons } from './icons';
import { DEFAULT_LABELS, type VideoPlayerLabels } from './labels';

export interface ShortcutsOverlay {
  el: HTMLElement;
  open(): void;
  /** `restoreFocus` false when another menu is taking over. */
  close(restoreFocus?: boolean): void;
  toggle(): void;
  isOpen(): boolean;
  destroy(): void;
}

interface Row { keys: string[]; join?: string; note?: string; desc: string }

/** What src/keys.ts binds, plus the picture's double-click. Keep the two in step. */
const rowsFor = (l: VideoPlayerLabels): Row[] => [
  { keys: [l.keySpace, 'K'], desc: l.shortcutPlayPause },
  { keys: ['←', '→'], desc: l.shortcutSeek5 },
  { keys: ['J', 'L'], desc: l.shortcutSeek10 },
  { keys: ['↑', '↓'], desc: l.shortcutVolume },
  { keys: ['M'], desc: l.shortcutMute },
  { keys: ['F'], desc: l.shortcutFullscreen },
  { keys: ['P'], desc: l.shortcutPip },
  { keys: ['0', '9'], join: '–', desc: l.shortcutJump },
  { keys: [l.keyDoubleClick], note: l.doubleClickNote, desc: l.shortcutSeek10 },
  { keys: ['?'], desc: l.shortcutShow },
  { keys: [l.keyEsc], desc: l.close },
];

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag);
  if (className) n.className = className;
  if (text !== undefined) n.textContent = text;
  return n;
}

/**
 * The full-player keyboard shortcuts dialog. `onOpenChange` feeds the
 * player's menu bookkeeping; `returnFocus` names the element focus goes back
 * to on close (the control-bar "?").
 */
export function mountShortcuts(parent: HTMLElement, onOpenChange: (open: boolean) => void, returnFocus: () => HTMLElement | null, labels: VideoPlayerLabels = DEFAULT_LABELS): ShortcutsOverlay {
  let isOpen = false;

  const root = el('div', 'dp-keys');
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-modal', 'true');
  root.setAttribute('aria-label', labels.keyboardShortcuts);

  const panel = el('div', 'dp-keys-panel');
  // Focusable so a click on the panel keeps focus (and so Escape) inside.
  panel.tabIndex = -1;
  const head = el('div', 'dp-keys-head');
  const title = el('div', 'dp-keys-title', labels.keyboardShortcuts);
  const closeBtn = el('button', 'dp-keys-close');
  closeBtn.type = 'button';
  closeBtn.setAttribute('aria-label', labels.close);
  closeBtn.innerHTML = icons.close;
  head.append(title, closeBtn);

  const list = el('ul', 'dp-keys-list');
  for (const row of rowsFor(labels)) {
    const li = el('li', 'dp-keys-row');
    const k = el('span', 'dp-keys-k');
    row.keys.forEach((name, i) => {
      if (i > 0) {
        const sep = el('span', 'dp-keys-sep', row.join ?? '/');
        sep.setAttribute('aria-hidden', 'true');
        k.append(sep);
      }
      k.append(el('kbd', undefined, name));
    });
    if (row.note) k.append(el('span', 'dp-keys-note', row.note));
    li.append(k, el('span', 'dp-keys-d', row.desc));
    list.append(li);
  }
  panel.append(head, list);
  root.append(panel);
  parent.append(root);

  const open = () => {
    if (isOpen) return;
    isOpen = true;
    root.classList.add('dp-open');
    onOpenChange(true);
    // preventScroll: a player mostly scrolled off screen must not drag the page.
    closeBtn.focus({ preventScroll: true });
  };
  const close = (restoreFocus = true) => {
    if (!isOpen) return;
    isOpen = false;
    root.classList.remove('dp-open');
    onOpenChange(false);
    if (restoreFocus) returnFocus()?.focus({ preventScroll: true });
  };
  const toggle = () => { if (isOpen) close(); else open(); };

  const onKeydown = (e: KeyboardEvent) => {
    // The player's window handler is muted while this is open; nothing
    // typed here should reach the host page either.
    e.stopPropagation();
    if (e.key === 'Escape' || e.key === '?') {
      e.preventDefault();
      close();
    } else if (e.key === 'Tab') {
      // aria-modal: the close button is the only stop.
      e.preventDefault();
      closeBtn.focus({ preventScroll: true });
    }
  };
  const onClick = (e: MouseEvent) => {
    const t = e.target as Element | null;
    if (t && t.closest && t.closest('.dp-keys-panel')) return;
    close();
  };
  const onClose = () => close();
  // A click anywhere outside (the host page included) closes it; otherwise
  // focus lands on the body, where Escape can no longer reach the overlay
  // and the muted player keys stay dead. Capture: the player stops some
  // clicks before they bubble to document.
  const onDocClick = (e: MouseEvent) => {
    if (!isOpen) return;
    const t = e.target as Element | null;
    if (t && t.closest && (t.closest('.dp-keys') === root || t.closest('.dp-keys-btn'))) return;
    close(false);
  };

  root.addEventListener('keydown', onKeydown);
  root.addEventListener('click', onClick);
  closeBtn.addEventListener('click', onClose);
  document.addEventListener('click', onDocClick, { capture: true });

  return {
    el: root,
    open,
    close,
    toggle,
    isOpen: () => isOpen,
    destroy() {
      root.removeEventListener('keydown', onKeydown);
      root.removeEventListener('click', onClick);
      closeBtn.removeEventListener('click', onClose);
      document.removeEventListener('click', onDocClick, { capture: true });
      root.remove();
    },
  };
}
