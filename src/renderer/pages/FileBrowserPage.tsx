import { useState, useCallback, useEffect, useMemo, useRef } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useQuery, useMutation, useQueryClient, keepPreviousData } from "@tanstack/react-query";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  ChevronRight,
  LayoutGrid,
  LayoutList,
  Plus,
  Search,
  Upload,
  Download,
  Trash2,
  Share2,
  Star,
  MoreHorizontal,
  Lock,
  Pencil,
  Copy,
  Move,
  Eye,
  EyeOff,
  FolderOpen,
  Info,
  History,
  MessageCircle,
  FileArchive,
  Link2,
  ExternalLink,
  SlidersHorizontal,
  RotateCcw,
  Loader2,
  SquarePen,
} from "lucide-react";
import { api, apiBase, ApiError } from "@/lib/api-client";
import { useWorkspace } from "@/lib/workspace-context";
import { usePermissions } from "@/lib/use-permissions";
import { formatBytes, formatDate } from "@/lib/format";
import { activeFilter as readActiveFilter } from "@/lib/files-params";
import { timeAgo, extOf, colorFor, originLabel, isOfficeFile, hiddenTitle, kindLabel, regionLabel } from "@/lib/file-type";
import { toast } from "sonner";
import { FileIcon, FolderIcon, fileIconSrc } from "@/components/files/FileIcon";
import { FileViewer, downloadViaDialog, type ViewerFile } from "@/components/files/FileViewer";
import { FilePreviewImage } from "@/components/files/FilePreviewImage";
import { FileDetailPanel } from "@/components/files/FileDetailPanel";
import { ShareModal, type ShareTarget } from "@/components/files/ShareModal";
import { LockModal } from "@/components/files/LockModal";
import { HideModal } from "@/components/files/HideModal";
import { FileInfoDialog, type InfoTarget } from "@/components/files/FileInfoDialog";
import { OriginBadge } from "@/components/files/OriginBadge";
import { Modal } from "@/components/files/Modal";

interface FolderRow {
  id: string;
  name: string;
  created_at: number;
  updated_at: number;
  file_count: number;
  lock_mode: string;
  is_hidden: number;
  /** Who `is_hidden` hides this from - "none" | "everyone" | "users" | "roles". */
  hidden_mode: string;
  is_synced: number;
  total_size_bytes: number;
  content_updated_at: number;
  region: string | null;
  uploader_name: string | null;
  share_count: number;
  comment_count: number;
  origin: string | null;
}

interface FileRow extends ViewerFile {
  uploaded_by: string;
  is_synced: number;
}

interface FilesResponse {
  ok: boolean;
  folders: FolderRow[];
  files: FileRow[];
  breadcrumbs: { id: string; name: string }[];
  pagination: {
    page: number;
    per_page: number;
    total_files: number;
    total_pages: number;
  };
  can_lock: boolean;
  can_hide: boolean;
  folder_view_only: boolean;
}

type ViewMode = "table" | "card";

// ── Table columns (web parity) ─────────────────────────────

type ColumnKey =
  | "name" | "size" | "created" | "modified" | "type" | "extension"
  | "version" | "uploader" | "region" | "origin" | "shares" | "comments";

interface ColumnDef {
  key: ColumnKey;
  label: string;
  defaultVisible: boolean;
  /** Fixed column width in px. Omitted only for `name`, which takes the rest. */
  width?: number;
  render: (f: FileRow) => React.ReactNode;
  renderFolder?: (f: FolderRow) => React.ReactNode;
}

/**
 * Widths are px, not Tailwind classes, because the table needs to add them up.
 *
 * Turning on every column used to crush twelve of them into whatever the window
 * was, wrapping MIME types over three lines and leaving the header unreadable.
 * The table now declares `min-width` = these widths + a floor for Name, so once
 * the columns no longer fit the container scrolls sideways instead of
 * compressing. See the colgroup in the table below.
 */
const NAME_COL_MIN = 260;
const CHECKBOX_COL = 32;
const ACTIONS_COL = 40;

const ALL_COLUMNS: ColumnDef[] = [
  { key: "name", label: "Name", defaultVisible: true, render: () => null /* handled separately */ },
  { key: "size", label: "Size", defaultVisible: true, width: 88, render: (f) => formatBytes(f.size_bytes), renderFolder: (f) => formatBytes(f.total_size_bytes ?? 0) },
  { key: "created", label: "Created", defaultVisible: true, width: 104, render: (f) => timeAgo(f.created_at), renderFolder: (f) => timeAgo(f.created_at) },
  { key: "modified", label: "Modified", defaultVisible: false, width: 104, render: (f) => timeAgo(f.updated_at), renderFolder: (f) => timeAgo(f.content_updated_at ?? f.created_at) },
  // The raw MIME type was unreadable at any column width
  // ("application/vnd.openxmlformats-officedocument.wordprocessingml.document").
  // A category rather than the extension, because Extension is its own column
  // and two columns reading "DOCX" would waste one of them. The full MIME type
  // is still on hover, via the title attribute this cell carries.
  { key: "type", label: "Type", defaultVisible: false, width: 96, render: (f) => kindLabel(f.name), renderFolder: () => "Folder" },
  { key: "extension", label: "Extension", defaultVisible: false, width: 88, render: (f) => (f.extension || extOf(f.name) || "-").toUpperCase() },
  { key: "version", label: "Version", defaultVisible: false, width: 80, render: (f) => (f.current_version ?? 1) > 1 ? `v${f.current_version}` : "-" },
  { key: "uploader", label: "Uploader", defaultVisible: false, width: 120, render: (f) => f.uploader_name ?? "-", renderFolder: (f) => f.uploader_name ?? "-" },
  // regionLabel already existed and turns "ap-southeast-2" into "Sydney" - the
  // raw code was both wider and less useful.
  { key: "region", label: "Region", defaultVisible: true, width: 112, render: (f) => f.region ? regionLabel(f.region) : "-", renderFolder: (f) => f.region ? regionLabel(f.region) : "-" },
  { key: "origin", label: "Origin", defaultVisible: true, width: 88, render: (f) => originLabel(f.origin), renderFolder: (f) => originLabel(f.origin) },
  { key: "shares", label: "Shares", defaultVisible: false, width: 72, render: (f) => f.share_count > 0 ? String(f.share_count) : "-", renderFolder: (f) => f.share_count > 0 ? String(f.share_count) : "-" },
  { key: "comments", label: "Comments", defaultVisible: false, width: 88, render: (f) => f.comment_count > 0 ? String(f.comment_count) : "-", renderFolder: (f) => f.comment_count > 0 ? String(f.comment_count) : "-" },
];

const DEFAULT_VISIBLE: Set<ColumnKey> = new Set(ALL_COLUMNS.filter((c) => c.defaultVisible).map((c) => c.key));

function loadSavedColumns(): Set<ColumnKey> {
  try {
    const saved = localStorage.getItem("dosya_table_columns");
    if (saved) return new Set(JSON.parse(saved) as ColumnKey[]);
  } catch {}
  return new Set(DEFAULT_VISIBLE);
}

const VIEW_STORAGE_KEY = "dosya_files_view";

function loadSavedView(): ViewMode {
  const saved = localStorage.getItem(VIEW_STORAGE_KEY);
  return saved === "table" || saved === "card" ? saved : "table";
}

