import { useEffect, useRef } from "react";
import type { MenuAction, MenuState, SimpleActionId } from "../../main/menu-template";

/**
 * The renderer's half of the application menu.
 *
 * Inbound: main sends one "menu:action" event per click; pages subscribe to
 * the actions they can serve (the Files page takes "new-folder", the text
 * viewer takes "find"). A handler returns true when it consumed the action,
 * so a fallback (MenuBridge) only acts when no page did.
 *
 * Outbound: pages report the slice of state the menu needs (route, selection,
 * list/grid, sidebar, appearance) and main rebuilds its checkmarks. Reports
 * are merged and sent once per microtask so a page that sets three fields in
 * one render costs one IPC message.
 */
export type MenuHandler = (action: MenuAction) => boolean | void;

const handlers = new Set<MenuHandler>();
const fallbacks = new Set<MenuHandler>();
let subscribed = false;

/** Deliver an action: page handlers first, then fallbacks until one consumes it. */
export function dispatchMenuAction(action: MenuAction): boolean {
  for (const h of handlers) if (h(action) === true) return true;
  for (const h of fallbacks) if (h(action) === true) return true;
  return false;
}

function ensureSubscribed(): void {
  if (subscribed) return;
  const api = typeof window !== "undefined" ? window.electronAPI : undefined;
  if (!api?.onMenuAction) return;
  subscribed = true;
  api.onMenuAction((action) => { dispatchMenuAction(action); });
}

export function subscribeMenuActions(handler: MenuHandler, opts: { fallback?: boolean } = {}): () => void {
  ensureSubscribed();
  const set = opts.fallback ? fallbacks : handlers;
  set.add(handler);
  return () => { set.delete(handler); };
}

/** Does `action` name this simple action? Narrow helper for handlers. */
export function isSimple(action: MenuAction, id: SimpleActionId): boolean {
  return action.kind === "simple" && action.id === id;
}

/**
 * Subscribe a component to menu actions for its lifetime. The latest handler
 * is always the one called, so callers need not memoise it.
 */
export function useMenuActions(handler: MenuHandler, opts: { fallback?: boolean } = {}): void {
  const ref = useRef(handler);
  ref.current = handler;
  const fallback = opts.fallback === true;
  useEffect(() => subscribeMenuActions((a) => ref.current(a), { fallback }), [fallback]);
}

// ── Outbound state ──────────────────────────────────────────────

const state: MenuState = {
  route: "/",
  viewMode: null,
  sidebarVisible: true,
  appearance: "system",
  selectionCount: 0,
  canGoBack: false,
  canGoForward: false,
  signedIn: false,
};
let flushQueued = false;

function flush(): void {
  flushQueued = false;
  if (typeof window === "undefined") return; // node --test: nothing to send to
  window.electronAPI?.reportMenuState?.({ ...state });
}

/** Merge a partial state and send it to main (coalesced per microtask). */
export function reportMenuState(partial: Partial<MenuState>): void {
  let changed = false;
  for (const key of Object.keys(partial) as (keyof MenuState)[]) {
    const next = partial[key];
    if (next !== undefined && state[key] !== next) {
      (state as unknown as Record<string, unknown>)[key] = next;
      changed = true;
    }
  }
  if (!changed || flushQueued) return;
  flushQueued = true;
  queueMicrotask(flush);
}

/** The state as last reported; for tests and for the ☰ popup. */
export function currentMenuState(): MenuState {
  return { ...state };
}

/**
 * Report a slice of state while mounted and restore its defaults on unmount,
 * so a page that leaves does not keep its selection count alive in the menu.
 */
export function useMenuState(partial: Partial<MenuState>, resetTo?: Partial<MenuState>): void {
  const values = Object.values(partial);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { reportMenuState(partial); }, values);
  const resetRef = useRef(resetTo);
  resetRef.current = resetTo;
  useEffect(() => () => { if (resetRef.current) reportMenuState(resetRef.current); }, []);
}
