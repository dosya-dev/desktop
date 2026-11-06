/**
 * Asking before a quit throws away unsaved text-editor edits.
 *
 * The editor keeps its text in the renderer. Closing the window only hides it
 * to the tray (the renderer and the edits stay), so that path needs nothing.
 * Quitting the app does lose them: Cmd+Q, the menu's or the tray's Quit, and
 * "Restart and install". The renderer reports whether the editor has unsaved
 * changes; a quit while it does is held, the window is shown, and the
 * renderer asks "Are you sure?". Quit anyway lets the held quit go, Keep
 * editing calls it off.
 *
 * Guarantees, because a quit that never finishes is worse than a lost edit
 * (the text is also kept as a local draft):
 * - OS shutdown and logout are never held.
 * - A renderer that does not acknowledge the question within `ackTimeoutMs`
 *   (hung, or its editor already gone) does not hold the quit.
 * - No window to ask (reclaimed, destroyed) means no question.
 * - The renderer going away clears the state and releases a held quit.
 *
 * Kept free of Electron imports so it is unit-testable.
 */

export type QuitSource = "user" | "update" | "system";

export interface QuitState {
  editorDirty: boolean;
  /** The user already chose Quit anyway for this quit. */
  confirmed: boolean;
  /** The OS is shutting down, restarting or logging out. */
  systemEnding: boolean;
}

export function quitDecision(state: QuitState, source: QuitSource): "allow" | "ask" {
  if (source === "system" || state.systemEnding) return "allow";
  if (state.confirmed) return "allow";
  return state.editorDirty ? "ask" : "allow";
}

export type QuitAnswer = "shown" | "quit" | "cancel";

export interface QuitGuardDeps {
  /** Show the window and ask the renderer. False when there is no renderer to ask. */
  prompt: () => boolean;
  /** The quit was called off (Keep editing). */
  onCancel: () => void;
  /** How long the renderer has to say the dialog is up. */
  ackTimeoutMs: number;
  schedule?: (fn: () => void, ms: number) => unknown;
  cancel?: (handle: unknown) => void;
}

export interface QuitGuard {
  setDirty(dirty: boolean): void;
  /**
   * May this quit go ahead now? True: yes, carry on. False: it is held and
   * the user is being asked; `proceed` runs if they choose Quit anyway.
   */
  request(source: QuitSource, proceed: () => void): boolean;
  answer(answer: QuitAnswer): void;
  /** The OS is ending the session: never hold a quit from here on. */
  systemEnding(): void;
  /** The renderer crashed, reloaded or was destroyed: its edits are gone. */
  rendererGone(): void;
  isAsking(): boolean;
}

export function createQuitGuard(deps: QuitGuardDeps): QuitGuard {
  const schedule = deps.schedule ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const cancel = deps.cancel ?? ((h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>));
  const state: QuitState = { editorDirty: false, confirmed: false, systemEnding: false };
  let pending: (() => void) | null = null;
  let ackTimer: unknown = null;

  const clearAck = (): void => {
    if (ackTimer !== null) cancel(ackTimer);
    ackTimer = null;
  };

  /** Let the held quit go, and do not ask about it again. */
  const release = (): void => {
    clearAck();
    const go = pending;
    pending = null;
    if (!go) return;
    state.confirmed = true;
    state.editorDirty = false;
    go();
  };

  return {
    setDirty(dirty) {
      state.editorDirty = dirty;
      if (dirty) state.confirmed = false;
    },
    request(source, proceed) {
      if (quitDecision(state, source) === "allow") return true;
      if (!deps.prompt()) return true;
      // Asked again while asking: one held quit, the latest.
      pending = proceed;
      clearAck();
      ackTimer = schedule(() => {
        ackTimer = null;
        release();
      }, deps.ackTimeoutMs);
      return false;
    },
    answer(answer) {
      if (!pending) return;
      if (answer === "shown") {
        clearAck();
        return;
      }
      if (answer === "quit") {
        release();
        return;
      }
      clearAck();
      pending = null;
      deps.onCancel();
    },
    systemEnding() {
      state.systemEnding = true;
      release();
    },
    rendererGone() {
      state.editorDirty = false;
      release();
    },
    isAsking: () => pending !== null,
  };
}
