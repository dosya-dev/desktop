import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { primeApiBase } from "./lib/api-client";
import { applyTheme, readCache } from "./lib/theme";
import "./styles/index.css";

// Apply the cached theme + mode to <html> synchronously, before any async
// bootstrap or the first paint, so the app never flashes the default palette.
// The account's saved appearance is reconciled later on login (auth-context).
applyTheme(readCache());

// The API base comes from the main process over IPC. Prime it before the
// first render so URL builders (img/video/iframe src) can read it synchronously.
(async () => {
  const root = document.getElementById("root")!;
  try {
    await primeApiBase();
  } catch {
    root.innerHTML =
      '<div style="display:flex;height:100vh;align-items:center;justify-content:center;font-family:system-ui;font-size:14px;color:#666">Failed to start - could not reach the main process. Please restart the app.</div>';
    return;
  }
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
})();
