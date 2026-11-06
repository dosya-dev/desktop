import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { Minus, Square, X, Pause, Play, RefreshCw, ArrowUpDown, Menu as MenuIcon } from "lucide-react";
import { ipc } from "@/lib/ipc";
import { useSyncPaused, useSyncSyncing, useSyncHasPairs } from "@/lib/sync-store";
import { Logo } from "@/components/Logo";
import { NotificationBell } from "@/components/notifications/NotificationBell";
import { ThemeMenu } from "@/components/ThemeMenu";
import { LanguageMenu } from "@/components/LanguageMenu";
import { NavButtons } from "@/components/layout/NavButtons";
import { useT } from "@/lib/i18n";

export function TitleBar() {
  const t = useT();
  const [platform, setPlatform] = useState<string>("darwin");
  // Read from the shared store via primitive selectors - this component now
  // only re-renders when one of these booleans actually flips, not on every
  // sync-status tick during a transfer.
  const syncPaused = useSyncPaused();
  const syncSyncing = useSyncSyncing();
  const hasPairs = useSyncHasPairs();

  useEffect(() => {
    ipc.getPlatform().then(setPlatform);
  }, []);

  const toggleSync = () => {
    if (syncPaused) {
      window.electronAPI.resumeAllSync();
    } else {
      window.electronAPI.pauseAllSync();
    }
  };

  // The mark plus the wordmark. Named for what it is, so it no longer collides with
  // the <Logo> mark it renders.
  const lockup = (
    <div className="titlebar-no-drag flex items-center gap-2">
      <Logo className="h-5 w-5" />
      <span className="text-sm font-semibold text-[var(--color-text)]">
        dosya.dev
      </span>
    </div>
  );

  const navigate = useNavigate();

  // Windows and Linux hide the native menu bar (the title bar is ours), so
  // the application menu is popped from here, under the button.
  const MenuButton = (
    <button
      onClick={(e) => {
        const r = e.currentTarget.getBoundingClientRect();
        void window.electronAPI.popupAppMenu(r.left, r.bottom);
      }}
      className="titlebar-no-drag flex items-center rounded-lg px-2 py-1 text-[var(--color-text-secondary)] hover:bg-black/5 transition-colors"
      title={t("navigation.accessibility.menu")}
      aria-label={t("navigation.accessibility.menu")}
      data-testid="app-menu-button"
    >
      <MenuIcon size={15} />
    </button>
  );

  const LanButton = (
    <button
      onClick={() => navigate("/lan-transfer")}
      className="titlebar-no-drag flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-xs font-medium text-[var(--color-text-secondary)] hover:bg-black/5 transition-colors"
      title={t("lan-transfer.heading.lanTransfer")}
    >
      <ArrowUpDown size={13} />
    </button>
  );

  const SyncButton = hasPairs ? (
    <button
      onClick={toggleSync}
      className={`titlebar-no-drag flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-xs font-medium transition-colors ${
        // Paused is a deliberate stop, not a failure (TC-055): neutral, never red.
        syncPaused
          ? "bg-[var(--color-bg-tertiary)] text-[var(--color-text-secondary)] hover:bg-black/5"
          : syncSyncing
            ? "bg-blue-50 text-blue-600"
            : "bg-[var(--color-primary)]/10 text-[var(--color-primary)] hover:bg-[var(--color-primary)]/20"
      }`}
      title={syncPaused ? t("navigation.action.resumeSync") : t("navigation.action.pauseSync")}
    >
      {syncPaused ? (
        <>
          <Play size={12} />
          {t("navigation.action.resumeSync")}
        </>
      ) : syncSyncing ? (
        <>
          <RefreshCw size={12} className="animate-spin" />
          {t("navigation.status.syncing")}
        </>
      ) : (
        <>
          <Pause size={12} />
          {t("navigation.action.pauseSync")}
        </>
      )}
    </button>
  ) : null;

  // macOS
  if (platform === "darwin") {
    return (
      <div
        data-testid="titlebar"
        // The traffic lights are on the side the OS puts them, top-left, or
        // top-right in an RTL macOS (data-os-dir), whatever the app's language.
        // rtl-ok: physical geometry, macOS traffic lights follow the OS direction, not the app's
        className="titlebar-drag flex h-[var(--titlebar-height)] items-center justify-between pl-20 pr-4 os-rtl:pl-4 os-rtl:pr-20"
        style={{ background: "var(--color-bg-secondary)", borderBottom: "1px solid var(--color-border)" }}
      >
        <div className="flex flex-1 items-center"><NavButtons /></div>
        {lockup}
        <div className="flex flex-1 items-center justify-end gap-1"><LanguageMenu /><ThemeMenu />{LanButton}{SyncButton}<NotificationBell /></div>
      </div>
    );
  }

  // Windows (uses titleBarOverlay for native window controls)
  if (platform === "win32") {
    return (
      <div
        data-testid="titlebar"
        // In RTL the button cluster is at the right, where the OS paints the
        // caption buttons: end it before them. LTR keeps px-4 (the empty third
        // column already sits under the overlay).
        // An RTL Windows that mirrors the overlay to the left starts the row
        // after it (.titlebar-caption-row in styles/index.css).
        // rtl-ok: rtl selector, Windows caption overlay
        className="titlebar-drag titlebar-caption-row flex h-[var(--titlebar-height)] items-center px-4 rtl:pr-[var(--titlebar-inset-right)]"
        style={{ background: "var(--color-bg-secondary)", borderBottom: "1px solid var(--color-border)" }}
      >
        <div className="flex flex-1 items-center gap-1">{MenuButton}<NavButtons /><LanguageMenu align="start" /><ThemeMenu align="start" />{LanButton}{SyncButton}<NotificationBell align="start" /></div>
        <div className="flex-1 flex justify-center">{lockup}</div>
        <div className="flex-1" />
      </div>
    );
  }

  // Linux (custom window controls)
  return (
    <div
      data-testid="titlebar"
      className="titlebar-drag flex h-[var(--titlebar-height)] items-center px-4"
      style={{ background: "var(--color-bg-secondary)" }}
    >
      <div className="flex flex-1 items-center gap-1">{MenuButton}<NavButtons />{LanButton}{SyncButton}<NotificationBell align="start" /></div>
      <div className="flex-1 flex justify-center">{lockup}</div>
      <div className="titlebar-no-drag flex flex-1 items-center justify-end gap-1">
        <button
          onClick={() => ipc.minimize()}
          className="rounded p-1.5 hover:bg-black/5"
          aria-label={t("navigation.accessibility.minimize")}
        >
          <Minus size={14} />
        </button>
        <button
          onClick={() => ipc.maximize()}
          className="rounded p-1.5 hover:bg-black/5"
          aria-label={t("navigation.accessibility.maximize")}
        >
          <Square size={12} />
        </button>
        <button
          onClick={() => ipc.close()}
          className="rounded p-1.5 hover:bg-red-500 hover:text-white"
          aria-label={t("common.close")}
        >
          <X size={14} />
        </button>
      </div>
    </div>
  );
}