export function FileBrowserPage() {
  const { active } = useWorkspace();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();

  // Get synced folder IDs to show sync badge
  const [syncedFolderIds, setSyncedFolderIds] = useState<Set<string>>(new Set());
  useEffect(() => {
    window.electronAPI.getSyncConfig?.()
      .then((config: any) => {
        const ids = new Set<string>();
        for (const pair of config?.pairs ?? []) {
          if (pair.workspaceId === active?.id && pair.remoteFolderId) {
            ids.add(pair.remoteFolderId);
          }
        }
        setSyncedFolderIds(ids);
      })
      .catch(() => {});
  }, [active?.id]);

  const { can, userId: currentUserId } = usePermissions();

  const folderId = searchParams.get("folder") || "";
  const filter = searchParams.get("filter") || "all";
  const sort = searchParams.get("sort") || "newest";
  const search = searchParams.get("q") || "";
  const page = parseInt(searchParams.get("page") || "1", 10);
  const showDeleted = searchParams.get("deleted") === "1";
  const showHidden = searchParams.get("hidden") === "1";

  // Which view is on screen. Read through the shared helper so this page and the
  // sidebar that now selects the view agree on what the query string means.
  const activeFilter = readActiveFilter(searchParams);

  const [viewMode, setViewModeState] = useState<ViewMode>(loadSavedView);
  const setViewMode = (m: ViewMode) => {
    setViewModeState(m);
    localStorage.setItem(VIEW_STORAGE_KEY, m);
  };
  const [visibleColumns, setVisibleColumns] = useState<Set<ColumnKey>>(loadSavedColumns);
  const [columnPickerOpen, setColumnPickerOpen] = useState(false);
  const toggleColumn = (key: ColumnKey) => {
    if (key === "name") return; // name is always visible
    setVisibleColumns((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      localStorage.setItem("dosya_table_columns", JSON.stringify([...next]));
      return next;
    });
  };

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [selectedFolders, setSelectedFolders] = useState<Set<string>>(new Set());
  const [searchInput, setSearchInput] = useState(search);
  const [dragging, setDragging] = useState(false);
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    item: { id: string; name: string; kind: "file" | "folder" };
  } | null>(null);
  const [showCreateFolder, setShowCreateFolder] = useState(false);
  const [newFolderName, setNewFolderName] = useState("");
  const [renameItem, setRenameItem] = useState<{ id: string; name: string; kind: "file" | "folder" } | null>(null);
  const [renameName, setRenameName] = useState("");
  const [moveTarget, setMoveTarget] = useState<{ id: string; name: string; kind: "file" | "folder" } | null>(null);
  const [bulkMoveIds, setBulkMoveIds] = useState<string[] | null>(null);
  const [bulkMoveFolderIds, setBulkMoveFolderIds] = useState<string[] | null>(null);
  const [copyTarget, setCopyTarget] = useState<{ id: string; name: string } | null>(null);
  const [pickerFolder, setPickerFolder] = useState<string | null>(null);
  // `permanent`/`fileCount` are only set by the trash view's row-level
  // "Delete permanently" (context menu), which reuses this same dialog with
  // different, unmistakably-irreversible copy instead of a second dialog.
  const [deleteConfirm, setDeleteConfirm] = useState<{ ids: string[]; names: string[]; kinds: ("file" | "folder")[]; bulk?: boolean; folderIds?: string[]; permanent?: boolean; fileCount?: number } | null>(null);

  // Viewer + detail panel + modals (web parity)
  const [viewerFile, setViewerFile] = useState<FileRow | null>(null);
  const [panel, setPanel] = useState<{ file: FileRow; tab: "info" | "comments" } | null>(null);
  const [shareTarget, setShareTarget] = useState<{ target: ShareTarget; name: string } | null>(null);
  const [lockTarget, setLockTarget] = useState<{ id: string; name: string; type: "file" | "folder" } | null>(null);
  const [hideTarget, setHideTarget] = useState<{ id: string; name: string; type: "file" | "folder" } | null>(null);
  const [infoTarget, setInfoTarget] = useState<InfoTarget | null>(null);
  const [versionUploadTarget, setVersionUploadTarget] = useState<string | null>(null);
  // Holds the id for the hidden input's change handler after we clear the state
  // (see the trigger effect below), so re-selecting the SAME file after
  // cancelling the OS picker still re-fires the picker.
  const versionUploadTargetRef = useRef<string | null>(null);

  // Uploads started from this page must not outlive it. The PUT fetches get
  // this signal so logout/navigation aborts them, and pageAliveRef gates the
  // result toasts - the app-root <Toaster> outlives this page, so without the
  // gate an upload finishing after logout pops a toast on the login screen.
  const pageAliveRef = useRef(true);
  const uploadAbortRef = useRef<AbortController | null>(null);
  useEffect(() => {
    pageAliveRef.current = true;
    uploadAbortRef.current = new AbortController();
    return () => {
      pageAliveRef.current = false;
      uploadAbortRef.current?.abort();
    };
  }, []);

  // Favourites
  const [favourites, setFavourites] = useState<Set<string>>(new Set());

  // Unlock gate - unlocked file IDs (fileId → unlock_token) and the pending prompt.
  // Updated immutably so memo/callback dependents (selectableFiles,
  // openFileWithLockCheck) recompute after a file is unlocked.
  const [unlockedFiles, setUnlockedFiles] = useState(() => new Map<string, string>());
  const [unlockPrompt, setUnlockPrompt] = useState<{ file: FileRow; action: "detail" | "view" } | null>(null);
  const [unlockPassword, setUnlockPassword] = useState("");
  const [unlockError, setUnlockError] = useState("");
  const [unlocking, setUnlocking] = useState(false);

  // Guards the one-shot restore of ?view=/?panel= from the URL on first load.
  const openRestored = useRef(false);

  /** Open state of the collapsed-breadcrumb "…" menu. */
  const [crumbsOpen, setCrumbsOpen] = useState(false);

  const { data, isLoading } = useQuery({
    queryKey: ["files", active?.id, folderId, filter, sort, search, page, showDeleted, showHidden],
    queryFn: () => {
      const params = new URLSearchParams({
        workspace_id: active!.id,
        page: String(page),
        per_page: "100",
        sort,
        filter: showDeleted ? "all" : filter === "shared" || filter === "favourites" ? "all" : filter,
      });
      if (folderId && !showDeleted) params.set("folder_id", folderId);
      if (search) params.set("q", search);
      if (showDeleted) params.set("deleted", "1");
      if (showHidden) params.set("hidden", "1");
      return api.get<FilesResponse>(`/api/files?${params}`);
    },
    enabled: !!active,
    placeholderData: keepPreviousData,
    // Shorter than the app-wide default on purpose. Every other cache only
    // changes when this window changes it; this listing can also change from
    // underneath - another device, or a teammate.
    //
    // Local sync no longer relies on this: sync-store invalidates ["files"] the
    // moment a pair stops syncing. What a minute still bounds is the case
    // nothing here can observe at all - a change made somewhere else entirely -
    // while keeping ordinary back-and-forth navigation instant.
    staleTime: 60_000,
  });

  const navigateToFolder = useCallback(
    (id: string) => {
      // Trashed folders aren't browsable - the API only lists trash roots flat,
      // so browsing into one would land on a view the app can't populate.
      if (showDeleted) return;
      clearSelection();
      setSearchParams({ folder: id });
    },
    [setSearchParams, showDeleted],
  );

  const setSort = (s: string) => {
    const p = new URLSearchParams(searchParams);
    p.set("sort", s);
    setSearchParams(p);
  };

  const doSearch = () => {
    const p = new URLSearchParams(searchParams);
    if (searchInput) p.set("q", searchInput);
    else p.delete("q");
    p.delete("page");
    setSearchParams(p);
  };

  const toggleSelect = (id: string) => {
    const file = allFiles.find((f) => f.id === id);
    if (file?.lock_mode === "full_lock" && !unlockedFiles.has(id)) return;
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleSelectFolder = (id: string) => {
    setSelectedFolders((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const refresh = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ["files"] });
  }, [queryClient]);

  // ── Favourites ─────────────────────────────────────────────

  const loadFavourites = useCallback(async () => {
    if (!active?.id) return;
    try {
      const res = await api.get<{ ok: boolean; files?: { file_id: string }[] }>(`/api/favourites?workspace_id=${active.id}`);
      if (res.ok && res.files) setFavourites(new Set(res.files.map((f) => f.file_id)));
    } catch { /* optional feature */ }
  }, [active?.id]);
  useEffect(() => { loadFavourites(); }, [loadFavourites]);

  const toggleFavourite = async (fileId: string) => {
    if (!active?.id) return;
    const isFav = favourites.has(fileId);
    try {
      if (isFav) {
        await api.delete(`/api/favourites?workspace_id=${active.id}&file_id=${fileId}`);
        setFavourites((prev) => { const next = new Set(prev); next.delete(fileId); return next; });
      } else {
        await api.post("/api/favourites", { file_id: fileId, workspace_id: active.id });
        setFavourites((prev) => new Set(prev).add(fileId));
      }
    } catch {
      toast.error("Something went wrong", { description: "Could not update favourites." });
    }
  };

  // ── Open with lock gate (web parity) ───────────────────────

  const openFileWithLockCheck = useCallback((file: FileRow, action: "detail" | "view") => {
    if (showDeleted && action === "detail") {
      // Trash view is read-only for row activation: no detail panel means no
      // reachable "Delete file" button and no live Delete/Backspace shortcut
      // (both gated on `panel`, which now never gets set here). A plain
      // click just selects the row; Restore/Delete permanently only happen
      // through the trash context menu built for this view.
      toggleSelect(file.id);
      return;
    }
    if (file.lock_mode === "full_lock" && !unlockedFiles.has(file.id)) {
      setUnlockPrompt({ file, action });
      setUnlockPassword("");
      setUnlockError("");
      return;
    }
    if (action === "detail") setPanel({ file, tab: "info" });
    else setViewerFile(file);
  }, [unlockedFiles, showDeleted]);

  const handleUnlockSubmit = async () => {
    if (!unlockPrompt || !unlockPassword.trim()) return;
    setUnlocking(true);
    setUnlockError("");
    try {
      const res = await api.post<{ ok: boolean; unlock_token?: string; error?: string }>(
        `/api/files/${unlockPrompt.file.id}/unlock`,
        { password: unlockPassword },
      );
      if (res.ok && res.unlock_token) {
        setUnlockedFiles((prev) => new Map(prev).set(unlockPrompt.file.id, res.unlock_token!));
        const { file, action } = unlockPrompt;
        setUnlockPrompt(null);
        if (action === "detail") setPanel({ file, tab: "info" });
        else setViewerFile(file);
      } else {
        setUnlockError(res.error ?? "Incorrect password");
        setUnlockPassword("");
      }
    } catch (err) {
      setUnlockError(err instanceof ApiError ? err.message : "Can't reach the server. Check your connection and try again.");
      if (err instanceof ApiError) setUnlockPassword("");
    }
    setUnlocking(false);
  };

  // ── Mutations ──────────────────────────────────────────────

  const deleteMut = useMutation({
    mutationFn: ({ id, kind }: { id: string; kind: "file" | "folder" }) =>
      api.delete(`/api/${kind === "folder" ? "folders" : "files"}/${id}`),
    onSuccess: () => {
      refresh();
    },
  });

  const createFolderMut = useMutation({
    mutationFn: (name: string) =>
      api.post("/api/folders", {
        workspace_id: active!.id,
        name,
        parent_id: folderId || null,
      }),
    onSuccess: () => {
      refresh();
      setShowCreateFolder(false);
      setNewFolderName("");
      toast.success("Folder created");
    },
  });

  const renameMut = useMutation({
    mutationFn: ({ id, name, kind }: { id: string; name: string; kind: string }) =>
      api.put(`/api/${kind === "folder" ? "folders" : "files"}/${id}/rename`, { name }),
    onSuccess: () => {
      refresh();
      setRenameItem(null);
      toast.success("Renamed");
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : "Rename failed"),
  });

  const moveMut = useMutation({
    mutationFn: ({ id, kind, targetId }: { id: string; kind: "file" | "folder"; targetId: string | null }) => {
      if (kind === "folder") {
        return api.put(`/api/folders/${id}/move`, { parent_id: targetId });
      }
      return api.put(`/api/files/${id}/move`, { folder_id: targetId });
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : "Move failed"),
  });

  const copyMut = useMutation({
    mutationFn: ({ id, targetId }: { id: string; targetId: string | null }) =>
      api.post(`/api/files/${id}/copy`, { folder_id: targetId }),
    onSuccess: () => {
      refresh();
      setCopyTarget(null);
      setPickerFolder(null);
      toast.success("Copied successfully");
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : "Copy failed"),
  });

  // Folder tree for picker modal
  const { data: folderTreeData } = useQuery({
    queryKey: ["folders-tree", active?.id],
    queryFn: () =>
      api.get<{ ok: boolean; folders: { id: string; name: string; parent_id: string | null; file_count: number }[] }>(
        `/api/folders/tree?workspace_id=${active?.id}`,
      ),
    enabled: !!active && (!!moveTarget || !!copyTarget || !!bulkMoveIds || !!bulkMoveFolderIds),
  });

  const openFileInSystemApp = useCallback(async (fileId: string, fileName: string) => {
    try {
      await window.electronAPI.openFile(fileId, fileName);
    } catch {
      toast.error("Failed to open file");
    }
  }, []);

  const allFolders = data?.folders ?? [];
  const allFiles = data?.files ?? [];
  const breadcrumbs = data?.breadcrumbs ?? [];

  // How many trailing folders stay on the trail before the middle collapses.
  // Two ancestors plus where you are: enough to keep your bearings, few enough
  // that the toolbar never has to fight the path for width.
  const MAX_VISIBLE_CRUMBS = 3;
  const hiddenCrumbs =
    breadcrumbs.length > MAX_VISIBLE_CRUMBS
      ? breadcrumbs.slice(0, breadcrumbs.length - MAX_VISIBLE_CRUMBS)
      : [];
  const shownCrumbs =
    hiddenCrumbs.length > 0 ? breadcrumbs.slice(-MAX_VISIBLE_CRUMBS) : breadcrumbs;
  const pagination = data?.pagination;

  // can_lock / can_hide have been in this response type since the file was
  // written and were never read, so Lock and Hide were offered to every role
  // while only an owner's clicks worked. Default false, not true: the endpoint
  // refuses anyway, and offering a locked door is the defect being fixed.
  const canLock = data?.can_lock ?? false;
  const canHide = data?.can_hide ?? false;

  /**
   * Whether Delete should be offered for one file, mirroring what
   * files/[id]/index.ts checks: delete_any_file covers everything, otherwise
   * delete_own_files covers only this member's own uploads.
   */
  const canDeleteFile = (f: { uploaded_by?: string } | null | undefined): boolean => {
    if (can("delete_any_file")) return true;
    return can("delete_own_files") && !!f && f.uploaded_by === currentUserId;
  };

  // Client-side chips - "shared" shows only files with share links, "favourites"
  // only starred files (both hide folders, like the web sidebar's views).
  const folders = activeFilter === "shared" || activeFilter === "favourites" ? [] : allFolders;
  const files =
    activeFilter === "shared" ? allFiles.filter((f) => f.share_count > 0)
    : activeFilter === "favourites" ? allFiles.filter((f) => favourites.has(f.id))
    : allFiles;

  const selectableFiles = useMemo(
    () => files.filter((f) => f.lock_mode !== "full_lock" || unlockedFiles.has(f.id)),
    [files, unlockedFiles],
  );

  const selectAll = useCallback(() => {
    setSelected(new Set(selectableFiles.map((f) => f.id)));
    setSelectedFolders(new Set(folders.map((f) => f.id)));
  }, [selectableFiles, folders]);
  const clearSelection = useCallback(() => {
    setSelected(new Set());
    setSelectedFolders(new Set());
  }, []);
  const totalSelected = selected.size + selectedFolders.size;

  // ── Deep links: ?view=<id> / ?panel=<id> (web parity) ──────

  useEffect(() => {
    if (openRestored.current || isLoading || !data) return;
    const viewId = searchParams.get("view");
    const panelId = searchParams.get("panel");
    const id = viewId || panelId;
    const action: "view" | "detail" = viewId ? "view" : "detail";
    if (!id) { openRestored.current = true; return; }
    const inList = allFiles.find((f) => f.id === id);
    if (inList) { openFileWithLockCheck(inList, action); openRestored.current = true; return; }
    let cancelled = false;
    (async () => {
      try {
        const res = await api.get<{ ok: boolean; file?: FileRow }>(`/api/files/${id}`);
        if (!cancelled && res.ok && res.file) openFileWithLockCheck(res.file, action);
      } catch { /* stale/deleted file - the mirror effect will drop the param */ }
      finally { if (!cancelled) openRestored.current = true; }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isLoading, data]);

  // Mirror the open viewer/panel into the URL so it survives a reload.
  useEffect(() => {
    if (!openRestored.current) return;
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      if (viewerFile) { next.set("view", viewerFile.id); next.delete("panel"); }
      else if (panel) { next.set("panel", panel.file.id); next.delete("view"); }
      else { next.delete("view"); next.delete("panel"); }
      return next.toString() === prev.toString() ? prev : next;
    }, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewerFile, panel]);

  // ── Upload plumbing (drag-and-drop + new version) ──────────

  const uploadFiles = useCallback(async (dropped: FileList | File[]) => {
    if (!active?.id) return { uploaded: 0, failed: 0 };
    let uploaded = 0;
    let failed = 0;
    for (const file of Array.from(dropped)) {
      try {
        const initRes = await api.post<{ ok: boolean; session_id?: string; error?: string }>("/api/upload/init", {
          workspace_id: active.id,
          file_name: file.name,
          file_size: file.size,
          mime_type: file.type || "application/octet-stream",
          folder_id: folderId || null,
        });
        if (!initRes.ok || !initRes.session_id) { failed++; continue; }
        const res = await fetch(`${apiBase()}/api/upload/${initRes.session_id}`, {
          method: "PUT",
          headers: { "Content-Type": file.type || "application/octet-stream" },
          body: file,
          credentials: "include",
          signal: uploadAbortRef.current?.signal,
        });
        // A non-2xx PUT is a failed upload, not a success - count it as such.
        if (res.ok) uploaded++;
        else failed++;
      } catch (err) {
        // Page unmounted (logout/navigation) mid-upload - stop silently,
        // don't count the aborted-and-unattempted rest as failures.
        if ((err instanceof DOMException && err.name === "AbortError") || (err as { name?: string })?.name === "AbortError") break;
        failed++;
      }
    }
    return { uploaded, failed };
  }, [active?.id, folderId]);

  const handleDragOver = (e: React.DragEvent) => { e.preventDefault(); e.stopPropagation(); if (!showDeleted) setDragging(true); };
  const handleDragLeave = (e: React.DragEvent) => { e.preventDefault(); e.stopPropagation(); if (e.currentTarget === e.target) setDragging(false); };
  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault(); e.stopPropagation(); setDragging(false);
    if (showDeleted || !e.dataTransfer.files.length) return;
    const { uploaded, failed } = await uploadFiles(e.dataTransfer.files);
    if (!pageAliveRef.current) return; // page (or session) is gone - no toasts
    if (uploaded > 0) {
      toast.success("Uploaded", { description: `${uploaded} file${uploaded > 1 ? "s" : ""} uploaded` });
      refresh();
    }
    if (failed > 0) {
      toast.error("Some uploads failed", { description: `${failed} file${failed > 1 ? "s" : ""} could not be uploaded` });
    }
  };

  const handleVersionUpload = async (fileId: string, file: File) => {
    if (!active?.id) return;
    try {
      const initRes = await api.post<{ ok: boolean; session_id?: string; error?: string }>("/api/upload/init", {
        workspace_id: active.id,
        file_id: fileId,
        file_name: file.name,
        file_size: file.size,
        mime_type: file.type || "application/octet-stream",
      });
      if (!initRes.ok || !initRes.session_id) {
        if (!pageAliveRef.current) return;
        toast.error("Upload failed", { description: initRes.error ?? "The new version could not be uploaded." });
        return;
      }
      await fetch(`${apiBase()}/api/upload/${initRes.session_id}`, {
        method: "PUT",
        headers: { "Content-Type": file.type || "application/octet-stream" },
        body: file,
        credentials: "include",
        signal: uploadAbortRef.current?.signal,
      });
      if (!pageAliveRef.current) return;
      toast.success("Version uploaded", { description: "The file now points to your new version." });
      refresh();
    } catch {
      if (!pageAliveRef.current) return;
      toast.error("Upload failed", { description: "The new version could not be uploaded." });
    }
  };

  // Trigger the hidden file input when a version-upload target is set, then
  // clear the state right away (stashing the id in a ref for the change
  // handler). Clearing to null means selecting the same file again is a real
  // state transition, so the picker re-opens even after a cancelled picker.
  useEffect(() => {
    if (versionUploadTarget) {
      versionUploadTargetRef.current = versionUploadTarget;
      document.getElementById("version-upload-input")?.click();
      setVersionUploadTarget(null);
    }
  }, [versionUploadTarget]);

  // ── Keyboard shortcuts (web parity) ────────────────────────

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (viewerFile) return; // the viewer has its own shortcuts
      // `panel` can no longer be set while showDeleted (openFileWithLockCheck
      // and the card's onComments both gate on it), so this is already inert
      // in the trash view - the explicit check just makes that guarantee
      // visible here too, rather than relying on tracing every setPanel call.
      if ((e.key === "Delete" || e.key === "Backspace") && panel && !showDeleted) {
        setDeleteConfirm({ ids: [panel.file.id], names: [panel.file.name], kinds: ["file"] });
      }
      if ((e.ctrlKey || e.metaKey) && e.key === "a") {
        e.preventDefault();
        selectAll();
      }
      if (e.key === "F2" && panel) {
        e.preventDefault();
        setRenameItem({ id: panel.file.id, name: panel.file.name, kind: "file" });
        setRenameName(panel.file.name);
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [panel, viewerFile, selectAll, showDeleted]);

  // ── Bulk actions ───────────────────────────────────────────

  const bulkRestore = async () => {
    let ok = 0, fail = 0;
    for (const id of selected) {
      try { await api.put(`/api/files/${id}`); ok++; } catch { fail++; }
    }
    for (const id of selectedFolders) {
      try { await api.put(`/api/folders/${id}`); ok++; } catch { fail++; }
    }
    if (fail === 0) toast.success("Restored", { description: `${ok} item${ok === 1 ? "" : "s"} restored` });
    else toast.error("Some items could not be restored", { description: `${ok} restored, ${fail} failed` });
    clearSelection();
    refresh();
  };

  const bulkPermanentDelete = async () => {
    let ok = 0, fail = 0;
    // A second DELETE on an already-trashed item purges it. There is no /permanent
    // sub-route - the call this replaces 404'd silently and still reported success.
    for (const id of selected) {
      try { await api.delete(`/api/files/${id}`); ok++; } catch { fail++; }
    }
    for (const id of selectedFolders) {
      try { await api.delete(`/api/folders/${id}`); ok++; } catch { fail++; }
    }
    if (fail === 0) toast.success("Deleted", { description: `${ok} item${ok === 1 ? "" : "s"} permanently deleted` });
    else toast.error("Some items could not be deleted", { description: `${ok} deleted, ${fail} failed` });
    clearSelection();
    refresh();
  };

  // Row-level restore from the trash context menu (Restore/Delete permanently
  // are the only two actions offered there - see the context menu below).
  const restoreItem = async (id: string, kind: "file" | "folder") => {
    try {
      await api.put(kind === "folder" ? `/api/folders/${id}` : `/api/files/${id}`);
      toast.success("Restored");
      refresh();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Restore failed");
    }
  };

  const visibleCols = ALL_COLUMNS.filter((c) => visibleColumns.has(c.key));

  // What the table needs before it starts squeezing. Past this the wrapper
  // scrolls sideways, which is the whole point: twelve columns cannot share a
  // 900px window legibly, and shrinking them is worse than scrolling to them.
  const tableMinWidth =
    CHECKBOX_COL + ACTIONS_COL + NAME_COL_MIN +
    visibleCols.reduce((sum, c) => sum + (c.width ?? 0), 0);

  const ctxFile = contextMenu?.item.kind === "file" ? allFiles.find((f) => f.id === contextMenu.item.id) : undefined;
  const ctxFolder = contextMenu?.item.kind === "folder" ? allFolders.find((f) => f.id === contextMenu.item.id) : undefined;

  return (
    <div
      className="relative flex h-full flex-col"
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {/* Drop overlay */}
      {dragging && (
        <div className="pointer-events-none absolute inset-0 z-30 flex items-center justify-center rounded-lg border-2 border-dashed border-[var(--color-primary)] bg-[var(--color-primary)]/5">
          <div className="flex flex-col items-center gap-2 text-[var(--color-primary)]">
            <Upload size={40} />
            <p className="text-sm font-semibold">Drop files to upload</p>
            <p className="text-xs opacity-70">{folderId ? `to ${breadcrumbs.at(-1)?.name ?? "folder"}` : "to root folder"}</p>
          </div>
        </div>
      )}

      {/* Header. Wraps rather than overflowing: at 700px the trail and six
          controls cannot share one line, so the toolbar drops below the
          breadcrumb instead of pushing itself off the right edge. */}
      <div className="mb-4 flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
        {/* min-w-0 is what stops a deep path from pushing the toolbar off the
            right edge: a flex item defaults to min-width:auto and will not
            shrink below its content, so every extra folder level used to steal
            width from the buttons instead of the trail giving way. */}
        {/* basis keeps the trail on its own line once the toolbar no longer
            fits beside it, instead of the two fighting over a few pixels. */}
        <div className="min-w-0 flex-1 basis-64">
          {/* Breadcrumbs */}
          <div className="flex min-w-0 items-center gap-1 text-sm">
            <button
              onClick={() => setSearchParams({})}
              className="shrink-0 text-[var(--color-text-secondary)] hover:text-[var(--color-text)]"
            >
              Files
            </button>

            {/* Past a few levels the middle of the trail collapses behind a "…"
                menu. Truncation alone is not enough here - the useful ends of a
                path are its root and where you are standing, and squeezing
                every level equally hides both. */}
            {hiddenCrumbs.length > 0 && (
              <span className="relative flex shrink-0 items-center gap-1">
                <ChevronRight size={14} className="text-[var(--color-text-muted)]" />
                <button
                  onClick={() => setCrumbsOpen((v) => !v)}
                  title={hiddenCrumbs.map((c) => c.name).join(" / ")}
                  aria-label={`Show ${hiddenCrumbs.length} hidden folder${hiddenCrumbs.length === 1 ? "" : "s"}`}
                  aria-expanded={crumbsOpen}
                  className="rounded px-1 leading-none text-[var(--color-text-muted)] hover:bg-[var(--color-bg-tertiary)] hover:text-[var(--color-text)]"
                >
                  …
                </button>
                {crumbsOpen && (
                  <>
                    <div className="fixed inset-0 z-40" onClick={() => setCrumbsOpen(false)} />
                    <div
                      className="absolute left-4 top-6 z-50 max-h-64 w-56 overflow-y-auto rounded-lg border py-1 shadow-lg"
                      style={{ borderColor: "var(--color-border)", background: "var(--color-bg)" }}
                    >
                      {hiddenCrumbs.map((c) => (
                        <button
                          key={c.id}
                          onClick={() => { setCrumbsOpen(false); navigateToFolder(c.id); }}
                          className="block w-full truncate px-3 py-1.5 text-left text-xs text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-secondary)] hover:text-[var(--color-text)]"
                          title={c.name}
                        >
                          {c.name}
                        </button>
                      ))}
                    </div>
                  </>
                )}
              </span>
            )}

            {shownCrumbs.map((bc, i) => (
              <span key={bc.id} className="flex min-w-0 items-center gap-1">
                <ChevronRight size={14} className="shrink-0 text-[var(--color-text-muted)]" />
                <button
                  onClick={() => navigateToFolder(bc.id)}
                  title={bc.name}
                  // The folder you are in keeps the most room; its ancestors
                  // give way first, which is the order you can afford to lose.
                  className={`truncate text-[var(--color-text-secondary)] hover:text-[var(--color-text)] ${
                    i === shownCrumbs.length - 1 ? "max-w-[22rem] font-medium text-[var(--color-text)]" : "max-w-[10rem]"
                  }`}
                >
                  {bc.name}
                </button>
              </span>
            ))}
          </div>
        </div>
        {/* Wraps internally too. Making only the outer header wrap moved the
            whole toolbar onto its own line but kept it one unbreakable row, so
            at 700px Upload still sat ~100px past the right edge - off screen
            and, because nothing here scrolls sideways, unreachable. */}
        <div className="flex flex-wrap items-center justify-end gap-2">
          {/* Search */}
          <div className="relative">
            <Search
              size={14}
              className="absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--color-text-muted)]"
            />
            <input
              type="text"
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && doSearch()}
              placeholder="Search files..."
              // Was a hard 200px, which is a lot to spend on one control in a
              // 700px window. It now gives way down to 120 before anything
              // else in the row has to.
              className="w-[200px] min-w-[120px] max-w-full rounded-lg border py-1.5 pl-8 pr-3 text-sm outline-none focus:border-[var(--color-primary)]"
              style={{ borderColor: "var(--color-border)" }}
            />
          </div>

          {/* Sort */}
          <select
            value={sort}
            onChange={(e) => setSort(e.target.value)}
            className="rounded-lg border px-2.5 py-1.5 text-sm outline-none"
            style={{ borderColor: "var(--color-border)" }}
          >
            <option value="newest">Newest</option>
            <option value="oldest">Oldest</option>
            <option value="name_asc">Name A-Z</option>
            <option value="name_desc">Name Z-A</option>
            <option value="largest">Largest</option>
            <option value="smallest">Smallest</option>
          </select>

          {/* View toggle */}
          <div className="flex rounded-lg border" style={{ borderColor: "var(--color-border)" }}>
            <button
              onClick={() => setViewMode("table")}
              aria-label="List view"
              aria-pressed={viewMode === "table"}
              title="List view"
              className={`p-1.5 ${viewMode === "table" ? "bg-[var(--color-bg-tertiary)]" : ""}`}
            >
              <LayoutList size={16} />
            </button>
            <button
              onClick={() => setViewMode("card")}
              aria-label="Grid view"
              aria-pressed={viewMode === "card"}
              title="Grid view"
              className={`p-1.5 ${viewMode === "card" ? "bg-[var(--color-bg-tertiary)]" : ""}`}
            >
              <LayoutGrid size={16} />
            </button>
          </div>

          {/* Column picker (table view) */}
          {viewMode === "table" && (
            <div className="relative">
              <button
                onClick={() => setColumnPickerOpen((v) => !v)}
                className={`flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-sm ${columnPickerOpen ? "bg-[var(--color-bg-tertiary)]" : ""}`}
                style={{ borderColor: "var(--color-border)" }}
                title="Table columns"
              >
                <SlidersHorizontal size={14} /> Columns
              </button>
              {columnPickerOpen && (
                <>
                  <div className="fixed inset-0 z-40" onClick={() => setColumnPickerOpen(false)} />
                  <div
                    className="absolute right-0 z-50 mt-1 w-44 rounded-lg border bg-[var(--color-bg)] py-1 shadow-lg"
                    style={{ borderColor: "var(--color-border)" }}
                  >
                    {ALL_COLUMNS.map((col) => (
                      <label
                        key={col.key}
                        className={`flex w-full items-center gap-2 px-3 py-1.5 text-xs ${col.key === "name" ? "opacity-50" : "cursor-pointer hover:bg-[var(--color-bg-secondary)]"}`}
                      >
                        <input
                          type="checkbox"
                          checked={visibleColumns.has(col.key)}
                          disabled={col.key === "name"}
                          onChange={() => toggleColumn(col.key)}
                          className="accent-[var(--color-primary)]"
                        />
                        {col.label}
                      </label>
                    ))}
                  </div>
                </>
              )}
            </div>
          )}

          {/* New Folder */}
          {!showDeleted && (
            <button
              onClick={() => setShowCreateFolder(true)}
              className="flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-sm font-medium"
              style={{ borderColor: "var(--color-border)" }}
            >
              <Plus size={14} />
              New folder
            </button>
          )}

          {/* Upload */}
          {!showDeleted && (
            <button
              onClick={() => navigate("/upload")}
              className="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium text-white"
              style={{ background: "var(--color-primary)" }}
            >
              <Upload size={14} />
              Upload
            </button>
          )}
        </div>
      </div>

      {/* The filter chips that used to sit here moved into the sidebar's Files
          section, so a view is picked in one place instead of two. */}

      {/* Trash notice - items here still count against storage; only a
          permanent delete reclaims it. Static text, not a dismissible
          banner. */}
      {showDeleted && (
        <div
          className="mb-3 rounded-lg px-4 py-2 text-xs"
          style={{ background: "var(--color-bg-tertiary)", color: "var(--color-text-secondary)" }}
        >
          Items in the trash still count against your storage. Delete them permanently to free up space.
        </div>
      )}

      {/* Bulk Actions */}
      {totalSelected > 0 && (
        <div className="mb-3 flex flex-wrap items-center gap-3 rounded-lg bg-[var(--color-bg-tertiary)] px-4 py-2 text-sm">
          <span className="font-medium">{totalSelected} selected</span>
          {showDeleted ? (
            <>
              <button
                className="flex items-center gap-1 text-[var(--color-text-secondary)] hover:text-[var(--color-text)]"
                onClick={bulkRestore}
              >
                <RotateCcw size={14} /> Restore
              </button>
              <button
                className="flex items-center gap-1 text-[var(--color-danger)] hover:text-[var(--color-danger-hover)]"
                onClick={() => {
                  // Route through the shared confirm dialog instead of firing
                  // bulkPermanentDelete() straight from the toolbar - this is
                  // a second DELETE on already-trashed items, which purges
                  // rows and R2 objects for good with no way back.
                  const fileIds = Array.from(selected);
                  const folderIds = Array.from(selectedFolders);
                  const names = [
                    ...fileIds.map((id) => allFiles.find((f) => f.id === id)?.name ?? id),
                    ...folderIds.map((id) => allFolders.find((f) => f.id === id)?.name ?? id),
                  ];
                  setDeleteConfirm({ ids: fileIds, folderIds, names, kinds: fileIds.map(() => "file" as const), bulk: true, permanent: true });
                }}
              >
                <Trash2 size={14} /> Delete permanently
              </button>
            </>
          ) : (
            <>
              {can("download_files") && <button
                className="flex items-center gap-1 text-[var(--color-text-secondary)] hover:text-[var(--color-text)]"
                onClick={async () => {
                  try {
                    const r = await window.electronAPI.downloadArchive(Array.from(selected), Array.from(selectedFolders));
                    if (r.ok) toast.success("Downloaded", { description: `Saved to ${r.path ?? "disk"}` });
                    else if (!r.canceled) toast.error("Download failed");
                  } catch (e: any) {
                    toast.error(e instanceof ApiError ? e.message : "Failed");
                  }
                }}
              >
                <FileArchive size={14} /> Download ZIP
              </button>}
              {can("create_share_links") && <button
                className="flex items-center gap-1 text-[var(--color-text-secondary)] hover:text-[var(--color-text)] disabled:opacity-30 disabled:cursor-not-allowed disabled:hover:text-[var(--color-text-secondary)]"
                // A bundle link is one set of files - it has no room for a folder
                // alongside them, and desktop has no separate single-folder share
                // path the way web does (see files.tsx's canShare). So ANY folder
                // in the selection disables this button, not just a mixed one -
                // a folders-only selection would otherwise stay enabled and post
                // file_ids: [], which the API rejects.
                disabled={selectedFolders.size > 0}
                title={selectedFolders.size > 0 ? "A link covers one folder, or a set of files - not both." : undefined}
                onClick={async () => {
                  try {
                    const ids = Array.from(selected);
                    const res = await api.post<{ ok: boolean; url: string; token: string }>("/api/files/share-bundle", { file_ids: ids, workspace_id: active!.id });
                    if (res.url) {
                      navigator.clipboard.writeText(res.url);
                      toast.success("Share bundle link copied!");
                    }
                  } catch (e: any) {
                    toast.error(e instanceof ApiError ? e.message : "Failed");
                  }
                }}
              >
                <Link2 size={14} /> Share bundle
              </button>}
              {(can("upload_files") || can("rename_folders")) && <button
                className="flex items-center gap-1 text-[var(--color-text-secondary)] hover:text-[var(--color-text)]"
                onClick={() => { setBulkMoveIds(Array.from(selected)); setBulkMoveFolderIds(Array.from(selectedFolders)); setPickerFolder(null); }}
              >
                <Move size={14} /> Move
              </button>}
              {(can("delete_any_file") || can("delete_own_files")) && <button
                className="flex items-center gap-1 text-[var(--color-danger)] hover:text-[var(--color-danger-hover)]"
                onClick={() => {
                  const fileIds = Array.from(selected);
                  const folderIds = Array.from(selectedFolders);
                  const names = [
                    ...fileIds.map((id) => allFiles.find((f) => f.id === id)?.name ?? id),
                    ...folderIds.map((id) => folders.find((f) => f.id === id)?.name ?? id),
                  ];
                  setDeleteConfirm({ ids: fileIds, folderIds, names, kinds: fileIds.map(() => "file" as const), bulk: true });
                }}
              >
                <Trash2 size={14} /> Delete
              </button>}
            </>
          )}
          <div className="ml-auto flex items-center gap-3">
            <button className="text-xs text-[var(--color-text-muted)]" onClick={selectAll}>
              Select all
            </button>
            <button className="text-xs text-[var(--color-text-muted)]" onClick={clearSelection}>
              Clear
            </button>
          </div>
        </div>
      )}

      {/* Content */}
      {isLoading ? (
        <div className="space-y-2">
          {Array.from({ length: 8 }).map((_, i) => (
            <div key={i} className="h-12 animate-pulse rounded-lg bg-[var(--color-bg-tertiary)]" />
          ))}
        </div>
      ) : viewMode === "table" ? (
        <div className="flex-1 overflow-auto">
          <table
            className="w-full table-fixed text-left text-sm"
            style={{ minWidth: tableMinWidth }}
          >
            {/* Explicit widths, so `table-fixed` honours them and Name absorbs
                whatever is left. Without this the browser reflows every column
                to fit the container, which is what wrapped MIME types across
                three lines once all twelve were switched on. */}
            <colgroup>
              <col style={{ width: CHECKBOX_COL }} />
              {visibleCols.map((col) => (
                <col key={col.key} style={col.width ? { width: col.width } : undefined} />
              ))}
              <col style={{ width: ACTIONS_COL }} />
            </colgroup>
            <thead>
              <tr className="border-b text-xs text-[var(--color-text-muted)]" style={{ borderColor: "var(--color-border)" }}>
                <th className="w-8 py-2 pl-3">
                  <input
                    type="checkbox"
                    aria-label="Select all"
                    checked={totalSelected > 0 && selected.size >= selectableFiles.length && selectedFolders.size >= folders.length && (selectableFiles.length + folders.length) > 0}
                    onChange={(e) => {
                      if (e.target.checked) selectAll();
                      else clearSelection();
                    }}
                  />
                </th>
                {visibleCols.map((col) => (
                  <th key={col.key} className="truncate py-2 pr-3 font-medium">{col.label}</th>
                ))}
                <th className="w-10 py-2"></th>
              </tr>
            </thead>
            <tbody>
              {folders.map((folder) => (
                <tr
                  key={folder.id}
                  className="cursor-pointer border-b transition-colors hover:bg-[var(--color-bg-secondary)]"
                  style={{ borderColor: "var(--color-border)" }}
                  onClick={(e) => { if (e.ctrlKey || e.metaKey) toggleSelectFolder(folder.id); else navigateToFolder(folder.id); }}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    setContextMenu({ x: e.clientX, y: e.clientY, item: { id: folder.id, name: folder.name, kind: "folder" } });
                  }}
                >
                  <td className="py-2 pl-3" onClick={(e) => e.stopPropagation()}>
                    <input
                      type="checkbox"
                      aria-label={`Select ${folder.name}`}
                      checked={selectedFolders.has(folder.id)}
                      onChange={() => toggleSelectFolder(folder.id)}
                    />
                  </td>
                  {visibleCols.map((col) => {
                    if (col.key === "name") {
                      return (
                        <td key="name" className="py-2 pr-3">
                          <div className="flex min-w-0 items-center gap-2.5">
                            <span className="relative shrink-0">
                              <FolderIcon fileCount={folder.file_count} size={18} synced={!!(syncedFolderIds.has(folder.id) || folder.is_synced)} />
                              <OriginBadge origin={folder.origin} />
                            </span>
                            <span className="truncate font-medium" title={folder.name}>{folder.name}</span>
                            <span className="shrink-0 text-xs text-[var(--color-text-muted)]">{folder.file_count} files</span>
                            {!!folder.lock_mode && folder.lock_mode !== "none" && (
                              <span title="Locked" className="inline-flex shrink-0"><Lock size={12} className="text-[var(--color-text-muted)]" /></span>
                            )}
                            {!!folder.is_hidden && (
                              <span title={hiddenTitle(folder.hidden_mode)} className="inline-flex shrink-0"><EyeOff size={12} className="text-[var(--color-text-muted)]" /></span>
                            )}
                          </div>
                        </td>
                      );
                    }
                    return (
                      <td key={col.key} className="truncate py-2 pr-3 text-xs text-[var(--color-text-muted)]">
                        {col.renderFolder ? col.renderFolder(folder) : "-"}
                      </td>
                    );
                  })}
                  <td className="py-2">
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        setContextMenu({ x: e.clientX, y: e.clientY, item: { id: folder.id, name: folder.name, kind: "folder" } });
                      }}
                      aria-label={`Actions for ${folder.name}`}
                      className="rounded p-1 hover:bg-[var(--color-bg-tertiary)]"
                    >
                      <MoreHorizontal size={14} />
                    </button>
                  </td>
                </tr>
              ))}
              {files.map((file) => {
                const isSel = selected.has(file.id);
                const isActive = panel?.file.id === file.id;
                return (
                  <tr
                    key={file.id}
                    id={`file-${file.id}`}
                    className={`cursor-pointer border-b transition-colors ${isActive ? "bg-green-50" : isSel ? "bg-[var(--color-primary)]/5" : "hover:bg-[var(--color-bg-secondary)]"}`}
                    style={{ borderColor: "var(--color-border)" }}
                    onClick={(e) => {
                      if (e.ctrlKey || e.metaKey) toggleSelect(file.id);
                      else openFileWithLockCheck(file, "detail");
                    }}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      setContextMenu({ x: e.clientX, y: e.clientY, item: { id: file.id, name: file.name, kind: "file" } });
                    }}
                  >
                    <td className="py-2 pl-3" onClick={(e) => e.stopPropagation()}>
                      <input
                        type="checkbox"
                        aria-label={`Select ${file.name}`}
                        checked={isSel}
                        onChange={() => toggleSelect(file.id)}
                      />
                    </td>
                    {visibleCols.map((col) => {
                      if (col.key === "name") {
                        return (
                          <td key="name" className="py-2 pr-3">
                            <div className="flex min-w-0 items-center gap-2.5">
                              <RowThumbnail fileId={file.id} fileName={file.name} />
                              <span
                                title={file.name}
                                className="truncate hover:text-[var(--color-primary)] hover:underline"
                                onClick={(e) => { e.stopPropagation(); openFileWithLockCheck(file, "view"); }}
                              >
                                {file.name}
                              </span>
                              {favourites.has(file.id) && <Star size={12} className="shrink-0 fill-orange-400 text-orange-400" />}
                              {(file.current_version ?? 1) > 1 && (
                                <span className="shrink-0 rounded bg-[var(--color-bg-tertiary)] px-1 text-[9px] font-medium">v{file.current_version}</span>
                              )}
                              {!!file.lock_mode && file.lock_mode !== "none" && (
                                <span title="Locked" className="inline-flex shrink-0"><Lock size={12} className="text-[var(--color-text-muted)]" /></span>
                              )}
                              {!!file.is_hidden && (
                                <span title={hiddenTitle(file.hidden_mode)} className="inline-flex shrink-0"><EyeOff size={12} className="text-[var(--color-text-muted)]" /></span>
                              )}
                              {file.share_count > 0 && (
                                <Share2 size={12} className="shrink-0 text-[var(--color-primary)]" />
                              )}
                            </div>
                          </td>
                        );
                      }
                      return (
                        <td
                          key={col.key}
                          className="truncate py-2 pr-3 text-xs text-[var(--color-text-muted)]"
                          // The full value is still reachable on hover, which is
                          // what makes the shortened Type column safe.
                          title={col.key === "type" ? file.mime_type : undefined}
                        >
                          {col.render(file)}
                        </td>
                      );
                    })}
                    <td className="py-2">
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          setContextMenu({ x: e.clientX, y: e.clientY, item: { id: file.id, name: file.name, kind: "file" } });
                        }}
                        aria-label={`Actions for ${file.name}`}
                        className="rounded p-1 hover:bg-[var(--color-bg-tertiary)]"
                      >
                        <MoreHorizontal size={14} />
                      </button>
                    </td>
                  </tr>
                );
              })}
              {folders.length === 0 && files.length === 0 && (
                <tr>
                  <td colSpan={visibleCols.length + 2} className="py-16 text-center text-sm text-[var(--color-text-muted)]">
                    {showDeleted ? "Trash is empty"
                      : search ? "No files match your search"
                      : activeFilter === "favourites" ? "No favourites yet - star a file to collect it here"
                      : "This folder is empty"}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      ) : (
        /* Card View */
        <div className="flex-1 overflow-auto">
          {folders.length > 0 && (
            <div className="mb-5">
              <p className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">Folders</p>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
                {folders.map((folder) => {
                  const isFolderSel = selectedFolders.has(folder.id);
                  return (
                    <div
                      key={folder.id}
                      className={`group relative cursor-pointer rounded-xl border p-4 transition-colors hover:bg-[var(--color-bg-secondary)] ${isFolderSel ? "ring-2 ring-[var(--color-primary)]" : ""}`}
                      style={{ borderColor: "var(--color-border)" }}
                      onClick={(e) => { if (e.ctrlKey || e.metaKey) toggleSelectFolder(folder.id); else navigateToFolder(folder.id); }}
                      onContextMenu={(e) => {
                        e.preventDefault();
                        setContextMenu({ x: e.clientX, y: e.clientY, item: { id: folder.id, name: folder.name, kind: "folder" } });
                      }}
                    >
                      <input
                        type="checkbox"
                        checked={isFolderSel}
                        onChange={() => toggleSelectFolder(folder.id)}
                        onClick={(e) => e.stopPropagation()}
                        className={`absolute left-2 top-2 z-20 h-4 w-4 accent-[var(--color-primary)] transition-all ${isFolderSel || selectedFolders.size > 0 ? "opacity-100" : "opacity-0 group-hover:opacity-100"}`}
                      />
                      <span className="relative mb-3 inline-block">
                        <FolderIcon fileCount={folder.file_count} size={32} synced={!!(syncedFolderIds.has(folder.id) || folder.is_synced)} />
                        <OriginBadge origin={folder.origin} />
                      </span>
                      <p className="truncate text-sm font-medium">{folder.name}</p>
                      <p className="text-xs text-[var(--color-text-muted)]">{folder.file_count} items</p>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
          {files.length > 0 && (
            <div>
              <p className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">Files</p>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-4 xl:grid-cols-5">
                {files.map((file) => (
                  <FileCard
                    key={file.id}
                    file={file}
                    selected={selected.has(file.id)}
                    anySelected={selected.size > 0}
                    active={panel?.file.id === file.id}
                    isFavourite={favourites.has(file.id)}
                    onClick={(e) => {
                      if (e.ctrlKey || e.metaKey) toggleSelect(file.id);
                      else openFileWithLockCheck(file, "detail");
                    }}
                    onSelect={() => toggleSelect(file.id)}
                    onNameClick={() => openFileWithLockCheck(file, "view")}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      setContextMenu({ x: e.clientX, y: e.clientY, item: { id: file.id, name: file.name, kind: "file" } });
                    }}
                    onFavourite={() => toggleFavourite(file.id)}
                    // A second, independent path to the same detail panel (and
                    // its live Delete button) - gate it the same way as the
                    // card's own onClick above, or the trash view stays only
                    // half read-only.
                    onComments={() => { if (showDeleted) toggleSelect(file.id); else setPanel({ file, tab: "comments" }); }}
                    onShare={() => setShareTarget({ target: { kind: "file", fileIds: [file.id] }, name: file.name })}
                    onMore={(e) => {
                      e.stopPropagation();
                      setContextMenu({ x: e.clientX, y: e.clientY, item: { id: file.id, name: file.name, kind: "file" } });
                    }}
                  />
                ))}
              </div>
            </div>
          )}
          {folders.length === 0 && files.length === 0 && (
            <div className="py-16 text-center text-sm text-[var(--color-text-muted)]">
              {showDeleted ? "Trash is empty"
                : search ? "No files match your search"
                : activeFilter === "favourites" ? "No favourites yet - star a file to collect it here"
                : "This folder is empty"}
            </div>
          )}
        </div>
      )}

      {/* Pagination */}
      {pagination && pagination.total_pages > 1 && (
        <div className="mt-4 flex items-center justify-between border-t pt-3" style={{ borderColor: "var(--color-border)" }}>
          <span className="text-xs text-[var(--color-text-muted)]">
            Page {pagination.page} of {pagination.total_pages} ({pagination.total_files} files)
          </span>
          <div className="flex gap-1">
            <button
              disabled={pagination.page <= 1}
              onClick={() => {
                const p = new URLSearchParams(searchParams);
                p.set("page", String(pagination.page - 1));
                setSearchParams(p);
              }}
              className="rounded border px-3 py-1 text-sm disabled:opacity-30"
              style={{ borderColor: "var(--color-border)" }}
            >
              Prev
            </button>
            <button
              disabled={pagination.page >= pagination.total_pages}
              onClick={() => {
                const p = new URLSearchParams(searchParams);
                p.set("page", String(pagination.page + 1));
                setSearchParams(p);
              }}
              className="rounded border px-3 py-1 text-sm disabled:opacity-30"
              style={{ borderColor: "var(--color-border)" }}
            >
              Next
            </button>
          </div>
        </div>
      )}

      {/* Context Menu */}
      {contextMenu && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setContextMenu(null)} />
          <div
            className="fixed z-50 w-52 origin-top-left overflow-y-auto rounded-lg border bg-[var(--color-bg)] py-1 shadow-lg"
            style={{
              left: Math.min(contextMenu.x, window.innerWidth - 224),
              top: Math.min(contextMenu.y, Math.max(8, window.innerHeight - 560)),
              maxHeight: window.innerHeight - 16,
              borderColor: "var(--color-border)",
            }}
          >
            {showDeleted ? (
              // Trash view: a soft-deleted row can only come back or be purged
              // for good. Rename/Move/Lock/Hide/Share/Open either 404 against
              // the is_deleted=0 predicate those routes filter on, or - for
              // "Open" on a folder - navigate somewhere the app can't browse.
              // "Delete" here is a second DELETE, which is a permanent purge
              // (subtree, files and R2 objects included for a folder), so it
              // gets its own unmistakable copy via the shared confirm dialog
              // instead of the routine "Delete" wording below.
              <>
                <CtxItem icon={<RotateCcw size={14} />} label="Restore" onClick={() => {
                  restoreItem(contextMenu.item.id, contextMenu.item.kind);
                  setContextMenu(null);
                }} />
                <Divider />
                <CtxItem icon={<Trash2 size={14} />} label="Delete permanently" danger onClick={() => {
                  setDeleteConfirm({
                    ids: [contextMenu.item.id],
                    names: [contextMenu.item.name],
                    kinds: [contextMenu.item.kind],
                    permanent: true,
                    fileCount: contextMenu.item.kind === "folder" ? ctxFolder?.file_count : undefined,
                  });
                  setContextMenu(null);
                }} />
              </>
            ) : contextMenu.item.kind === "folder" ? (
              <>
                {/* Each entry below is gated on the permission its endpoint
                    actually checks. The menu used to offer all of it to every
                    role, so a viewer got Rename, Move, Lock, Hide and Delete
                    and learned their role from a row of 403 toasts. Lock and
                    Hide use canLock/canHide from the listing payload - fields
                    this file has always DECLARED (can_lock, can_hide) and
                    never read. */}
                <CtxItem icon={<FolderOpen size={14} />} label="Open" onClick={() => { navigateToFolder(contextMenu.item.id); setContextMenu(null); }} />
                {can("create_share_links") && <CtxItem icon={<Share2 size={14} />} label="Share" onClick={() => {
                  setShareTarget({ target: { kind: "folder", folderId: contextMenu.item.id }, name: contextMenu.item.name });
                  setContextMenu(null);
                }} />}
                <CtxItem icon={<Info size={14} />} label="Get info" onClick={() => {
                  if (ctxFolder) setInfoTarget({ type: "folder", item: ctxFolder });
                  setContextMenu(null);
                }} />
                <Divider />
                {can("rename_folders") && <CtxItem icon={<Pencil size={14} />} label="Rename" onClick={() => {
                  setRenameItem(contextMenu.item); setRenameName(contextMenu.item.name); setContextMenu(null);
                }} />}
                {can("rename_folders") && <CtxItem icon={<Move size={14} />} label="Move to..." onClick={() => {
                  setMoveTarget({ id: contextMenu.item.id, name: contextMenu.item.name, kind: "folder" });
                  setPickerFolder(null); setContextMenu(null);
                }} />}
                <Divider />
                {canLock && <CtxItem icon={<Lock size={14} />} label={ctxFolder && ctxFolder.lock_mode !== "none" ? "Unlock" : "Lock"} onClick={() => {
                  setLockTarget({ id: contextMenu.item.id, name: contextMenu.item.name, type: "folder" }); setContextMenu(null);
                }} />}
                {canHide && <CtxItem icon={ctxFolder?.is_hidden ? <Eye size={14} /> : <EyeOff size={14} />} label={ctxFolder?.is_hidden ? "Unhide" : "Hide"} onClick={() => {
                  setHideTarget({ id: contextMenu.item.id, name: contextMenu.item.name, type: "folder" }); setContextMenu(null);
                }} />}
                <Divider />
                {(can("delete_any_file") || can("delete_own_files")) && <CtxItem icon={<Trash2 size={14} />} label="Delete" danger onClick={() => {
                  setDeleteConfirm({ ids: [contextMenu.item.id], names: [contextMenu.item.name], kinds: ["folder"] });
                  setContextMenu(null);
                }} />}
              </>
            ) : (
              <>
                <CtxItem icon={<Eye size={14} />} label="View" onClick={() => {
                  if (ctxFile) openFileWithLockCheck(ctxFile, "view");
                  setContextMenu(null);
                }} />
                {isOfficeFile(contextMenu.item.name) && (
                  <CtxItem icon={<SquarePen size={14} />} label="Open in editor" onClick={() => {
                    // In-app now. This used to window.open the web app, which
                    // threw the user out of the desktop app into a browser and a
                    // second login for a document they already had open here.
                    navigate(`/editor/${contextMenu.item.id}`);
                    setContextMenu(null);
                  }} />
                )}
                {can("download_files") && <CtxItem icon={<Download size={14} />} label="Download" onClick={() => {
                  if (ctxFile) downloadViaDialog(ctxFile);
                  setContextMenu(null);
                }} />}
                {can("create_share_links") && <CtxItem icon={<Share2 size={14} />} label="Share" onClick={() => {
                  setShareTarget({ target: { kind: "file", fileIds: [contextMenu.item.id] }, name: contextMenu.item.name }); setContextMenu(null);
                }} />}
                <CtxItem icon={<MessageCircle size={14} />} label="Comments" onClick={() => {
                  if (ctxFile) setPanel({ file: ctxFile, tab: "comments" });
                  setContextMenu(null);
                }} />
                <CtxItem icon={<Star size={14} />} label={favourites.has(contextMenu.item.id) ? "Remove favourite" : "Add to favourites"} onClick={() => {
                  toggleFavourite(contextMenu.item.id); setContextMenu(null);
                }} />
                <CtxItem icon={<Info size={14} />} label="Get info" onClick={() => {
                  if (ctxFile) setInfoTarget({ type: "file", item: ctxFile });
                  setContextMenu(null);
                }} />
                <Divider />
                {can("rename_files") && <CtxItem icon={<Pencil size={14} />} label="Rename" onClick={() => {
                  setRenameItem(contextMenu.item); setRenameName(contextMenu.item.name); setContextMenu(null);
                }} />}
                {can("upload_files") && <CtxItem icon={<Copy size={14} />} label="Copy to..." onClick={() => {
                  setCopyTarget({ id: contextMenu.item.id, name: contextMenu.item.name });
                  setPickerFolder(null); setContextMenu(null);
                }} />}
                {can("upload_files") && <CtxItem icon={<Move size={14} />} label="Move to..." onClick={() => {
                  setMoveTarget({ id: contextMenu.item.id, name: contextMenu.item.name, kind: "file" });
                  setPickerFolder(null); setContextMenu(null);
                }} />}
                <Divider />
                <CtxItem icon={<ExternalLink size={14} />} label="Open in system app" onClick={() => {
                  openFileInSystemApp(contextMenu.item.id, contextMenu.item.name); setContextMenu(null);
                }} />
                {can("upload_files") && <CtxItem icon={<Upload size={14} />} label="Upload new version" onClick={() => {
                  setVersionUploadTarget(contextMenu.item.id); setContextMenu(null);
                }} />}
                <CtxItem icon={<History size={14} />} label="Version history" onClick={() => {
                  if (ctxFile) openFileWithLockCheck(ctxFile, "view");
                  setContextMenu(null);
                }} />
                {canLock && <CtxItem icon={<Lock size={14} />} label={ctxFile && ctxFile.lock_mode !== "none" ? "Unlock" : "Lock"} onClick={() => {
                  setLockTarget({ id: contextMenu.item.id, name: contextMenu.item.name, type: "file" }); setContextMenu(null);
                }} />}
                {canHide && <CtxItem icon={ctxFile?.is_hidden ? <Eye size={14} /> : <EyeOff size={14} />} label={ctxFile?.is_hidden ? "Unhide" : "Hide"} onClick={() => {
                  setHideTarget({ id: contextMenu.item.id, name: contextMenu.item.name, type: "file" }); setContextMenu(null);
                }} />}
                <Divider />
                {canDeleteFile(ctxFile) && <CtxItem icon={<Trash2 size={14} />} label="Delete" danger onClick={() => {
                  setDeleteConfirm({ ids: [contextMenu.item.id], names: [contextMenu.item.name], kinds: ["file"] });
                  setContextMenu(null);
                }} />}
              </>
            )}
          </div>
        </>
      )}

      {/* Create Folder Modal */}
      {showCreateFolder && (
        <Modal onClose={() => setShowCreateFolder(false)}>
          <h3 className="mb-4 text-lg font-semibold">Create folder</h3>
          <input
            type="text"
            value={newFolderName}
            onChange={(e) => setNewFolderName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && newFolderName && createFolderMut.mutate(newFolderName)}
            placeholder="Folder name"
            autoFocus
            className="mb-4 w-full rounded-lg border px-3 py-2 text-sm outline-none focus:border-[var(--color-primary)]"
            style={{ borderColor: "var(--color-border)" }}
          />
          <div className="flex justify-end gap-2">
            <button
              onClick={() => setShowCreateFolder(false)}
              className="rounded-lg border px-4 py-2 text-sm"
              style={{ borderColor: "var(--color-border)" }}
            >
              Cancel
            </button>
            <button
              onClick={() => newFolderName && createFolderMut.mutate(newFolderName)}
              disabled={!newFolderName}
              className="rounded-lg px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
              style={{ background: "var(--color-primary)" }}
            >
              Create
            </button>
          </div>
        </Modal>
      )}

      {/* Rename Modal */}
      {renameItem && (
        <Modal onClose={() => setRenameItem(null)}>
          <h3 className="mb-4 text-lg font-semibold">Rename</h3>
          <input
            type="text"
            value={renameName}
            onChange={(e) => setRenameName(e.target.value)}
            onKeyDown={(e) =>
              e.key === "Enter" &&
              renameName &&
              renameMut.mutate({ id: renameItem.id, name: renameName, kind: renameItem.kind })
            }
            autoFocus
            className="mb-4 w-full rounded-lg border px-3 py-2 text-sm outline-none focus:border-[var(--color-primary)]"
            style={{ borderColor: "var(--color-border)" }}
          />
          <div className="flex justify-end gap-2">
            <button
              onClick={() => setRenameItem(null)}
              className="rounded-lg border px-4 py-2 text-sm"
              style={{ borderColor: "var(--color-border)" }}
            >
              Cancel
            </button>
            <button
              onClick={() =>
                renameName && renameMut.mutate({ id: renameItem.id, name: renameName, kind: renameItem.kind })
              }
              className="rounded-lg px-4 py-2 text-sm font-medium text-white"
              style={{ background: "var(--color-primary)" }}
            >
              Rename
            </button>
          </div>
        </Modal>
      )}

      {/* Unlock password modal (full_lock gate) */}
      {unlockPrompt && (
        <Modal onClose={() => setUnlockPrompt(null)} maxWidth={340}>
          <h3 className="mb-1 flex items-center gap-2 text-lg font-semibold"><Lock size={16} /> File is locked</h3>
          <p className="mb-3 text-xs text-[var(--color-text-muted)]">
            Enter the password to access <span className="break-all font-semibold text-[var(--color-text)]">{unlockPrompt.file.name}</span>
          </p>
          {unlockError && (
            <p className="mb-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-[var(--color-danger)]">{unlockError}</p>
          )}
          <input
            type="password"
            value={unlockPassword}
            onChange={(e) => setUnlockPassword(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleUnlockSubmit()}
            placeholder="Enter password"
            className="mb-4 w-full rounded-lg border px-3 py-2 text-sm outline-none focus:border-[var(--color-primary)]"
            style={{ borderColor: "var(--color-border)" }}
            autoFocus
          />
          <div className="flex justify-end gap-2">
            <button
              onClick={() => setUnlockPrompt(null)}
              className="rounded-lg border px-4 py-2 text-sm"
              style={{ borderColor: "var(--color-border)" }}
            >
              Cancel
            </button>
            <button
              onClick={handleUnlockSubmit}
              disabled={unlocking}
              className="flex items-center gap-1.5 rounded-lg px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
              style={{ background: "var(--color-primary)" }}
            >
              {unlocking && <Loader2 size={14} className="animate-spin" />}
              Unlock
            </button>
          </div>
        </Modal>
      )}

      {/* Detail Panel */}
      {panel && (
        <FileDetailPanel
          key={`${panel.file.id}:${panel.tab}`}
          file={panel.file}
          workspaceId={active!.id}
          initialTab={panel.tab}
          onClose={() => setPanel(null)}
          onCopy={(id) => { setCopyTarget({ id, name: panel.file.name }); setPickerFolder(null); }}
          onDelete={(id, name) => setDeleteConfirm({ ids: [id], names: [name], kinds: ["file"] })}
          onShare={(id, name) => setShareTarget({ target: { kind: "file", fileIds: [id] }, name })}
          onView={(f) => { setPanel(null); setViewerFile(f as FileRow); }}
          onRefresh={refresh}
        />
      )}

      {/* Delete Confirmation Modal */}
      {deleteConfirm && (
        <Modal onClose={() => setDeleteConfirm(null)}>
          <div className="flex items-start gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-red-50">
              <Trash2 size={20} className="text-[var(--color-danger)]" />
            </div>
            <div>
              <h3 className="text-lg font-semibold">
                {deleteConfirm.permanent
                  ? deleteConfirm.bulk
                    ? `Delete ${deleteConfirm.names.length} item${deleteConfirm.names.length === 1 ? "" : "s"} permanently?`
                    : "Delete permanently?"
                  : `Delete ${deleteConfirm.names.length === 1 ? "item" : `${deleteConfirm.names.length} items`}?`}
              </h3>
              <p className={`mt-1 text-sm ${deleteConfirm.permanent ? "text-[var(--color-danger)]" : "text-[var(--color-text-secondary)]"}`}>
                {deleteConfirm.permanent ? (
                  deleteConfirm.bulk ? (
                    <>
                      Permanently delete <strong>{deleteConfirm.names.length}</strong> item{deleteConfirm.names.length === 1 ? "" : "s"}?
                      This cannot be undone.
                    </>
                  ) : (
                    <>
                      Permanently delete <strong>{deleteConfirm.names[0]}</strong>
                      {deleteConfirm.kinds[0] === "folder" && !!deleteConfirm.fileCount &&
                        ` and its ${deleteConfirm.fileCount} file${deleteConfirm.fileCount === 1 ? "" : "s"}`}
                      ? This cannot be undone.
                    </>
                  )
                ) : deleteConfirm.names.length === 1 ? (
                  <>Are you sure you want to delete <strong>{deleteConfirm.names[0]}</strong>?</>
                ) : (
                  <>Are you sure you want to delete these {deleteConfirm.names.length} items?</>
                )}
              </p>
              {(!deleteConfirm.permanent || deleteConfirm.bulk) && deleteConfirm.names.length > 1 && deleteConfirm.names.length <= 5 && (
                <ul className="mt-2 space-y-0.5 text-xs text-[var(--color-text-muted)]">
                  {deleteConfirm.names.map((n, i) => (
                    <li key={i} className="truncate">· {n}</li>
                  ))}
                </ul>
              )}
              {!deleteConfirm.permanent && (
                <p className="mt-2 text-xs text-[var(--color-text-muted)]">
                  This action can be undone from the Deleted filter. It keeps using storage until permanently deleted.
                </p>
              )}
            </div>
          </div>
          <div className="mt-5 flex justify-end gap-2">
            <button
              onClick={() => setDeleteConfirm(null)}
              className="rounded-lg border px-4 py-2 text-sm"
              style={{ borderColor: "var(--color-border)" }}
            >
              Cancel
            </button>
            <button
              onClick={async () => {
                if (deleteConfirm.bulk && deleteConfirm.permanent) {
                  // Row-by-row permanent DELETE (there's no bulk-purge route) -
                  // reuses the same runner as the bulk-bar button so both
                  // paths land here after this confirmation.
                  await bulkPermanentDelete();
                } else if (deleteConfirm.bulk) {
                  try {
                    await api.post("/api/files/batch-delete", {
                      workspace_id: active!.id,
                      file_ids: deleteConfirm.ids,
                      folder_ids: deleteConfirm.folderIds ?? [],
                    });
                    const count = deleteConfirm.ids.length + (deleteConfirm.folderIds?.length ?? 0);
                    toast.success("Deleted", { description: `${count} item${count === 1 ? "" : "s"} deleted` });
                    refresh();
                    clearSelection();
                  } catch (e: any) {
                    toast.error(e instanceof ApiError ? e.message : "Delete failed");
                  }
                } else {
                  deleteConfirm.ids.forEach((id, i) => deleteMut.mutate({ id, kind: deleteConfirm.kinds[i] }));
                  toast.success(deleteConfirm.permanent ? "Permanently deleted" : "Deleted");
                  clearSelection();
                }
                setPanel((p) => (p && deleteConfirm.ids.includes(p.file.id) ? null : p));
                setDeleteConfirm(null);
              }}
              className="rounded-lg bg-[var(--color-danger)] px-4 py-2 text-sm font-medium text-white hover:opacity-90"
            >
              {deleteConfirm.permanent ? "Delete permanently" : "Delete"}
            </button>
          </div>
        </Modal>
      )}

      {/* Move / Copy / Bulk-move Folder Picker Modal */}
      {(moveTarget || copyTarget || bulkMoveIds || bulkMoveFolderIds) && (
        <FolderPickerModal
          title={
            moveTarget ? `Move "${moveTarget.name}"`
            : copyTarget ? `Copy "${copyTarget.name}"`
            : `Move ${(bulkMoveIds?.length ?? 0) + (bulkMoveFolderIds?.length ?? 0)} items`
          }
          actionLabel={copyTarget ? "Copy here" : "Move here"}
          folders={folderTreeData?.folders ?? []}
          selectedId={pickerFolder}
          excludeId={moveTarget?.kind === "folder" ? moveTarget.id : undefined}
          isPending={moveMut.isPending || copyMut.isPending}
          onSelect={setPickerFolder}
          onConfirm={async () => {
            if (moveTarget) {
              await moveMut.mutateAsync({ id: moveTarget.id, kind: moveTarget.kind, targetId: pickerFolder });
              toast.success("Moved successfully");
            } else if (copyTarget) {
              copyMut.mutate({ id: copyTarget.id, targetId: pickerFolder });
              return;
            } else if (bulkMoveIds) {
              for (const id of bulkMoveIds) {
                try { await moveMut.mutateAsync({ id, kind: "file", targetId: pickerFolder }); } catch {}
              }
              for (const id of bulkMoveFolderIds ?? []) {
                try { await moveMut.mutateAsync({ id, kind: "folder", targetId: pickerFolder }); } catch {}
              }
              toast.success("Moved", { description: `${(bulkMoveIds?.length ?? 0) + (bulkMoveFolderIds?.length ?? 0)} items moved` });
              clearSelection();
            }
            refresh();
            setMoveTarget(null);
            setBulkMoveIds(null);
            setBulkMoveFolderIds(null);
            setPickerFolder(null);
          }}
          onClose={() => {
            setMoveTarget(null);
            setCopyTarget(null);
            setBulkMoveIds(null);
            setBulkMoveFolderIds(null);
            setPickerFolder(null);
          }}
        />
      )}

      {/* Share / Lock / Hide / Info */}
      <ShareModal
        open={!!shareTarget}
        target={shareTarget?.target ?? null}
        name={shareTarget?.name ?? ""}
        onClose={() => { setShareTarget(null); refresh(); }}
      />
      <LockModal
        open={!!lockTarget}
        target={lockTarget}
        onClose={() => setLockTarget(null)}
        onDone={refresh}
      />
      <HideModal
        open={!!hideTarget}
        target={hideTarget}
        workspaceId={active?.id ?? ""}
        onClose={() => setHideTarget(null)}
        onDone={refresh}
      />
      <FileInfoDialog
        target={infoTarget}
        location={breadcrumbs.length ? breadcrumbs.map((b) => b.name).join(" / ") : "Home"}
        onClose={() => setInfoTarget(null)}
      />

      {/* Hidden file input for version upload */}
      <input
        type="file"
        id="version-upload-input"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          const targetId = versionUploadTargetRef.current;
          if (file && targetId) {
            handleVersionUpload(targetId, file);
          }
          versionUploadTargetRef.current = null;
          e.target.value = "";
        }}
      />

      {/* File viewer */}
      {viewerFile && (
        <FileViewer
          file={viewerFile}
          files={files}
          onClose={() => setViewerFile(null)}
          onNavigate={(f) => setViewerFile(f as FileRow)}
        />
      )}
    </div>
  );
}

