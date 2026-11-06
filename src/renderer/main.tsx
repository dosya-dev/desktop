import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { primeApiBase } from "./lib/api-client";
import { I18nProvider, loadStartupMessages } from "./lib/i18n";
import type { Messages } from "../i18n/translator";
import type { Locale } from "../i18n/locales";
import { applyTheme, readCache } from "./lib/theme";
import { initSentryRenderer } from "./lib/sentry";
import "./styles/index.css";

// Before anything can throw: unhandled errors and rejections from here on are
// captured and forwarded to the main process (see lib/sentry.ts).
initSentryRenderer();

// Apply the cached theme + mode to <html> synchronously, before any async
// bootstrap or the first paint, so the app never flashes the default palette.
// The account's saved appearance is reconciled later on login (auth-context).
applyTheme(readCache());

// The API base comes from the main process over IPC. Prime it before the
// first render so URL builders (img/video/iframe src) can read it synchronously.
(async () => {
  const root = document.getElementById("root")!;
  let locale: Locale;
  let messages: Messages;
  try {
    await primeApiBase();
    // The saved language, with its messages loaded before the first render so
    // a non-English start never paints an English frame first. A chunk that
    // fails to load starts the app in English rather than not at all.
    ({ locale, messages } = await loadStartupMessages(await window.electronAPI.getLocale()));
    // Stamp the platform on <html> before first paint. Surfaces that cover the
    // title bar key off this to leave room for the macOS traffic lights (see
    // --titlebar-inset-left in styles/index.css); resolving it here means they
    // never render once at the wrong offset and then jump.
    document.documentElement.dataset.platform = await window.electronAPI.getPlatform();
    // And the OS UI direction, which can differ from the app's language: an
    // Arabic Mac draws the traffic lights on the right whatever language the
    // app is in. Only an RTL OS is stamped, so an LTR one renders as before;
    // not knowing it is not a reason to refuse to start.
    if ((await window.electronAPI.getOsDir().catch(() => "ltr")) === "rtl") {
      document.documentElement.dataset.osDir = "rtl";
    }
  } catch {
    root.innerHTML =
      '<div style="display:flex;height:100vh;align-items:center;justify-content:center;font-family:system-ui;font-size:14px;color:#666">Failed to start - could not reach the main process. Please restart the app.</div>';
    return;
  }
  createRoot(root).render(
    <StrictMode>
      <I18nProvider initial={locale} initialMessages={messages}>
        <App />
      </I18nProvider>
    </StrictMode>,
  );
})();
