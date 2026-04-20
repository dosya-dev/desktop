import { useState, useEffect } from "react";
import { NavLink, useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  LayoutDashboard,
  FolderOpen,
  Upload,
  Share2,
  Users,
  Settings,
  Search,
  LogOut,
  ChevronDown,
  Check,
  Plus,
  HardDrive,
  PanelLeftClose,
  PanelLeftOpen,
  RefreshCw,
  FileUp,
} from "lucide-react";
import { useAuth } from "@/lib/auth-context";
import { useWorkspace } from "@/lib/workspace-context";
import { api, ApiError } from "@/lib/api-client";
import { ipc } from "@/lib/ipc";
import { formatBytes } from "@/lib/format";
import { toast } from "sonner";

const navItems = [
  { to: "/dashboard", icon: LayoutDashboard, label: "Dashboard" },
  { to: "/files", icon: FolderOpen, label: "Files" },
  { to: "/upload", icon: Upload, label: "Upload" },
  { to: "/shared", icon: Share2, label: "Shared" },
  { to: "/team", icon: Users, label: "Team" },
  { to: "/sync", icon: RefreshCw, label: "Sync" },
  { to: "/settings", icon: Settings, label: "Settings" },
];

export function Sidebar() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const { workspaces, active, setActive } = useWorkspace();
  const queryClient = useQueryClient();
  const [wsOpen, setWsOpen] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [newWsName, setNewWsName] = useState("");
  const [newWsColor, setNewWsColor] = useState("#22c55e");
  const [collapsed, setCollapsed] = useState(false);
  const [platform, setPlatform] = useState<string>("darwin");
  const [syncPaused, setSyncPaused] = useState(false);
  const [syncHasError, setSyncHasError] = useState(false);
  const [syncHasPairs, setSyncHasPairs] = useState(false);
  const [syncRunning, setSyncRunning] = useState(false);
  /** Per-workspace sync summary: workspaceId → { syncing, error, paused, pairs } */
  const [wsSyncMap, setWsSyncMap] = useState<Record<string, { syncing: boolean; error: boolean; paused: boolean; count: number }>>({});

  useEffect(() => {
    ipc.getPlatform().then(setPlatform);
  }, []);

  // Reset sync indicators when user changes
  useEffect(() => {
    if (!user) {
      setSyncPaused(false);
      setSyncHasError(false);
      setSyncHasPairs(false);
      setSyncRunning(false);
      setWsSyncMap({});
      return;
    }

    const update = (s: any) => {
      const pairs = s?.pairs ?? [];
      setSyncHasPairs(pairs.length > 0);
      setSyncPaused(s?.globalPaused ?? false);
      setSyncHasError(pairs.some((p: any) => p.status === "error"));
      setSyncRunning(pairs.some((p: any) => p.status === "syncing" || p.status === "idle"));

      // Build per-workspace sync summary
      const map: Record<string, { syncing: boolean; error: boolean; paused: boolean; count: number }> = {};
      for (const p of pairs) {
        const wsId = p.workspaceId;
        if (!wsId) continue;
        if (!map[wsId]) map[wsId] = { syncing: false, error: false, paused: false, count: 0 };
        map[wsId].count++;
        if (p.status === "syncing") map[wsId].syncing = true;
        if (p.status === "error") map[wsId].error = true;
        if (p.status === "paused") map[wsId].paused = true;
      }
      setWsSyncMap(map);
    };

    window.electronAPI.getSyncStatus?.().then(update).catch(() => {});
    const unsub = window.electronAPI.onSyncStatusChanged?.(update);
    return () => unsub?.();
  }, [user?.id]);

  const [apiBase, setApiBase] = useState("");
  useEffect(() => {
    window.electronAPI.getApiBase().then(setApiBase);
  }, []);

  const { data: dashData } = useQuery({
    queryKey: ["dashboard-storage", active?.id],
    queryFn: () =>
      api.get<{
        ok: boolean;
        stats: { total_bytes: number; storage_cap_bytes: number };
      }>(`/api/dashboard?workspace_id=${active?.id}`),
    enabled: !!active,
    staleTime: 60_000,
  });

  const storageUsed = dashData?.stats?.total_bytes ?? 0;
  const storageCap = dashData?.stats?.storage_cap_bytes ?? 0;
  const storagePercent = storageCap > 0 ? Math.min(100, Math.round((storageUsed / storageCap) * 100)) : 0;

  const createWsMut = useMutation({
    mutationFn: (name: string) => api.post<{ ok: boolean; workspace: { id: string; name: string; slug: string; icon_initials: string; icon_color: string; owner_id: string } }>("/api/workspaces", { name, icon_color: newWsColor }),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["workspaces"] });
      setActive(data.workspace as any);
      setShowCreate(false);
      setNewWsName("");
      setNewWsColor("#22c55e");
      setWsOpen(false);
      toast.success("Workspace created");
    },
    onError: (err) => {
      toast.error(err instanceof ApiError ? err.message : "Failed to create workspace");
    },
  });

  return (
    <aside
      className="relative flex h-full flex-col border-r transition-all duration-200"
      style={{
        width: collapsed ? 60 : 260,
        minWidth: collapsed ? 60 : 260,
        borderColor: "var(--color-border)",
        background: "var(--color-bg-secondary)",
        overflow: "visible",
      }}
    >
      {/* Collapse toggle — sits on the sidebar/content border, near the user profile */}
      <button
        onClick={() => setCollapsed(!collapsed)}
        className="absolute z-30 flex h-6 w-6 items-center justify-center rounded-full border bg-[var(--color-bg)] text-[var(--color-text-muted)] shadow-sm hover:bg-[var(--color-bg-secondary)] hover:text-[var(--color-text)] transition-colors"
        style={{
          borderColor: "var(--color-border)",
          right: -12,
          bottom: 42,
        }}
        title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
      >
        {collapsed ? <PanelLeftOpen size={12} /> : <PanelLeftClose size={12} />}
      </button>

      {/* Inner scrollable content */}
      <div className="flex h-full flex-col overflow-hidden">

      {/* Workspace Switcher */}
      <div className="relative p-3 pb-0">
        <button
          onClick={() => !collapsed && setWsOpen(!wsOpen)}
          className={`flex w-full items-center ${collapsed ? "justify-center" : "gap-2.5"} rounded-lg px-3 py-2 text-sm hover:bg-black/5 transition-colors`}
          title={collapsed ? active?.name || "Select workspace" : undefined}
        >
          <div
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-xs font-semibold text-white"
            style={{ background: active?.icon_color || "var(--color-primary)" }}
          >
            {active?.icon_initials || "?"}
          </div>
          {!collapsed && (
            <>
              <span className="flex-1 truncate text-left font-medium">
                {active?.name || "Select workspace"}
              </span>
              <ChevronDown
                size={14}
                className={`text-[var(--color-text-muted)] transition-transform ${wsOpen ? "rotate-180" : ""}`}
              />
            </>
          )}
        </button>

        {/* Workspace Dropdown */}
        {wsOpen && (
          <>
            <div className="fixed inset-0 z-40" onClick={() => setWsOpen(false)} />
            <div
              className="absolute left-3 right-3 z-50 mt-1 rounded-lg border bg-[var(--color-bg)] py-1 shadow-lg"
              style={{ borderColor: "var(--color-border)" }}
            >
              {workspaces.map((ws) => {
                const wsSync = wsSyncMap[ws.id];
                return (
                  <button
                    key={ws.id}
                    onClick={() => {
                      setActive(ws);
                      setWsOpen(false);
                    }}
                    className="flex w-full items-center gap-2.5 px-3 py-2 text-sm hover:bg-[var(--color-bg-secondary)] transition-colors"
                  >
                    <div
                      className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-xs font-semibold text-white"
                      style={{ background: ws.icon_color || "var(--color-primary)" }}
                    >
                      {ws.icon_initials}
                    </div>
                    <span className="flex-1 truncate text-left">{ws.name}</span>
                    {wsSync && wsSync.count > 0 && (
                      <span
                        className="flex items-center gap-1 text-[10px] font-medium"
                        title={
                          wsSync.error ? "Sync error" :
                          wsSync.syncing ? "Syncing" :
                          wsSync.paused ? "Sync paused" :
                          "Synced"
                        }
                      >
                        {wsSync.error ? (
                          <span className="h-1.5 w-1.5 rounded-full bg-red-500" />
                        ) : wsSync.syncing ? (
                          <RefreshCw size={10} className="animate-spin text-blue-500" />
                        ) : wsSync.paused ? (
                          <span className="h-1.5 w-1.5 rounded-full bg-gray-400" />
                        ) : (
                          <span className="h-1.5 w-1.5 rounded-full bg-green-500" />
                        )}
                      </span>
                    )}
                    {ws.id === active?.id && (
                      <Check size={14} className="text-[var(--color-primary)]" />
                    )}
                  </button>
                );
              })}
              <div className="my-1 h-px bg-[var(--color-border)]" />
              <button
                onClick={() => {
                  setWsOpen(false);
                  setShowCreate(true);
                }}
                className="flex w-full items-center gap-2.5 px-3 py-2 text-sm text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-secondary)] transition-colors"
              >
                <Plus size={14} />
                Create workspace
              </button>
            </div>
          </>
        )}
      </div>

      {/* Search */}
      <div className="p-3">
        <button
          className={`flex w-full items-center ${collapsed ? "justify-center" : "gap-2"} rounded-lg px-3 py-2 text-sm text-[var(--color-text-muted)] hover:bg-black/5`}
          title={collapsed ? "Search" : undefined}
          onClick={() => {
            navigate("/search");
          }}
        >
          <Search size={16} />
          {!collapsed && (
            <>
              <span>Search...</span>
              <kbd className="ml-auto rounded bg-black/5 px-1.5 py-0.5 text-xs">
                {platform === "darwin" ? "\u2318K" : "Ctrl+K"}
              </kbd>
            </>
          )}
        </button>
      </div>

      {/* Navigation */}
      <nav className="flex-1 space-y-1 px-3">
        {navItems.map(({ to, icon: Icon, label }) => {
          const isSyncNav = to === "/sync";
          // Use per-workspace sync status for the active workspace
          const activeWsSync = active ? wsSyncMap[active.id] : undefined;
          const wsHasPairs = (activeWsSync?.count ?? 0) > 0;
          const wsHasError = activeWsSync?.error ?? false;
          const wsPaused = activeWsSync?.paused ?? false;
          const wsRunning = activeWsSync?.syncing ?? false;
          const showPing = isSyncNav && wsHasPairs && (wsPaused || wsHasError);
          const showStartNow = isSyncNav && !wsHasPairs;
          const showRunning = isSyncNav && wsHasPairs && !wsPaused && !wsHasError;
          return (
            <NavLink
              key={to}
              to={to}
              title={collapsed ? label : undefined}
              className={({ isActive }) =>
                `relative flex items-center ${collapsed ? "justify-center" : "gap-3"} rounded-lg px-3 py-2 text-sm transition-colors ${
                  isActive
                    ? "bg-[var(--color-primary)]/10 font-medium text-[var(--color-primary)]"
                    : "text-[var(--color-text-secondary)] hover:bg-black/5"
                }`
              }
            >
              <span className="relative">
                <Icon size={18} />
                {showPing && (
                  <span className="absolute -right-1 -top-1 flex h-2.5 w-2.5">
                    <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-red-400 opacity-75" />
                    <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-red-500" />
                  </span>
                )}
              </span>
              {!collapsed && (
                <span className="flex-1">{label}</span>
              )}
              {!collapsed && showPing && (
                <span className="text-[10px] font-medium text-red-500">
                  {syncPaused ? "Paused" : "Error"}
                </span>
              )}
              {!collapsed && showRunning && (
                <span className="text-[10px] font-medium text-[var(--color-primary)]">
                  Running
                </span>
              )}
              {!collapsed && showStartNow && (
                <span className="text-[10px] font-medium text-[var(--color-primary)]">
                  Start now
                </span>
              )}
            </NavLink>
          );
        })}
      </nav>

      {/* Storage info */}
      <div className="px-3 pb-2">
        {collapsed ? (
          <div className="flex justify-center" title={`${formatBytes(storageUsed)} / ${formatBytes(storageCap)} (${storagePercent}%)`}>
            <HardDrive size={16} className="text-[var(--color-text-muted)]" />
          </div>
        ) : (
          <div className="rounded-lg bg-[var(--color-bg-tertiary)] px-3 py-2.5">
            <div className="mb-1.5 flex items-center justify-between">
              <div className="flex items-center gap-1.5 text-xs text-[var(--color-text-secondary)]">
                <HardDrive size={12} />
                Storage
              </div>
              <span className="text-xs font-medium">{storagePercent}%</span>
            </div>
            <div className="mb-1.5 h-1.5 rounded-full bg-[var(--color-border)]">
              <div
                className="h-1.5 rounded-full transition-all"
                style={{
                  width: `${Math.max(storagePercent, 1)}%`,
                  background: storagePercent > 90 ? "var(--color-danger)" : "var(--color-primary)",
                }}
              />
            </div>
            <p className="text-xs text-[var(--color-text-muted)]">
              {formatBytes(storageUsed)} / {formatBytes(storageCap)}
            </p>
          </div>
        )}
      </div>

      {/* User profile */}
      <div className="border-t p-3" style={{ borderColor: "var(--color-border)" }}>
        <div className={`flex items-center ${collapsed ? "justify-center" : "gap-3 rounded-lg px-3 py-2"}`}>
          <button
            onClick={() => navigate("/profile")}
            className={`flex items-center ${collapsed ? "" : "flex-1 gap-3 truncate"} hover:opacity-80 transition-opacity`}
            title={collapsed ? user?.name || "Profile" : "View profile"}
          >
            {user?.avatar_url ? (
              <img
                src={`${apiBase}/api/me/avatar`}
                alt={user.name}
                className="h-8 w-8 shrink-0 rounded-full object-cover"
              />
            ) : (
              <div
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-sm font-medium text-white"
                style={{ background: "var(--color-primary)" }}
              >
                {user?.name?.charAt(0).toUpperCase() || "?"}
              </div>
            )}
            {!collapsed && (
              <div className="flex-1 truncate text-left">
                <p className="truncate text-sm font-medium">{user?.name}</p>
                <p className="truncate text-xs text-[var(--color-text-muted)]">
                  {user?.email}
                </p>
              </div>
            )}
          </button>
          {!collapsed && (
            <button
              onClick={logout}
              className="rounded p-1.5 text-[var(--color-text-muted)] hover:bg-black/5 hover:text-[var(--color-danger)]"
              title="Log out"
            >
              <LogOut size={16} />
            </button>
          )}
        </div>
      </div>
      {/* Create Workspace Modal */}
      {showCreate && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30">
          <div
            className="w-full max-w-sm rounded-xl bg-[var(--color-bg)] p-6 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="mb-4 text-lg font-semibold">Create workspace</h3>
            {/* Preview */}
            <div className="mb-4 flex items-center gap-3">
              <div
                className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg text-sm font-bold text-white"
                style={{ background: newWsColor }}
              >
                {newWsName.trim()
                  ? newWsName.trim().split(/\s+/).map((w) => w[0]).join("").slice(0, 2).toUpperCase()
                  : "?"}
              </div>
              <input
                type="text"
                value={newWsName}
                onChange={(e) => setNewWsName(e.target.value)}
                onKeyDown={(e) =>
                  e.key === "Enter" && newWsName.trim() && createWsMut.mutate(newWsName.trim())
                }
                placeholder="Workspace name"
                autoFocus
                className="flex-1 rounded-lg border px-3 py-2 text-sm outline-none focus:border-[var(--color-primary)]"
                style={{ borderColor: "var(--color-border)" }}
              />
            </div>
            {/* Color picker */}
            <div className="mb-4">
              <p className="mb-2 text-xs font-medium text-[var(--color-text-secondary)]">Color</p>
              <div className="flex gap-2">
                {["#22c55e", "#7C3AED", "#2563EB", "#EA580C", "#059669", "#DB2777", "#1A1917"].map((c) => (
                  <button
                    key={c}
                    type="button"
                    onClick={() => setNewWsColor(c)}
                    className={`h-7 w-7 rounded-full transition-all ${newWsColor === c ? "ring-2 ring-offset-2" : "hover:scale-110"}`}
                    style={{ background: c, ringColor: c }}
                    aria-label={c}
                  />
                ))}
              </div>
            </div>
            <div className="flex justify-end gap-2">
              <button
                onClick={() => { setShowCreate(false); setNewWsName(""); setNewWsColor("#22c55e"); }}
                className="rounded-lg border px-4 py-2 text-sm"
                style={{ borderColor: "var(--color-border)" }}
              >
                Cancel
              </button>
              <button
                onClick={() => newWsName.trim() && createWsMut.mutate(newWsName.trim())}
                disabled={!newWsName.trim() || createWsMut.isPending}
                className="rounded-lg px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
                style={{ background: "var(--color-primary)" }}
              >
                {createWsMut.isPending ? "Creating..." : "Create"}
              </button>
            </div>
          </div>
          <div className="fixed inset-0 -z-10" onClick={() => { setShowCreate(false); setNewWsName(""); setNewWsColor("#22c55e"); }} />
        </div>
      )}
      </div>{/* end inner scrollable */}
    </aside>
  );
}