function CtxItem({
  icon,
  label,
  danger,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  danger?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={`flex w-full items-center gap-2 px-3 py-1.5 text-sm hover:bg-[var(--color-bg-secondary)] ${
        danger ? "text-[var(--color-danger)]" : ""
      }`}
    >
      {icon}
      {label}
    </button>
  );
}

function Divider() {
  return <div className="my-1 h-px bg-[var(--color-border)]" />;
}

// ── Small row thumbnail (table view): preview if image, else icon ──

function RowThumbnail({ fileId, fileName }: { fileId: string; fileName: string }) {
  return (
    <FilePreviewImage
      fileId={fileId}
      fileName={fileName}
      size={128}
      className="h-7 w-7 shrink-0 rounded bg-[var(--color-bg-tertiary)] object-cover"
      fallback={<FileIcon name={fileName} size={18} className="shrink-0" />}
    />
  );
}

// ── Web-style file card (grid view) ────────────────────────

function FileCard({
  file, selected, anySelected, active, isFavourite,
  onClick, onSelect, onNameClick, onContextMenu, onFavourite, onComments, onShare, onMore,
}: {
  file: FileRow;
  selected: boolean;
  anySelected: boolean;
  active: boolean;
  isFavourite: boolean;
  onClick: (e: React.MouseEvent) => void;
  onSelect: () => void;
  onNameClick: () => void;
  onContextMenu: (e: React.MouseEvent) => void;
  onFavourite: () => void;
  onComments: () => void;
  onShare: () => void;
  onMore: (e: React.MouseEvent) => void;
}) {
  const ext = extOf(file.name).toUpperCase() || "FILE";

  return (
    <div
      className={`group relative aspect-[3/2] cursor-pointer overflow-hidden rounded-xl transition-all hover:-translate-y-px hover:shadow-lg ${
        active ? "ring-2 ring-green-500" : selected ? "ring-2 ring-[var(--color-primary)]" : "ring-1 ring-black/10"
      }`}
      onClick={onClick}
      onContextMenu={onContextMenu}
    >
      {/* Full-bleed thumbnail */}
      <div className="absolute inset-0 bg-neutral-900">
        <FilePreviewImage
          fileId={file.id}
          fileName={file.name}
          size={512}
          className="h-full w-full object-cover"
          fallback={
            <div
              className="flex h-full w-full items-center justify-center"
              style={{ background: `linear-gradient(135deg, ${colorFor(file.name)}22, #0a0a0a)` }}
            >
              <span className="font-mono text-xl font-bold uppercase tracking-widest" style={{ color: colorFor(file.name) }}>
                {ext}
              </span>
            </div>
          }
        />
      </div>

      {/* Legibility scrims */}
      <div className="pointer-events-none absolute inset-x-0 top-0 h-14 bg-gradient-to-b from-black/55 to-transparent" />
      <div className="pointer-events-none absolute inset-x-0 bottom-0 h-3/5 bg-gradient-to-t from-black/85 via-black/40 to-transparent" />

      {/* Top-left: multi-select checkbox (hidden for fully-locked files) */}
      {file.lock_mode !== "full_lock" && (
        <input
          type="checkbox"
          checked={selected}
          onChange={onSelect}
          onClick={(e) => e.stopPropagation()}
          className={`absolute left-2 top-2 z-20 h-4 w-4 accent-[var(--color-primary)] transition-all ${selected || anySelected ? "opacity-100" : "opacity-0 group-hover:opacity-100"}`}
        />
      )}

      {/* Top-right: lock (if any) + hidden (if any) + file-format pill */}
      <div className="absolute right-2 top-2 z-10 flex items-center gap-1">
        {file.lock_mode !== "none" && (
          <span className="flex h-6 w-6 items-center justify-center rounded-full bg-black/45 backdrop-blur-sm">
            <Lock size={12} className="text-white" />
          </span>
        )}
        {!!file.is_hidden && (
          <span className="flex h-6 w-6 items-center justify-center rounded-full bg-black/45 backdrop-blur-sm">
            <span title={hiddenTitle(file.hidden_mode)} className="inline-flex"><EyeOff size={12} className="text-white" /></span>
          </span>
        )}
        <span className="rounded-full bg-black/45 px-2 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-wider text-white backdrop-blur-sm">{ext}</span>
      </div>

      {/* Right vertical action rail */}
      <div className="absolute bottom-2 right-2 z-20 flex flex-col gap-2 opacity-90 transition-opacity group-hover:opacity-100">
        <button
          className="flex h-8 w-8 items-center justify-center rounded-full bg-black/35 backdrop-blur-sm transition-colors hover:bg-black/55"
          title={isFavourite ? "Remove from favourites" : "Add to favourites"}
          onClick={(e) => { e.stopPropagation(); onFavourite(); }}
        >
          <Star size={16} className={isFavourite ? "fill-orange-400 text-orange-400" : "text-white"} />
        </button>
        {file.comment_count > 0 && (
          <button
            className="relative flex h-8 w-8 items-center justify-center rounded-full bg-black/35 backdrop-blur-sm transition-colors hover:bg-black/55"
            title={`${file.comment_count} comment${file.comment_count === 1 ? "" : "s"} - open`}
            onClick={(e) => { e.stopPropagation(); onComments(); }}
          >
            <MessageCircle size={16} className="text-white" />
            <span className="absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-blue-500 px-1 font-mono text-[9px] text-white">{file.comment_count}</span>
          </button>
        )}
        <button
          className="flex h-8 w-8 items-center justify-center rounded-full bg-black/35 backdrop-blur-sm transition-colors hover:bg-black/55"
          title={file.share_count > 0 ? `Shared (${file.share_count}) - manage` : "Share"}
          onClick={(e) => { e.stopPropagation(); onShare(); }}
        >
          <Share2 size={16} className={file.share_count > 0 ? "text-green-400" : "text-white"} />
        </button>
        <button
          className="flex h-7 w-7 items-center justify-center self-center rounded-full bg-white/10 backdrop-blur-sm transition-colors hover:bg-white/25"
          title="More"
          onClick={onMore}
        >
          <MoreHorizontal size={16} className="text-white" />
        </button>
      </div>

      {/* Bottom-left: filename + meta line (padded so it clears the rail) */}
      <div className="absolute inset-x-0 bottom-0 z-10 p-2.5 pr-12">
        <div className="flex min-w-0 items-center gap-1.5">
          <button
            className="min-w-0 truncate text-left font-mono text-sm font-semibold text-white drop-shadow hover:underline"
            title={file.name}
            onClick={(e) => { e.stopPropagation(); onNameClick(); }}
          >
            {file.name}
          </button>
          {(file.current_version ?? 1) > 1 && (
            <span className="shrink-0 rounded border border-white/30 px-1 font-mono text-[9px] text-white/80">v{file.current_version}</span>
          )}
        </div>
        <p className="truncate font-mono text-[11px] text-white/70 drop-shadow">
          {formatBytes(file.size_bytes)} · {formatDate(file.updated_at)}
        </p>
      </div>
    </div>
  );
}

