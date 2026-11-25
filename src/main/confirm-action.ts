import { BrowserWindow, dialog, type WebContents } from "electron";
import { tMain } from "./i18n";
import { promptFor, confirmedBy, type DangerousAction } from "./dangerous-actions";

type TestHooks = {
  /** What the "user" answers under the Playwright harness (default: confirm). */
  __dosyaTestConfirmAnswer?: boolean;
  /** Every action asked about under the harness, in order. */
  __dosyaTestConfirmLog?: string[];
};

/**
 * Ask the user, in a native dialog the renderer cannot script, before a
 * renderer-requested destructive or persistent action (dangerous-actions.ts).
 * Cancel is the default button and what closing the dialog means.
 *
 * Under NODE_ENV=test a native dialog would hang the harness, so the answer
 * comes from a main-process global the specs set through electronApp.evaluate
 * (never reachable from the renderer), and each question is logged so a spec
 * can prove it was asked.
 */
export async function confirmDangerousAction(action: DangerousAction, sender?: WebContents): Promise<boolean> {
  if (process.env.NODE_ENV === "test") {
    const g = globalThis as TestHooks;
    (g.__dosyaTestConfirmLog ??= []).push(action.kind);
    return g.__dosyaTestConfirmAnswer ?? true;
  }
  const { message, detail, buttons } = promptFor(action, tMain);
  const options: Electron.MessageBoxOptions = {
    type: "warning",
    message,
    detail,
    buttons,
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  };
  const win = sender ? BrowserWindow.fromWebContents(sender) : null;
  const { response } = win && !win.isDestroyed()
    ? await dialog.showMessageBox(win, options)
    : await dialog.showMessageBox(options);
  return confirmedBy(response);
}
