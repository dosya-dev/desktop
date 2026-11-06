export interface PlayerKeyTarget {
  toggle(): void;
  skip(seconds: number): void;
  volume(delta: number): void;
  mute(): void;
  fullscreen(): void;
  pip(): void;
  seekFraction(fraction: number): void;
  /** `?` opens the shortcuts overlay. Absent: `?` passes through. */
  shortcuts?(): void;
}

const FOCUSED_CONTROL = 'button, a, [role=button], [role=slider], [role=menuitem], .vjs-control-bar';

/** Widgets that own their own keys (a Share dialog's Select, a tab strip, an editor). */
const KEY_OWNER = [
  '[aria-modal="true"]', '[role="dialog"]', '[role="alertdialog"]', '[role="listbox"]', '[role="option"]',
  '[role="menu"]', '[role="menubar"]', '[role="tablist"]', '[role="radiogroup"]', '[role="combobox"]',
  '[role="textbox"]', '[contenteditable]',
].join(', ');

/**
 * True when `t` sits inside a key-owning widget that does not contain the
 * player root. A dialog that hosts the player (the file viewer) keeps the
 * player's keys; one beside it (a Share modal) does not.
 */
function insideForeignKeyOwner(t: Element, root: Element | null | undefined): boolean {
  let owner = t.closest(KEY_OWNER);
  while (owner) {
    if (!root || !owner.contains(root)) return true;
    owner = owner.parentElement?.closest(KEY_OWNER) ?? null;
  }
  return false;
}

/**
 * Space/K play-pause, arrows +-5 s, J/L +-10 s, up/down volume, M mute,
 * F fullscreen, P picture-in-picture, 0-9 jump to that tenth, ? shortcuts.
 *
 * Bound on `window` in the capture phase so it wins over a host viewer's own
 * arrow-key navigation, and stops propagation for every key it handles.
 * `isActive` gates the whole handler (player off screen, popover open, ...).
 * Keys typed inside a dialog, listbox, menu, tab strip or editor that does not
 * contain `root` are left alone entirely. Returns the unbind function.
 */
export function bindPlayerKeys(target: PlayerKeyTarget, isActive: () => boolean, root?: Element | null): () => void {
  const onKey = (e: KeyboardEvent) => {
    if (!isActive()) return;
    const t = e.target as HTMLElement | null;
    const tag = (t?.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select' || t?.isContentEditable) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (t?.closest && insideForeignKeyOwner(t, root)) return;
    // No control uses `?`, so it works even with a player button focused (the
    // shortcuts overlay hands focus back to its own button when it closes).
    if (e.key === '?' && target.shortcuts) {
      target.shortcuts();
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    // Focused controls keep their own keys (Space/Enter activate, sliders take arrows).
    if (t?.closest?.(FOCUSED_CONTROL)) return;

    const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    switch (key) {
      case ' ':
      case 'k': target.toggle(); break;
      case 'ArrowRight': target.skip(5); break;
      case 'ArrowLeft': target.skip(-5); break;
      case 'l': target.skip(10); break;
      case 'j': target.skip(-10); break;
      case 'ArrowUp': target.volume(0.1); break;
      case 'ArrowDown': target.volume(-0.1); break;
      case 'm': target.mute(); break;
      case 'f': target.fullscreen(); break;
      case 'p': target.pip(); break;
      default:
        if (key >= '0' && key <= '9' && key.length === 1) {
          target.seekFraction(Number(key) / 10);
          break;
        }
        return;
    }
    e.preventDefault();
    e.stopPropagation();
  };
  window.addEventListener('keydown', onKey, true);
  return () => window.removeEventListener('keydown', onKey, true);
}