function FolderPickerModal({
  title,
  actionLabel,
  folders,
  selectedId,
  excludeId,
  isPending,
  onSelect,
  onConfirm,
  onClose,
}: {
  title: string;
  actionLabel: string;
  folders: { id: string; name: string; parent_id: string | null; file_count: number }[];
  selectedId: string | null;
  excludeId?: string;
  isPending: boolean;
  onSelect: (id: string | null) => void;
  onConfirm: () => void;
  onClose: () => void;
}) {
  type Folder = { id: string; name: string; parent_id: string | null; file_count: number };

  // Flatten the (always-expanded) tree into a single ordered list ONCE, in
  // O(n) via a children map - the old code re-filtered the whole array at every
  // node (O(n²)) and rendered every folder unconditionally. Row 0 is the
  // synthetic "Root" option so the whole thing virtualizes uniformly.
  const rows = useMemo(() => {
    const childrenMap = new Map<string | null, Folder[]>();
    for (const f of folders) {
      if (f.id === excludeId) continue; // drop the excluded folder (and thus its subtree)
      const arr = childrenMap.get(f.parent_id);
      if (arr) arr.push(f);
      else childrenMap.set(f.parent_id, [f]);
    }
    const out: { folder: Folder | null; depth: number }[] = [{ folder: null, depth: 0 }];
    const walk = (parentId: string | null, depth: number) => {
      for (const f of childrenMap.get(parentId) ?? []) {
        out.push({ folder: f, depth });
        walk(f.id, depth + 1);
      }
    };
    walk(null, 0);
    return out;
  }, [folders, excludeId]);

  const scrollRef = useRef<HTMLDivElement>(null);
  const ROW_H = 36;
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_H,
    overscan: 12,
  });

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30">
      <div
        className="w-full max-w-sm rounded-xl bg-[var(--color-bg)] shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="border-b px-5 py-4" style={{ borderColor: "var(--color-border)" }}>
          <h3 className="text-lg font-semibold">{title}</h3>
          <p className="text-xs text-[var(--color-text-muted)]">Select destination folder</p>
        </div>

        <div ref={scrollRef} className="max-h-72 overflow-y-auto p-2">
          <div style={{ height: virtualizer.getTotalSize(), position: "relative", width: "100%" }}>
            {virtualizer.getVirtualItems().map((vi) => {
              const row = rows[vi.index];
              const isRoot = row.folder === null;
              const id = isRoot ? null : row.folder!.id;
              const selected = selectedId === id;
              return (
                <button
                  key={vi.key}
                  onClick={() => onSelect(id)}
                  className={`absolute left-0 flex w-full items-center gap-2.5 rounded-lg pr-3 text-sm transition-colors ${
                    selected
                      ? "bg-[var(--color-primary)]/10 font-medium text-[var(--color-primary)]"
                      : "hover:bg-[var(--color-bg-secondary)]"
                  }`}
                  style={{
                    top: 0,
                    height: ROW_H,
                    transform: `translateY(${vi.start}px)`,
                    paddingLeft: `${12 + (isRoot ? 0 : row.depth * 20)}px`,
                  }}
                >
                  <FolderIcon fileCount={isRoot ? 1 : row.folder!.file_count} size={16} />
                  <span className="truncate">{isRoot ? "Root (top level)" : row.folder!.name}</span>
                </button>
              );
            })}
          </div>

          {folders.length === 0 && (
            <p className="py-4 text-center text-sm text-[var(--color-text-muted)]">
              No folders yet
            </p>
          )}
        </div>

        <div className="flex justify-end gap-2 border-t px-5 py-4" style={{ borderColor: "var(--color-border)" }}>
          <button
            onClick={onClose}
            className="rounded-lg border px-4 py-2 text-sm"
            style={{ borderColor: "var(--color-border)" }}
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            disabled={isPending}
            className="rounded-lg px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
            style={{ background: "var(--color-primary)" }}
          >
            {isPending ? "Working..." : actionLabel}
          </button>
        </div>
      </div>
      <div className="fixed inset-0 -z-10" onClick={onClose} />
    </div>
  );
}
