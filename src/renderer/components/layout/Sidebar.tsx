import { useState, useEffect, useMemo, useRef, useCallback, useLayoutEffect } from "react";
import { NavLink, useNavigate, useLocation, useSearchParams } from "react-router-dom";
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
  ChevronRight,
  Check,
  Plus,
  HardDrive,
  PanelLeftClose,
  PanelLeftOpen,
  RefreshCw,
  Inbox,
  LayoutGrid,
  Layers,
  MapPin,
  Files,
  FileText,
  Video,
  Image as ImageIcon,
  Star,
  Trash2,
  EyeOff,
  Plug,
  type LucideIcon,
} from "lucide-react";
import type { Workspace } from "@dosya-dev/shared";
import { useAuth } from "@/lib/auth-context";
import { useWorkspace } from "@/lib/workspace-context";
import { useSyncPaused, useSyncPairs } from "@/lib/sync-store";
import { useAvatarVersion, avatarUrl } from "@/lib/avatar-version";
import { api, ApiError } from "@/lib/api-client";
import { usePermissions } from "@/lib/use-permissions";
import { ipc } from "@/lib/ipc";
import { formatBytes } from "@/lib/format";
import { activeFilter, filesHref, type FilterId } from "@/lib/files-params";
import { toast } from "sonner";

// `perm` is the page-access permission that reveals the entry. Those six
// access_* keys shipped in migration 0008 and were read by nothing anywhere -
// so a viewer with "Access Upload" off still saw Upload here and got a 403 on
// arrival. Entries with no `perm` (File requests, Groups, Sync) are not
// workspace pages governed by a page permission.

/**
 * The Files section's children.
 *
 * `filter` rows are views of the files browser and differ only by query string,
 * so they carry a FilterId rather than a path - filesHref() turns that into a
 * URL against wherever the user currently is. `route` rows are real pages that
 * happen to be about files, and belong here because that is where someone looks
 * for them, not because they share a URL.
 */
type FilesChild = {
  label: string;
  icon: LucideIcon;
  perm?: string;
  /** Render a separator above this row. */
  sep?: boolean;
} & ({ filter: FilterId; to?: never } | { to: string; filter?: never });

const FILES_CHILDREN: FilesChild[] = [
  { filter: "all", label: "All", icon: Files, perm: "access_files" },
  { filter: "documents", label: "Documents", icon: FileText, perm: "access_files" },
  { filter: "videos", label: "Videos", icon: Video, perm: "access_files" },
  { filter: "images", label: "Images", icon: ImageIcon, perm: "access_files" },
  // "Shared files" not "Shared": this is the files that HAVE a share link,
  // which is a different thing from the top-level Shared page listing the links
  // themselves. Two rows reading "Shared" on one sidebar would be a riddle.
  { filter: "shared", label: "Shared files", icon: Share2, perm: "access_files" },
  { filter: "favourites", label: "Favourites", icon: Star, perm: "access_files" },
  // Ungated: groups are per-user shortcuts, not a workspace resource, so there
  // is no access_* permission that governs them.
  { to: "/groups", label: "Groups", icon: Layers },
  { to: "/map", label: "Map", icon: MapPin, perm: "access_files" },
  { to: "/file-requests", label: "File requests", icon: Inbox },
  // The two destructive-adjacent views sit below a rule so they read as a
  // different kind of place than the type filters above them.
  { filter: "deleted", label: "Deleted", icon: Trash2, perm: "access_files", sep: true },
  { filter: "hidden", label: "Hidden", icon: EyeOff, perm: "access_files" },
];

/** Routes the Files section owns - used for auto-expand and parent highlight. */
const FILES_ROUTES = ["/files", "/groups", "/map", "/file-requests"];

type NavEntry =
  | { kind: "link"; to: string; icon: LucideIcon; label: string; perm?: string }
  | { kind: "files" };

