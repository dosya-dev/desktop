/**
 * Renderer-requested actions the main process confirms with the user itself,
 * in a native dialog, before acting.
 *
 * Bounty (desktop 3.1.10): the renderer runs remote script (the ONLYOFFICE
 * api.js), and these channels acted on a bare IPC call: app:factory-reset
 * wiped local data and relaunched, app:set-launch-at-login gave a foothold
 * persistence, updater:install forced a restart. A renderer-side modal is no
 * protection against a script in that renderer; a native dialog owned by the
 * main process is.
 *
 * Pure (the translator is injected) so node --test can load it; the Electron
 * half is confirm-action.ts.
 */
import type { MessageKey } from "../i18n/keys";

export type DangerousAction =
  | { kind: "factory-reset" }
  | { kind: "launch-at-login" }
  | { kind: "install-update"; version?: string };

export interface ConfirmPrompt {
  message: string;
  detail: string;
  /** [cancel, confirm]; cancel is index 0 and the default. */
  buttons: [string, string];
}

type Translate = (key: MessageKey, values?: Record<string, string>) => string;

/** The dialog copy, all from strings the app already ships in every language. */
export function promptFor(action: DangerousAction, t: Translate): ConfirmPrompt {
  const cancel = t("common.cancel");
  switch (action.kind) {
    case "factory-reset":
      return {
        message: t("settings.heading.resetAppDataQuestionSentenceCase"),
        detail: t("settings.description.signsYouOutRemovesAllLocalAppDataIncluding"),
        buttons: [cancel, t("settings.action.resetAndRestart")],
      };
    case "launch-at-login":
      return {
        message: t("common.heading.areYouSure"),
        detail: t("sync.label.startDosyaAutomaticallyWhenYouSignIn"),
        buttons: [cancel, t("sync.label.launchAtLogin")],
      };
    case "install-update":
      return {
        message: t("common.heading.areYouSure"),
        detail: action.version
          ? t("updater.message.dosyaVersionIsReadyToInstallRestartToUpdate", { version: action.version })
          : t("about.action.restartToUpdate"),
        buttons: [cancel, t("profile.action.installRestart")],
      };
  }
}

/** showMessageBox's answer -> did the user choose the action (never on cancel/close). */
export function confirmedBy(response: number): boolean {
  return response === 1;
}
