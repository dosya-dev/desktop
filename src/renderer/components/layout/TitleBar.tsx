import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { Minus, Square, X, Pause, Play, RefreshCw, ArrowUpDown } from "lucide-react";
import { ipc } from "@/lib/ipc";
import { useSyncPaused, useSyncSyncing, useSyncHasPairs } from "@/lib/sync-store";
import logoSvg from "@/assets/logo.svg";

export function TitleBar() {
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

  const Logo = (
    <div className="titlebar-no-drag flex items-center gap-2">
      <img src={logoSvg} alt="dosya.dev" className="h-5 w-5" />
      <span className="text-sm font-semibold text-[var(--color-text)]">
        dosya.dev
      </span>
    </div>
  );

  const navigate = useNavigate();

  const LanButton = (
    <button
      onClick={() => navigate("/lan-transfer")}
      className="titlebar-no-drag flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-xs font-medium text-[var(--color-text-secondary)] hover:bg-black/5 transition-colors"
      title="LAN Transfer"
    >
      <ArrowUpDown size={13} />
    </button>
  );

  const SyncButton = hasPairs ? (
    <button
      onClick={toggleSync}
      className={`titlebar-no-drag flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-xs font-medium transition-colors ${
        syncPaused
          ? "bg-red-50 text-red-600 hover:bg-red-100"
          : syncSyncing
            ? "bg-blue-50 text-blue-600"
            : "bg-[var(--color-primary)]/10 text-[var(--color-primary)] hover:bg-[var(--color-primary)]/20"
      }`}
      title={syncPaused ? "Resume sync" : "Pause sync"}
    >
      {syncPaused ? (
        <>
          <Play size={12} />
          Resume sync
        </>
      ) : syncSyncing ? (
        <>
          <RefreshCw size={12} className="animate-spin" />
          Syncing...
        </>
      ) : (
        <>
          <Pause size={12} />
          Pause sync
        </>
      )}
    </button>
  ) : null;

  // macOS
  if (platform === "darwin") {
    return (
      <div
        className="titlebar-drag flex h-[var(--titlebar-height)] items-center justify-between pl-20 pr-4"
        style={{ background: "var(--color-bg-secondary)", borderBottom: "1px solid var(--color-border)" }}
      >
        <div className="flex-1" />
        {Logo}
        <div className="flex flex-1 items-center justify-end gap-1">{LanButton}{SyncButton}</div>
      </div>
    );
  }

  // Windows (uses titleBarOverlay for native window controls)
  if (platform === "win32") {
    return (
      <div
        className="titlebar-drag flex h-[var(--titlebar-height)] items-center px-4"
        style={{ background: "var(--color-bg-secondary)", borderBottom: "1px solid var(--color-border)" }}
      >
        <div className="flex flex-1 items-center gap-1">{LanButton}{SyncButton}</div>
        <div className="flex-1 flex justify-center">{Logo}</div>
        <div className="flex-1" />
      </div>
    );
  }

  // Linux (custom window controls)
  return (
    <div
      className="titlebar-drag flex h-[var(--titlebar-height)] items-center px-4"
      style={{ background: "var(--color-bg-secondary)" }}
    >
      <div className="flex flex-1 items-center gap-1">{LanButton}{SyncButton}</div>
      <div className="flex-1 flex justify-center">{Logo}</div>
      <div className="titlebar-no-drag flex flex-1 items-center justify-end gap-1">
        <button
          onClick={() => ipc.minimize()}
          className="rounded p-1.5 hover:bg-black/5"
          aria-label="Minimize"
        >
          <Minus size={14} />
        </button>
        <button
          onClick={() => ipc.maximize()}
          className="rounded p-1.5 hover:bg-black/5"
          aria-label="Maximize"
        >
          <Square size={12} />
        </button>
        <button
          onClick={() => ipc.close()}
          className="rounded p-1.5 hover:bg-red-500 hover:text-white"
          aria-label="Close"
        >
          <X size={14} />
        </button>
      </div>
    </div>
  );
}