const NAV_MAIN: NavEntry[] = [
  { kind: "link", to: "/dashboard", icon: LayoutDashboard, label: "Dashboard", perm: "access_dashboard" },
  { kind: "files" },
  { kind: "link", to: "/upload", icon: Upload, label: "Upload", perm: "access_upload" },
  { kind: "link", to: "/shared", icon: Share2, label: "Shared", perm: "access_shared" },
  { kind: "link", to: "/sync", icon: RefreshCw, label: "Sync" },
];

const NAV_WORKSPACE: NavEntry[] = [
  { kind: "link", to: "/integrations", icon: Plug, label: "Integrations" },
  { kind: "link", to: "/team", icon: Users, label: "Team", perm: "access_team" },
  { kind: "link", to: "/settings", icon: Settings, label: "Settings", perm: "access_settings" },
];

const FILES_OPEN_KEY = "dosya_sidebar_files_open";

/**
 * Width below which the sidebar drops to icons on its own.
 *
 * The window can now be dragged to 700px. At 260px the expanded sidebar would
 * take more than a third of that, so it collapses before the content has to.
 */
const NARROW_WINDOW = "(max-width: 1000px)";

function useNarrowWindow(): boolean {
  const [narrow, setNarrow] = useState(
    () => typeof window !== "undefined" && window.matchMedia(NARROW_WINDOW).matches,
  );
  useEffect(() => {
    const mq = window.matchMedia(NARROW_WINDOW);
    const onChange = (e: MediaQueryListEvent) => setNarrow(e.matches);
    mq.addEventListener("change", onChange);
    setNarrow(mq.matches);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  return narrow;
}

/** Tallest the collapsed-mode Files flyout is allowed to get, in px. */
const FLYOUT_MAX_H = 380;

export function Sidebar() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const { workspaces, active, setActive } = useWorkspace();
  const { can } = usePermissions();
  const queryClient = useQueryClient();
  const [wsOpen, setWsOpen] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [newWsName, setNewWsName] = useState("");
  const [newWsColor, setNewWsColor] = useState("#22c55e");
  // Two inputs decide this. The user's own choice, and the window being too
  // narrow to afford 260px of navigation - below that threshold a 700px window
  // would have had well under half its width left for actual content, so the
  // sidebar gives way first and the toggle is withdrawn rather than left as a
  // control that immediately undoes itself.
  const [userCollapsed, setUserCollapsed] = useState(false);
  const narrow = useNarrowWindow();
  const collapsed = userCollapsed || narrow;
  const [platform, setPlatform] = useState<string>("darwin");
  const [switchingWs, setSwitchingWs] = useState<Workspace | null>(null);

  // ── Files section ──────────────────────────────────────────
  const location = useLocation();
  const [searchParams] = useSearchParams();
  const onFilesPage = location.pathname === "/files";
  const inFilesSection = FILES_ROUTES.includes(location.pathname);
  const currentFilter = activeFilter(searchParams);

  // Shut on first run, and remembered after that.
  //
  // Nineteen rows of navigation do not fit the ~475px this sidebar gets at the
  // default window size, so an always-open tree pushes Shared, Sync and the
  // whole Workspace group below the fold. Shut, every destination is on screen
  // at once - which is the point of the section existing. There is deliberately
  // no auto-open on arrival: re-opening the tree every time you entered /files
  // would put you back under the fold for most of the session, and would
  // override a choice the user had already made.
  const [filesOpen, setFilesOpen] = useState(
    () => localStorage.getItem(FILES_OPEN_KEY) === "1",
  );
  const toggleFiles = useCallback((next: boolean) => {
    setFilesOpen(next);
    localStorage.setItem(FILES_OPEN_KEY, next ? "1" : "0");
  }, []);

  const visibleFilesChildren = useMemo(
    () => FILES_CHILDREN.filter((c) => !c.perm || can(c.perm)),
    [can],
  );

  // Collapsed (60px) has no room for a tree, so the Files icon opens a flyout
  // instead. Positioned fixed from the row's measured rect: the sidebar's inner
  // wrapper is overflow-hidden, which would clip an absolutely-positioned panel.
  const filesRowRef = useRef<HTMLButtonElement>(null);
  const [flyout, setFlyout] = useState<{ top: number; left: number } | null>(null);
  const openFlyout = () => {
    const r = filesRowRef.current?.getBoundingClientRect();
    if (!r) return;
    // Eleven rows is taller than the gap between this row and the bottom of a
    // minimum-height window, so pull the panel up rather than let it run off
    // the screen. It scrolls if even that isn't enough.
    const top = Math.max(8, Math.min(r.top, window.innerHeight - FLYOUT_MAX_H - 8));
    setFlyout({ top, left: r.right + 6 });
  };
  // Any navigation, or leaving collapsed mode, dismisses it.
  useEffect(() => { setFlyout(null); }, [location.pathname, location.search]);
  useEffect(() => { if (!collapsed) setFlyout(null); }, [collapsed]);

  // ── Sliding active pill ────────────────────────────────────
  // One indicator glides to whichever row is active instead of each row
  // switching its own background on and off, which is what makes moving
  // through the menu read as movement. Ported from apps/web's sidebar.
  //
  // Measured from the DOM rather than computed from the nav data: rows are
  // different heights (top-level vs child), the Files tree opens and closes,
  // and permissions hide entries - all of which the layout already knows and a
  // parallel calculation would have to duplicate and keep correct.
  const navRef = useRef<HTMLElement>(null);
  const [pill, setPill] = useState<
    { top: number; height: number; left: number; width: number } | null
  >(null);

  useLayoutEffect(() => {
    const measure = () => {
      const nav = navRef.current;
      if (!nav) return;
      const el = nav.querySelector<HTMLElement>("[data-active]");
      if (!el) { setPill(null); return; }
      const navRect = nav.getBoundingClientRect();
      const r = el.getBoundingClientRect();
      // Horizontal bounds are measured too, not fixed insets: child rows are
      // indented under Files, so a full-width pill would sit outside the row it
      // is meant to be highlighting.
      setPill({
        top: r.top - navRect.top + nav.scrollTop,
        height: r.height,
        left: r.left - navRect.left,
        width: r.width,
      });
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
    // filesOpen and collapsed change which row is active and how tall it is.
  }, [location.pathname, location.search, filesOpen, collapsed, visibleFilesChildren.length]);

  /** Where a Files child row points, given where the user is standing now. */
  const childHref = (c: FilesChild) =>
    c.filter ? filesHref(searchParams, onFilesPage, c.filter) : c.to!;

  /** Whether a Files child row is the view currently on screen. */
  const childActive = (c: FilesChild) =>
    c.filter ? onFilesPage && currentFilter === c.filter : location.pathname === c.to;

  // With the tree shut, the parent row is the only thing naming where you are,
  // and "Files" alone cannot tell Images from the trash. Name the view beside
  // it. "All" is the bare files page, so it needs no qualifier.
  const activeChild = visibleFilesChildren.find(childActive);
  const filesSuffix =
    !filesOpen && activeChild && activeChild.filter !== "all" ? activeChild.label : null;

  // Sync state now comes from the single shared store (see AppShell.init).
  const syncPaused = useSyncPaused();
  const syncPairs = useSyncPairs();

  /** Per-workspace sync summary: workspaceId → { syncing, error, paused, count } */
  const wsSyncMap = useMemo(() => {
    const map: Record<string, { syncing: boolean; error: boolean; paused: boolean; count: number }> = {};
    for (const p of syncPairs) {
      const wsId = p.workspaceId;
      if (!wsId) continue;
      if (!map[wsId]) map[wsId] = { syncing: false, error: false, paused: false, count: 0 };
      map[wsId].count++;
      if (p.status === "syncing") map[wsId].syncing = true;
      if (p.status === "error") map[wsId].error = true;
      if (p.status === "paused") map[wsId].paused = true;
    }
    return map;
  }, [syncPairs]);

  useEffect(() => {
    ipc.getPlatform().then(setPlatform);
  }, []);

  const [apiBase, setApiBase] = useState("");
  useEffect(() => {
    window.electronAPI.getApiBase().then(setApiBase);
  }, []);

  const avatarVersion = useAvatarVersion((s) => s.version);

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

  // Shared row treatments, so the three kinds of row (top-level link, Files
  // parent, Files child) can't drift apart on hover and active colours.
  //
  // The active row paints no background of its own: a single pill slides
  // between rows behind them (see the measuring effect above and the element
  // rendered inside <nav>). Two backgrounds would show as a flash of the old
  // one while the pill is still travelling.
  const ROW_ACTIVE = "font-medium text-[var(--color-primary)]";
  const ROW_IDLE = "text-[var(--color-text-secondary)] hover:bg-black/5";

  /** A Files child row, used by both the expanded tree and the collapsed flyout. */
  const renderFilesChild = (c: FilesChild) => (
    <div key={c.label}>
      {c.sep && <div className="my-1 h-px" style={{ background: "var(--color-border)" }} />}
      <button
        onClick={() => navigate(childHref(c))}
        data-testid={`nav-files-${c.filter ?? c.to!.slice(1)}`}
        data-active={childActive(c) ? "" : undefined}
        className={`relative z-10 flex w-full items-center gap-2.5 rounded-md px-2.5 py-1.5 text-xs transition-colors ${
          childActive(c) ? ROW_ACTIVE : ROW_IDLE
        }`}
      >
        <c.icon size={14} className="shrink-0" />
        <span className="truncate">{c.label}</span>
      </button>
    </div>
  );

  const renderNavEntry = (entry: NavEntry) => {
    if (entry.kind === "files") {
      if (visibleFilesChildren.length === 0) return null;
      // The child carries the highlight while the tree is open; the parent takes
      // it over when the tree is shut or the sidebar is collapsed, so "where am
      // I" is answered exactly once.
      const parentActive = inFilesSection && (collapsed || !filesOpen);
      return (
        <div key="files">
          <div
            data-active={parentActive ? "" : undefined}
            className={`relative z-10 flex items-center rounded-lg text-sm transition-colors ${parentActive ? ROW_ACTIVE : ROW_IDLE}`}
          >
            <button
              ref={filesRowRef}
              data-testid="nav-files"
              title={collapsed ? "Files" : undefined}
              onClick={() => {
                if (collapsed) { flyout ? setFlyout(null) : openFlyout(); return; }
                if (!filesOpen) toggleFiles(true);
                if (can("access_files")) navigate(filesHref(searchParams, onFilesPage, "all"));
              }}
              className={`flex flex-1 items-center ${collapsed ? "justify-center" : "gap-3"} rounded-lg px-3 py-2`}
            >
              <FolderOpen size={18} className="shrink-0" />
              {!collapsed && (
                <span className="flex-1 truncate text-left">
                  Files
                  {filesSuffix && (
                    <span className="text-[var(--color-text-muted)]"> · {filesSuffix}</span>
                  )}
                </span>
              )}
            </button>
            {!collapsed && (
              <button
                data-testid="nav-files-toggle"
                onClick={() => toggleFiles(!filesOpen)}
                aria-expanded={filesOpen}
                aria-label={filesOpen ? "Collapse Files" : "Expand Files"}
                className="mr-1 rounded p-1.5 hover:bg-black/10"
              >
                <ChevronRight size={13} className={`transition-transform ${filesOpen ? "rotate-90" : ""}`} />
              </button>
            )}
          </div>
          {!collapsed && filesOpen && (
            <div
              className="ml-[18px] mt-0.5 space-y-0.5 border-l pl-2.5"
              style={{ borderColor: "var(--color-border)" }}
            >
              {visibleFilesChildren.map((c) => renderFilesChild(c))}
            </div>
          )}
        </div>
      );
    }

    const { to, icon: Icon, label, perm } = entry;
    if (perm && !can(perm)) return null;

    const isSyncNav = to === "/sync";
    // Use per-workspace sync status for the active workspace
    const activeWsSync = active ? wsSyncMap[active.id] : undefined;
    const wsHasPairs = (activeWsSync?.count ?? 0) > 0;
    const wsHasError = activeWsSync?.error ?? false;
    const wsPaused = activeWsSync?.paused ?? false;
    const showPing = isSyncNav && wsHasPairs && (wsPaused || wsHasError);
    const showStartNow = isSyncNav && !wsHasPairs;
    const showRunning = isSyncNav && wsHasPairs && !wsPaused && !wsHasError;
    const linkActive = location.pathname === to;
    return (
      <NavLink
        key={to}
        to={to}
        title={collapsed ? label : undefined}
        data-testid={`nav-${to.slice(1)}`}
        data-active={linkActive ? "" : undefined}
        className={`relative z-10 flex items-center ${collapsed ? "justify-center" : "gap-3"} rounded-lg px-3 py-2 text-sm transition-colors ${
          linkActive ? ROW_ACTIVE : ROW_IDLE
        }`}
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
        {!collapsed && <span className="flex-1">{label}</span>}
        {!collapsed && showPing && (
          <span className="text-[10px] font-medium text-red-500">
            {syncPaused ? "Paused" : "Error"}
          </span>
        )}
        {!collapsed && showRunning && (
          <span className="text-[10px] font-medium text-[var(--color-primary)]">Running</span>
        )}
        {!collapsed && showStartNow && (
          <span className="text-[10px] font-medium text-[var(--color-primary)]">Start now</span>
        )}
      </NavLink>
    );
  };

  const workspaceRows = NAV_WORKSPACE.map(renderNavEntry).filter(Boolean);

  return (
    <>
    {switchingWs && (
      <div className="fixed inset-0 z-[9999] flex flex-col items-center justify-center gap-4 bg-[var(--color-bg)]">
        <div
          className="flex h-16 w-16 items-center justify-center rounded-2xl text-xl font-bold text-white"
          style={{ background: switchingWs.icon_color || "var(--color-primary)" }}
        >
          {switchingWs.icon_initials}
        </div>
        <div className="text-center">
          <p className="text-sm font-semibold">{switchingWs.name}</p>
          <p className="mt-1 flex items-center justify-center gap-1.5 text-xs text-[var(--color-text-muted)]">
            <span className="h-3 w-3 animate-spin rounded-full border-2 border-[var(--color-primary)] border-t-transparent" />
            Switching workspace…
          </p>
        </div>
      </div>
    )}
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
      {/* Collapse toggle - sits on the sidebar/content border, near the user
          profile. Withdrawn while the window is narrow: the width, not the
          user, is deciding there, and a button that expanded the sidebar only
          for it to snap shut again would be a control that lies. */}
      {!narrow && (
        <button
          data-testid="sidebar-collapse-toggle"
          onClick={() => setUserCollapsed((v) => !v)}
          className="absolute z-30 flex h-6 w-6 items-center justify-center rounded-full border bg-[var(--color-bg)] text-[var(--color-text-muted)] shadow-sm hover:bg-[var(--color-bg-secondary)] hover:text-[var(--color-text)] transition-colors"
          style={{
            borderColor: "var(--color-border)",
            right: -12,
            bottom: 42,
          }}
          title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
        >
          {collapsed ? <PanelLeftOpen size={12} /> : <PanelLeftClose size={12} />}
        </button>
      )}

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
                      setWsOpen(false);
                      if (ws.id === active?.id) return;
                      setSwitchingWs(ws);
                      setActive(ws);
                      window.setTimeout(() => setSwitchingWs(null), 2000);
                    }}
                    className="flex w-full items-center gap-2.5 px-3 py-2 text-sm hover:bg-[var(--color-bg-secondary)] transition-colors"
                  >
                    <div
                      className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-xs font-semibold text-white"
                      style={{ background: ws.icon_color || "var(--color-primary)" }}
                    >
                      {ws.icon_initials}
                    </div>
                    <div className="min-w-0 flex-1 text-left">
                      <span className="block truncate">{ws.name}</span>
                      {ws.storage && ws.storage.total > 0 && (
                        <span className="block truncate text-[10px] leading-tight text-[var(--color-text-muted)]">
                          {formatBytes(Math.max(0, ws.storage.total - ws.storage.used))} free of {formatBytes(ws.storage.total)}
                        </span>
                      )}
                    </div>
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
                  navigate("/workspaces");
                }}
                className="flex w-full items-center gap-2.5 px-3 py-2 text-sm text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-secondary)] transition-colors"
              >
                <LayoutGrid size={14} />
                Workspace dashboard
              </button>
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

      {/* Navigation. Scrolls on its own: the Files tree can outgrow a short
          window, and the storage widget and profile below must stay put. */}
      <nav ref={navRef} className="relative flex-1 space-y-1 overflow-y-auto px-3">
        {/* The pill itself. Rows sit above it (z-10) and paint no background of
            their own, so this is the only active surface on screen and it
            travels rather than blinking between rows. `motion-reduce` drops the
            travel for anyone who has asked the OS for less movement - the pill
            still lands in the right place, it just gets there instantly. */}
        {pill && (
          <div
            aria-hidden
            className="pointer-events-none absolute rounded-lg bg-[var(--color-primary)]/10 transition-[top,height,left,width] duration-200 ease-out motion-reduce:transition-none"
            style={{ top: pill.top, height: pill.height, left: pill.left, width: pill.width }}
          />
        )}
        {NAV_MAIN.map(renderNavEntry)}

        {workspaceRows.length > 0 && (
          <div className="pt-3">
            {collapsed ? (
              <div className="mx-2 mb-2 h-px" style={{ background: "var(--color-border)" }} />
            ) : (
              <p className="px-3 pb-1 text-[11px] font-medium uppercase tracking-wide text-[var(--color-text-muted)]">
                Workspace
              </p>
            )}
            <div className="space-y-1">{workspaceRows}</div>
          </div>
        )}
      </nav>

      {/* Collapsed-mode Files flyout. Fixed-positioned from the row's measured
          rect - the sidebar's inner wrapper is overflow-hidden, so an absolutely
          positioned panel would be clipped at 60px wide. */}
      {flyout && collapsed && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setFlyout(null)} />
          <div
            data-testid="nav-files-flyout"
            className="anim-pop-in fixed z-50 w-52 overflow-y-auto rounded-lg border p-1.5 shadow-lg"
            style={{
              top: flyout.top,
              left: flyout.left,
              maxHeight: FLYOUT_MAX_H,
              transformOrigin: "top left",
              borderColor: "var(--color-border)",
              background: "var(--color-bg)",
            }}
          >
            <p className="px-2.5 pb-1 pt-0.5 text-[10px] font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">
              Files
            </p>
            {visibleFilesChildren.map((c) => renderFilesChild(c))}
          </div>
        </>
      )}

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
              <SidebarAvatar
                key={`${user.id}-${avatarVersion}`}
                src={avatarUrl(apiBase, user.id, avatarVersion)}
                name={user.name}
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
                    style={{ background: c, "--tw-ring-color": c } as React.CSSProperties}
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
    </>
  );
}

// A failed avatar fetch must degrade to initials, not to the browser's
// broken-image glyph; keyed by user+version so a new upload retries the image.
function SidebarAvatar({ src, name }: { src: string; name: string | undefined }) {
  const [failed, setFailed] = useState(false);
  if (failed) {
    return (
      <div
        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-sm font-medium text-white"
        style={{ background: "var(--color-primary)" }}
      >
        {name?.charAt(0).toUpperCase() || "?"}
      </div>
    );
  }
  return (
    <img
      src={src}
      alt={name ?? "Profile"}
      className="h-8 w-8 shrink-0 rounded-full object-cover"
      onError={() => setFailed(true)}
    />
  );
}
