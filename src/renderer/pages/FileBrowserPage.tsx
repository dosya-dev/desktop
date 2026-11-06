import { useState, useCallback, useEffect, useMemo, useRef } from "react";
import { isSortKey, parseSort, serializeSort, toggleSort, type SortKey } from "@/lib/list-sort";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useQuery, useMutation, useQueryClient, keepPreviousData } from "@tanstack/react-query";
import {
  ChevronRight,
  LayoutGrid,
  LayoutList,
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
  ArrowUp,
  ArrowDown,
  SquarePen,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { api, ApiError } from "@/lib/api-client";
import { isUploadCancelled, uploadFileInParts } from "@/lib/upload-in-parts";
import { uploadTransport } from "@/lib/upload-transport";
import {
  purgeTrashedFolder, purgeSummary, bulkPurgeSummary,
  type PurgeResponse, type PurgeMessage, type UnfinishedFolder,
} from "@/lib/folder-purge";
import { checkBatchFitsQuota } from "@dosya-dev/shared";
import { folderPathError, nameError, uploadFileError, rejectionsSummary } from "@/lib/policy-error";
import { fetchUploadLimits } from "@/lib/upload-limits";
import { useWorkspace } from "@/lib/workspace-context";
import { usePermissions } from "@/lib/use-permissions";
import { formatBytes, formatDate } from "@/lib/format";
import { activeFilter as readActiveFilter, searchCommitParams } from "@/lib/files-params";
import { useDebouncedValue } from "@/lib/use-debounced-value";
import { restoreTarget } from "@/lib/view-restore";
import { useLibrary } from "@/lib/use-library";
import {
  kindForFilter, sortOptionsFor, KIND_COPY, LIBRARY_QUERY_ROOT,
  loadLibraryLayouts, saveLibraryLayout, type LibrarySort, type LibraryLayout,
} from "@/lib/library-request";
import { timeAgo, extOf, colorFor, originLabel, isOfficeFile, hiddenTitle, kindLabel, regionLabel } from "@/lib/file-type";
import { toast } from "sonner";
import { autoDir, Bdi, namedLine, Part, useAutoDir } from "@/lib/bidi-ui";
import { FileIcon, FolderIcon, fileIconSrc } from "@/components/files/FileIcon";
import { FolderPickerModal } from "@/components/files/FolderPickerModal";
import { FileViewer, downloadViaDialog } from "@/components/files/FileViewer";
import { FilePreviewImage } from "@/components/files/FilePreviewImage";
import { FileDetailPanel } from "@/components/files/FileDetailPanel";
import { ShareModal, type ShareTarget } from "@/components/files/ShareModal";
import { LockModal, type LockTarget } from "@/components/files/LockModal";
import { HideModal } from "@/components/files/HideModal";
import { FileInfoDialog, type InfoTarget } from "@/components/files/FileInfoDialog";
import { OriginBadge } from "@/components/files/OriginBadge";
import { LibraryGrid, KIND_ICON, type TileSize } from "@/components/files/LibraryGrid";
import {
  ALL_COLUMNS, libraryColumnsFor, loadSavedColumns, NAME_COL_MIN, CHECKBOX_COL, ACTIONS_COL, TABLE_COLUMNS_KEY,
  type ColumnKey, type FileRow, type FolderRow,
} from "@/lib/file-columns";
import { Modal } from "@/components/files/Modal";
import { NewMenuButton, NewChoiceIcon, useNewChoices, type NewChoice } from "@/components/files/NewMenu";
import { NewFileDialog } from "@/components/files/NewFileDialog";
import { NEW_FILE_TYPES, blankFileBytes, nameTaken, nameTakenInFolder, type NewFileKind } from "@/lib/blank-files";
import { canEditText } from "@/lib/text-edit";
import { MoveConfirmModal } from "@/components/files/MoveConfirmModal";
import {
  DRAG_MOVE_TYPE, dragItems, itemCount, isMoveDrag, isOsFileDrag, isValidDropTarget, encodeMovePayload, decodeMovePayload,
  type MovePayload,
} from "@/lib/drag-move";
import { isSimple, useMenuActions, useMenuState } from "@/lib/menu-bus";
import {
  readDroppedEntries, orderedDirs, createFolderTree, resolveTargets,
  MAX_DROPPED_FILES, type FolderPlan,
} from "@/lib/dropped-entries";
import {
  collapseLiveTwins, twinsUnderStills, isLiveStill, isLiveTwin, liveTwinIds, twinDeleteEndpoint,
} from "@/lib/live-photos";
import { LiveBadge } from "@/components/files/LiveBadge";
import { intlLocale } from "@/lib/locale-state";
import { useDir, useLocale, useT } from "@/lib/i18n";
import { richText } from "@/lib/rich-text";

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

const VIEW_STORAGE_KEY = "dosya_files_view";

function loadSavedView(): ViewMode {
  const saved = localStorage.getItem(VIEW_STORAGE_KEY);
  return saved === "table" || saved === "card" ? saved : "table";
}

// The library keeps its own order and tile size, under the same keys the web
// app uses - the folder listing's `sort`/`viewMode` mean nothing to it. One
// setting for all three kinds, and the keys keep their `photos` names: the
// stored values are the same three sorts whatever is on screen.
const PHOTO_SORT_KEY = "dosya_photos_sort";
const PHOTO_TILE_KEY = "dosya_photos_tile";

function loadSavedPhotoSort(): LibrarySort {
  const saved = localStorage.getItem(PHOTO_SORT_KEY);
  // Any kind's option list carries the same three wire values.
  return sortOptionsFor("photos").some((o) => o.value === saved) ? (saved as LibrarySort) : "taken_desc";
}

function loadSavedTileSize(): TileSize {
  return localStorage.getItem(PHOTO_TILE_KEY) === "large" ? "large" : "small";
}

// The library has neither, and a fresh [] every render would give every
// memo, callback and effect keyed on them a new identity each time.
const NO_FOLDERS: FolderRow[] = [];
const NO_BREADCRUMBS: { id: string; name: string }[] = [];

/** A folder row in the table while a drag-to-move hovers it. */
const ROW_DROP_ACTIVE = "bg-[var(--color-primary)]/10 outline outline-2 -outline-offset-2 outline-[var(--color-primary)]";

/** A breadcrumb segment while a drag-to-move hovers it. */
const CRUMB_DROP_ACTIVE = "bg-[var(--color-primary)]/15 !text-[var(--color-primary)] ring-1 ring-[var(--color-primary)]";

/**
 * The inline position of a menu opened at the cursor, kept 224px (its width
 * plus a margin) inside the window. In a right-to-left language the menu's
 * right edge sits at the cursor and it opens leftward, clamped the same way.
 */
function atCursor(x: number, dir: "ltr" | "rtl"): { left: number } | { right: number } {
  return dir === "rtl"
    ? { right: Math.min(window.innerWidth - x, window.innerWidth - 224) } // rtl-ok: mirrored
    : { left: Math.min(x, window.innerWidth - 224) }; // rtl-ok: mirrored
}

/** The six orders the sort menu offers as its own options. */
const PRESET_SORTS: ReadonlySet<string> = new Set(["newest", "oldest", "name_asc", "name_desc", "largest", "smallest"]);

export function FileBrowserPage() {
  const ownDir = useAutoDir();
  const t = useT();
  const dir = useDir();
  const { locale } = useLocale();
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

  // The Images, Videos and Documents rows open the library: workspace-wide,
  // month-grouped items from /api/library?kind=… in place of the folder
  // listing. Everything downstream reads `allFiles` / `selected`, so the
  // viewer, bulk bar and modals are untouched.
  const libraryKind = kindForFilter(activeFilter);
  const isLibraryView = libraryKind !== null;
  // Hooks cannot be conditional and a component has to be capitalised to be
  // usable as a tag, so the kind's mark is resolved here, with photos standing
  // in when there is no library on screen (nothing renders it then).
  const LibraryIcon = KIND_ICON[libraryKind ?? "photos"];
  const [photoSort, setPhotoSortState] = useState<LibrarySort>(loadSavedPhotoSort);
  const setPhotoSort = (s: LibrarySort) => { setPhotoSortState(s); localStorage.setItem(PHOTO_SORT_KEY, s); };
  const [tileSize, setTileSizeState] = useState<TileSize>(loadSavedTileSize);
  const setTileSize = (size: TileSize) => { setTileSizeState(size); localStorage.setItem(PHOTO_TILE_KEY, size); };

  // Where an upload started from this page lands. The library spans every
  // folder and ignores the `folder` param (which filterNavParams keeps so
  // leaving the library returns you to it), so there is no current folder to
  // upload into here - and no breadcrumb to name it with either.
  const uploadFolderId = isLibraryView ? null : folderId;

  const [viewMode, setViewModeState] = useState<ViewMode>(loadSavedView);
  const setViewMode = (m: ViewMode) => {
    setViewModeState(m);
    localStorage.setItem(VIEW_STORAGE_KEY, m);
  };
  const [visibleColumns, setVisibleColumns] = useState<Set<ColumnKey>>(loadSavedColumns);
  const [columnPickerOpen, setColumnPickerOpen] = useState(false);
  const toggleColumn = (key: ColumnKey) => {
    if (key === "name" || key === "taken") return; // both are always visible
    setVisibleColumns((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      localStorage.setItem(TABLE_COLUMNS_KEY, JSON.stringify([...next]));
      return next;
    });
  };

  // Tiles or a table, remembered per kind rather than for the library as a
  // whole: photos are a contact sheet and documents are a list of names and
  // dates, so one shared preference would always be wrong for one of them. The
  // folder listing keeps its own `viewMode` - the two never interfere.
  const [libraryLayouts, setLibraryLayouts] = useState(loadLibraryLayouts);
  const libraryLayout: LibraryLayout = libraryKind ? libraryLayouts[libraryKind] : "grid";
  const changeLibraryLayout = (next: LibraryLayout) => {
    if (!libraryKind) return;
    setLibraryLayouts((prev) => ({ ...prev, [libraryKind]: next }));
    saveLibraryLayout(libraryKind, next);
    // The column picker belongs to the table; going back to tiles unmounts it,
    // so drop the open flag with it rather than let it reopen on the way back.
    if (next === "grid") setColumnPickerOpen(false);
  };

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [selectedFolders, setSelectedFolders] = useState<Set<string>>(new Set());
  // Search lives in the URL (?q=). `searchInput` is the raw typed value; it is
  // committed after a pause in typing (web parity, apps/web/src/pages/files.tsx),
  // at once on Enter, and at once when the box is emptied - so clearing the
  // search restores the full listing without having to press anything (QA
  // TC-022: the filtered view used to stay until Enter was pressed on an empty
  // box).
  const [searchInput, setSearchInput] = useState(search);
  const debouncedSearch = useDebouncedValue(searchInput, 300);
  const [dragging, setDragging] = useState(false);
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    item: { id: string; name: string; kind: "file" | "folder" };
  } | null>(null);
  /** Right-click on empty space in the listing: the "New" menu. */
  const [blankMenu, setBlankMenu] = useState<{ x: number; y: number } | null>(null);
  const [showCreateFolder, setShowCreateFolder] = useState(false);
  const [newFolderName, setNewFolderName] = useState("");
  /** The kind of blank file being named, while the New file dialog is open. */
  const [newFileKind, setNewFileKind] = useState<NewFileKind | null>(null);
  /** A file just created here, to scroll into view once the refreshed listing has it. */
  const [revealId, setRevealId] = useState<string | null>(null);
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
  // `twin`/`withTwin` are only set by `fileDeleteConfirm` below, for the three
  // single-file soft-delete sites (keyboard shortcut, context menu, detail
  // panel) - a Live Photo still offers to take its twin video along.
  const [deleteConfirm, setDeleteConfirm] = useState<{ ids: string[]; names: string[]; kinds: ("file" | "folder")[]; bulk?: boolean; folderIds?: string[]; permanent?: boolean; fileCount?: number; twin?: { id: string; name: string } | null; withTwin?: boolean } | null>(null);

  // Viewer + detail panel + modals (web parity)
  const [viewerFile, setViewerFile] = useState<FileRow | null>(null);
  // `versions`: opened from "Version history", so the panel lists versions even
  // for a file that has only one (it hides a lone version otherwise).
  const [panel, setPanel] = useState<{ file: FileRow; tab: "info" | "comments"; versions?: boolean } | null>(null);
  const [shareTarget, setShareTarget] = useState<{ target: ShareTarget; name: string } | null>(null);
  const [lockTarget, setLockTarget] = useState<LockTarget | null>(null);
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
  const [unlockPrompt, setUnlockPrompt] = useState<{ file: FileRow; action: "detail" | "versions" | "view" } | null>(null);
  const [unlockPassword, setUnlockPassword] = useState("");
  const [unlockError, setUnlockError] = useState("");
  // The server's own sentence takes its own direction; a translation follows the page.
  const [unlockErrorRaw, setUnlockErrorRaw] = useState(false);
  const [unlocking, setUnlocking] = useState(false);

  // Deep-link restore memory (see `restoreTarget` in @/lib/view-restore):
  // `lastRestoredId` is the id the restore effect itself last opened, so a
  // repeat of that same id (the url-mirror effect writing it straight back)
  // is a no-op, while a genuinely different id - even on an already-mounted
  // page - restores. `restorePassed` is separate: it only latches once the
  // loading gate below has cleared at least once, and gates the url-mirror
  // effect so it never fires before the first restore attempt has run.
  const lastRestoredId = useRef<string | null>(null);
  const restorePassed = useRef(false);

  /** Open state of the collapsed-breadcrumb "…" menu. */
  const [crumbsOpen, setCrumbsOpen] = useState(false);

  const { data, isLoading, isPlaceholderData: listingIsPlaceholder } = useQuery({
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
    enabled: !!active && !isLibraryView,
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

  // Null outside the library, which leaves the hook idle - exactly one of
  // the two feeds is ever live.
  const library = useLibrary(active && libraryKind ? { workspaceId: active.id, kind: libraryKind, sort: photoSort, q: search } : null);

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

  // The URL keeps the API's wire format ("newest", "comments_desc"); the
  // column headers work with the parsed key + direction.
  const sortSpec = parseSort(sort);
  const setSort = (s: string) => {
    const p = new URLSearchParams(searchParams);
    p.set("sort", s);
    // A page number only means something within one ordering.
    p.delete("page");
    setSearchParams(p);
  };

  // The last term this box itself wrote to the URL. Its own commit must not be
  // mirrored back into the box, or a keystroke typed while that commit lands
  // would be overwritten.
  const committedSearch = useRef(search);
  const commitSearch = (term: string) => {
    const next = searchCommitParams(searchParams, term);
    if (!next) return;
    committedSearch.current = term;
    setSearchParams(next, { replace: true });
  };

  // Back/forward, the sidebar and folder navigation can change ?q= without
  // going through the box, so mirror those changes back into it.
  useEffect(() => {
    if (search === committedSearch.current) return;
    committedSearch.current = search;
    setSearchInput(search);
  }, [search]);

  useEffect(() => {
    if (debouncedSearch !== search) commitSearch(debouncedSearch);
    // Only a settled keystroke commits; `search` changing on its own (the
    // mirror above) must not write the stale debounced value back.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debouncedSearch]);

  // A search is in flight while the typed text has not been committed yet
  // (the 300 ms pause) or while the list still shows the results of a
  // previous term (placeholder data). `shownSearch` is the term the rows on
  // screen belong to, so a sort or page change alone never spins the box.
  const listingPlaceholder = isLibraryView ? library.isPlaceholder : listingIsPlaceholder;
  const shownSearch = useRef(search);
  if (!listingPlaceholder) shownSearch.current = search;
  const searching = searchInput !== search || (listingPlaceholder && shownSearch.current !== search);

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
    // Both roots, every time: a file deleted from a folder has to leave the
    // library too, and vice versa. Keyed on the root rather than the
    // workspace so this stays right in either mode - useLibrary's own refresh
    // derives its workspace from a view that is null outside the library.
    queryClient.invalidateQueries({ queryKey: ["files"] });
    queryClient.invalidateQueries({ queryKey: [LIBRARY_QUERY_ROOT] });
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
      toast.error(t("files.error.somethingWentWrong"), { description: t("files.error.couldNotUpdateFavourites") });
    }
  };

  // ── Open with lock gate (web parity) ───────────────────────

  const openFileWithLockCheck = useCallback((file: FileRow, action: "detail" | "versions" | "view") => {
    if (showDeleted && action !== "view") {
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
    if (action === "view") setViewerFile(file);
    else setPanel({ file, tab: "info", versions: action === "versions" });
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
        if (action === "view") setViewerFile(file);
        else setPanel({ file, tab: "info", versions: action === "versions" });
      } else {
        setUnlockError(res.error ?? t("files.error.incorrectPassword")); setUnlockErrorRaw(res.error != null);
        setUnlockPassword("");
      }
    } catch (err) {
      setUnlockError(err instanceof ApiError ? err.message : t("common.error.canTReachTheServerCheckYourConnectionAnd")); setUnlockErrorRaw(err instanceof ApiError);
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
    mutationFn: (name: string) => {
      // The field takes a path, so this is the path validator: 500 total, 100
      // per segment, single-segment character policy on each. Same function the
      // API runs, so the thrown message is the one it would have returned.
      const problem = folderPathError(name);
      if (problem) throw new Error(problem);
      return api.post("/api/folders", {
        workspace_id: active!.id,
        name,
        parent_id: folderId || null,
      });
    },
    onSuccess: () => {
      refresh();
      setShowCreateFolder(false);
      setNewFolderName("");
      toast.success(t("common.label.folderCreated"));
    },
    // This mutation had no onError at all, so a refused create - a duplicate
    // name, no permission, and now an invalid one - closed nothing and said
    // nothing. Any Error carries a message worth showing, not just ApiError.
    onError: (e) => toast.error(e instanceof ApiError ? autoDir(e.message) : e instanceof Error ? e.message : t("common.error.folderCouldNotBeCreated")),
  });

  const renameMut = useMutation({
    mutationFn: ({ id, name, kind }: { id: string; name: string; kind: string }) => {
      // Files cap at 255, folders at 100, both single-segment. Checked before
      // the request so a slash in the name fails instantly with the reason.
      const problem = nameError(name, kind === "folder" ? "folder" : "file");
      if (problem) throw new Error(problem);
      return api.put(`/api/${kind === "folder" ? "folders" : "files"}/${id}/rename`, { name });
    },
    onSuccess: () => {
      refresh();
      setRenameItem(null);
      toast.success(t("files.label.renamed"));
    },
    // Widened from ApiError: a local policy refusal is a plain Error and its
    // message is the same sentence the API would have sent.
    onError: (e) => toast.error(e instanceof ApiError ? autoDir(e.message) : e instanceof Error ? e.message : t("common.error.renameFailed")),
  });

  const moveMut = useMutation({
    mutationFn: ({ id, kind, targetId }: { id: string; kind: "file" | "folder"; targetId: string | null }) => {
      if (kind === "folder") {
        return api.put(`/api/folders/${id}/move`, { parent_id: targetId });
      }
      return api.put(`/api/files/${id}/move`, { folder_id: targetId });
    },
    onError: (e) => toast.error(e instanceof ApiError ? autoDir(e.message) : t("common.error.moveFailed")),
  });

  const copyMut = useMutation({
    mutationFn: ({ id, targetId }: { id: string; targetId: string | null }) =>
      api.post(`/api/files/${id}/copy`, { folder_id: targetId }),
    onSuccess: () => {
      refresh();
      setCopyTarget(null);
      setPickerFolder(null);
      toast.success(t("files.label.copiedSuccessfully"));
    },
    onError: (e) => toast.error(e instanceof ApiError ? autoDir(e.message) : t("common.error.copyFailed")),
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
      toast.error(t("files.error.failedToOpenFile"));
    }
  }, [t]);

  // One of the two feeds, chosen here so nothing below has to know which.
  const allFolders = isLibraryView ? NO_FOLDERS : data?.folders ?? [];
  const allFiles: FileRow[] = isLibraryView ? library.files : data?.files ?? [];
  const breadcrumbs = isLibraryView ? NO_BREADCRUMBS : data?.breadcrumbs ?? [];

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
  // The library pages by cursor from inside the grid, so the numbered pager
  // has nothing to page - and `data` can still hold the previous listing here.
  const pagination = isLibraryView ? null : data?.pagination;

  // can_lock / can_hide have been in this response type since the file was
  // written and were never read, so Lock and Hide were offered to every role
  // while only an owner's clicks worked. Default false, not true: the endpoint
  // refuses anyway, and offering a locked door is the defect being fixed.
  const canLock = isLibraryView ? library.canLock : data?.can_lock ?? false;
  const canHide = isLibraryView ? library.canHide : data?.can_hide ?? false;

  /**
   * Whether Delete should be offered for one file, mirroring what
   * files/[id]/index.ts checks: delete_any_file covers everything, otherwise
   * delete_own_files covers only this member's own uploads.
   */
  const canDeleteFile = (f: { uploaded_by?: string } | null | undefined): boolean => {
    if (can("delete_any_file")) return true;
    return can("delete_own_files") && !!f && f.uploaded_by === currentUserId;
  };

  /**
   * The single-file soft-delete confirm state, offering to take a Live Photo
   * still's twin video along. The twin may already be out of view (paged,
   * filtered, collapsed under the still in the grid), so this always names it
   * by id from `allFiles`, not from whatever happens to be on screen.
   */
  const fileDeleteConfirm = (f: FileRow) => ({
    ids: [f.id],
    names: [f.name],
    kinds: ["file" as const],
    twin: isLiveStill(f) ? { id: f.live_video_id!, name: allFiles.find((x) => x.id === f.live_video_id)?.name ?? t("files.label.itsLivePhotoVideo") } : null,
    withTwin: true,
  });

  // Client-side chips - "shared" shows only files with share links, "favourites"
  // only starred files (both hide folders, like the web sidebar's views).
  const folders = activeFilter === "shared" || activeFilter === "favourites" ? [] : allFolders;
  const files =
    activeFilter === "shared" ? allFiles.filter((f) => f.share_count > 0)
    : activeFilter === "favourites" ? allFiles.filter((f) => favourites.has(f.id))
    : allFiles;
  // Grids collapse a Live Photo's twin video under its still; the table keeps
  // the twin as a row right under the still. Counts and selection use `files`.
  const gridFiles = useMemo(() => collapseLiveTwins(files), [files]);
  const listFiles = useMemo(() => twinsUnderStills(files), [files]);

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
  // The Live Photo videos a bulk delete would carry along. Derived once from
  // the ids the dialog was opened with: the copy line named it three times in
  // a single line, walking every row on the page per render of an open dialog
  // to answer the same question.
  const confirmTwinIds = useMemo(
    () => (deleteConfirm?.bulk ? liveTwinIds(files, new Set(deleteConfirm.ids)) : []),
    [files, deleteConfirm],
  );

  // ── Move (shared by Move to…, the bulk bar and drag-and-drop) ──

  /**
   * The one move runner. `bulk` keeps the two paths' own rules: a single item
   * is one request whose refusal moveMut has already toasted (returns false,
   * so the picker can stay open for another choice), while a bulk move tries
   * every item, lets a refused one fail on its own toast, reports the count
   * the user picked and clears the selection. Either way a Live Photo still
   * takes its twin video along - looked up from the full listing, since the
   * twin's own row may be paged, filtered or collapsed under the still.
   */
  const runMove = async ({ fileIds, folderIds, targetId, bulk }: {
    fileIds: string[]; folderIds: string[]; targetId: string | null; bulk: boolean;
  }): Promise<boolean> => {
    if (!bulk) {
      const kind: "file" | "folder" = fileIds.length > 0 ? "file" : "folder";
      const id = kind === "file" ? fileIds[0] : folderIds[0];
      if (!id) return false;
      // moveMut's onError already toasted the reason ("File is already in
      // this folder"); a rethrow here escaped as an unhandled rejection
      // (Sentry dosya-desktop 154628913).
      try {
        await moveMut.mutateAsync({ id, kind, targetId });
      } catch {
        return false;
      }
      if (kind === "file") {
        const still = allFiles.find((f) => f.id === id);
        if (still && isLiveStill(still)) {
          // The still already moved; a twin refusal is toasted by onError.
          try { await moveMut.mutateAsync({ id: still.live_video_id!, kind: "file", targetId }); } catch {}
        }
      }
      toast.success(t("files.status.movedSuccessfully"));
    } else {
      // The twins are appended rather than counted: the toast reports the
      // selection the user made, not the rows the request touched.
      const twinIds = liveTwinIds(files, new Set(fileIds));
      for (const id of [...fileIds, ...twinIds]) {
        try { await moveMut.mutateAsync({ id, kind: "file", targetId }); } catch {}
      }
      for (const id of folderIds) {
        try { await moveMut.mutateAsync({ id, kind: "folder", targetId }); } catch {}
      }
      toast.success(t("files.status.moved"), { description: t("files.description.movedItemCount", { count: String(fileIds.length + folderIds.length) }) });
      clearSelection();
    }
    refresh();
    return true;
  };

  // Drag-to-move. Only the folder listing takes part: the trash, the Hidden
  // view and the library have no folder to move into (and their rows stay
  // undraggable). Moving needs the same permissions as the Move to… entries.
  const canDragMove = !showDeleted && !showHidden && !isLibraryView;
  // New folder / file: the same three views have no folder to create in (the
  // trash and the Hidden view would not even show what was made).
  const canCreateHere = !showDeleted && !showHidden && !isLibraryView;
  const newChoices = useNewChoices(canCreateHere && can("create_folders"), canCreateHere && can("upload_files"));
  /**
   * The drag in flight. Kept in a ref as well as the dataTransfer because a
   * dragover may only read the types, never the data - and the targets need
   * the dragged ids to know whether they are valid.
   */
  const moveDragRef = useRef<{ payload: MovePayload; fromSelection: boolean } | null>(null);
  /** The highlighted target: a folder id, "" for the workspace root, null for none. */
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  /** Folder that files dragged in from the computer will upload into, while one is hovered. */
  const [uploadHover, setUploadHover] = useState<{ key: string; name: string } | null>(null);
  /** OS files can be dropped onto a folder (or crumb) to upload straight into it. */
  const canUploadInto = canDragMove && can("upload_files");
  /** The collapsed crumb menu opened by hovering "…" mid-drag (no click-catcher, closes with the drag). */
  const [crumbsDragOpen, setCrumbsDragOpen] = useState(false);
  const [moveConfirm, setMoveConfirm] = useState<{
    payload: MovePayload; fromSelection: boolean; targetId: string | null; folderName: string;
  } | null>(null);
  const [moveConfirmPending, setMoveConfirmPending] = useState(false);

  const canDragItem = (item: { id: string; kind: "file" | "folder" }) => {
    if (!canDragMove) return false;
    const inSelection = item.kind === "file" ? selected.has(item.id) : selectedFolders.has(item.id);
    // The bulk bar's Move gate for a selection, the context menu's per kind otherwise.
    if (inSelection) return can("upload_files") || can("rename_folders");
    return item.kind === "file" ? can("upload_files") : can("rename_folders");
  };

  const endMoveDrag = () => {
    moveDragRef.current = null;
    setDropTarget(null);
    setCrumbsDragOpen(false);
  };

  /** Props that make a row or tile a drag source. */
  const dragSourceProps = (item: { id: string; name: string; kind: "file" | "folder" }) => {
    if (!canDragItem(item)) return { draggable: false };
    return {
      draggable: true,
      onDragStart: (e: React.DragEvent) => {
        const { fileIds, folderIds, fromSelection } = dragItems(item, selected, selectedFolders);
        const payload: MovePayload = { fileIds, folderIds, name: item.name };
        moveDragRef.current = { payload, fromSelection };
        // A drag that starts on a thumbnail would otherwise also carry the
        // image (and could be dropped on the OS desktop as a file).
        e.dataTransfer.clearData();
        e.dataTransfer.setData(DRAG_MOVE_TYPE, encodeMovePayload(payload));
        e.dataTransfer.effectAllowed = "move";
        setContextMenu(null);
        const count = itemCount(payload);
        if (count > 1) {
          const ghost = document.createElement("div");
          ghost.textContent = t("common.label.item", { count });
          Object.assign(ghost.style, {
            // rtl-ok: pointer coordinates, parked off screen for the drag image
            position: "fixed", top: "-1000px", left: "-1000px",
            padding: "4px 10px", borderRadius: "8px",
            background: "var(--color-primary)", color: "var(--color-primary-fg, #fff)",
            font: "500 12px system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
            whiteSpace: "nowrap", pointerEvents: "none",
          });
          document.body.appendChild(ghost);
          e.dataTransfer.setDragImage(ghost, 0, 0);
          // The browser snapshots the image during dragstart.
          setTimeout(() => ghost.remove(), 0);
        }
      },
      onDragEnd: endMoveDrag,
    };
  };

  /**
   * Props that make a folder row/tile or a breadcrumb a move target. Drags from
   * the OS pass straight through to the page's upload drop zone; an in-app
   * drag stops here, highlighted only where the move would do something.
   */
  const dropTargetProps = (targetId: string | null, folderName: string) => {
    if (!canDragMove) return {};
    const key = targetId ?? "";
    const valid = () => !!moveDragRef.current && isValidDropTarget(targetId, moveDragRef.current.payload, folderId);
    // Files from the computer: a folder other than the open one takes them
    // straight in. The open folder's own crumb is left to the page's drop zone,
    // which already uploads there. dragover is not stopped, so the page keeps
    // its upload overlay; the drop is, so the page does not upload twice.
    const uploadsHere = canUploadInto && (targetId ?? null) !== (uploadFolderId || null);
    const hoverUpload = (e: React.DragEvent) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
      setDropTarget(key);
      setUploadHover((cur) => (cur?.key === key ? cur : { key, name: folderName }));
    };
    return {
      onDragEnter: (e: React.DragEvent) => {
        if (isOsFileDrag(e.dataTransfer.types)) { if (uploadsHere) hoverUpload(e); return; }
        if (!isMoveDrag(e.dataTransfer.types)) return;
        e.stopPropagation();
        if (valid()) { e.preventDefault(); setDropTarget(key); }
      },
      onDragOver: (e: React.DragEvent) => {
        if (isOsFileDrag(e.dataTransfer.types)) { if (uploadsHere) hoverUpload(e); return; }
        if (!isMoveDrag(e.dataTransfer.types)) return;
        e.stopPropagation();
        if (!valid()) { e.dataTransfer.dropEffect = "none"; return; }
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        // Re-asserted on every dragover, so a leave fired by a child (or out
        // of order with the next enter) never leaves the target dark.
        setDropTarget(key);
      },
      onDragLeave: (e: React.DragEvent) => {
        const osFiles = isOsFileDrag(e.dataTransfer.types);
        if (!osFiles && !isMoveDrag(e.dataTransfer.types)) return;
        if (!osFiles) e.stopPropagation();
        const to = e.relatedTarget as Node | null;
        if (to && e.currentTarget.contains(to)) return;
        setDropTarget((cur) => (cur === key ? null : cur));
        if (osFiles) setUploadHover((cur) => (cur?.key === key ? null : cur));
      },
      onDrop: (e: React.DragEvent) => {
        if (isOsFileDrag(e.dataTransfer.types)) {
          if (!uploadsHere) return; // the page's drop zone uploads to the open folder
          e.preventDefault();
          e.stopPropagation();
          setDragging(false);
          setDropTarget(null);
          setUploadHover(null);
          uploadDropped(e.dataTransfer, targetId ?? null);
          return;
        }
        if (!isMoveDrag(e.dataTransfer.types)) return;
        e.preventDefault();
        e.stopPropagation();
        const drag = moveDragRef.current;
        const payload = decodeMovePayload(e.dataTransfer.getData(DRAG_MOVE_TYPE)) ?? drag?.payload ?? null;
        endMoveDrag();
        if (!payload || !isValidDropTarget(targetId, payload, folderId)) return;
        setMoveConfirm({ payload, fromSelection: drag?.fromSelection ?? false, targetId, folderName });
      },
    };
  };

  const confirmDragMove = async () => {
    if (!moveConfirm || moveConfirmPending) return;
    const { payload, fromSelection, targetId } = moveConfirm;
    setMoveConfirmPending(true);
    try {
      await runMove({ fileIds: payload.fileIds, folderIds: payload.folderIds, targetId, bulk: itemCount(payload) > 1 });
      if (fromSelection) clearSelection();
    } finally {
      setMoveConfirmPending(false);
      setMoveConfirm(null);
    }
  };

  /** Names for the confirm's list, looked up from the listing (ids it no longer shows are skipped). */
  const moveConfirmNames = moveConfirm
    ? itemCount(moveConfirm.payload) === 1
      ? [moveConfirm.payload.name]
      : [
        ...moveConfirm.payload.folderIds.map((id) => allFolders.find((f) => f.id === id)?.name),
        ...moveConfirm.payload.fileIds.map((id) => allFiles.find((f) => f.id === id)?.name),
      ].filter((n): n is string => !!n)
    : [];

  // Selection is per-view. The folder listing clears it on navigation
  // (navigateToFolder), but the library has no folder to navigate into: it
  // is entered and left through the sidebar, and re-cut by its kind, by its
  // own sort, by the search, and by the workspace it reads. The key is
  // constant outside the library, so this fires only on the way in, on the way
  // out, and while the library is on screen. The kind has to be in it as much
  // as the workspace id does: hopping Videos -> Documents replaces every item
  // on screen, and a selection carried over would leave the bulk bar acting on
  // ids the view no longer shows.
  const libraryViewKey = isLibraryView ? `${libraryKind}|${active?.id ?? ""}|${photoSort}|${search}` : "";
  useEffect(() => { clearSelection(); }, [isLibraryView, libraryViewKey, clearSelection]);

  // ── Deep links: ?view=<id> / ?panel=<id> (web parity) ──────

  useEffect(() => {
    // In library mode the listing query is disabled, so `data` never arrives -
    // wait on the library feed instead, or a ?view=/?panel= link into the
    // library would never restore.
    if (isLibraryView ? library.isLoading : isLoading || !data) return;
    restorePassed.current = true;
    const decision = restoreTarget(searchParams, lastRestoredId.current);
    if (decision.type === "clear") { lastRestoredId.current = null; return; }
    if (decision.type === "noop") return;
    const { id, action } = decision;
    const inList = allFiles.find((f) => f.id === id);
    if (inList) { openFileWithLockCheck(inList, action); lastRestoredId.current = id; return; }
    let cancelled = false;
    (async () => {
      let opened = false;
      try {
        const res = await api.get<{ ok: boolean; file?: FileRow }>(`/api/files/${id}`);
        if (!cancelled && res.ok && res.file) {
          openFileWithLockCheck(res.file, action);
          opened = true;
        }
      } catch { /* stale or deleted file: cleared below */ }
      finally {
        if (!cancelled) {
          lastRestoredId.current = id;
          // Drop the dead param here. The mirror effect cannot do it - it
          // runs on [viewerFile, panel], and nothing opened, so neither
          // changed and it never fires. Without this the URL keeps naming a
          // file that no longer exists, and a reload re-fetches a 404 every
          // time. Removing `view`/`panel` makes the next pass of the restore
          // effect take its "clear" branch, which resets lastRestoredId and
          // stops, so this cannot loop.
          if (!opened) {
            setSearchParams((prev) => {
              const next = new URLSearchParams(prev);
              next.delete("view");
              next.delete("panel");
              return next.toString() === prev.toString() ? prev : next;
            }, { replace: true });
          }
        }
      }
    })();
    // A param change before this fetch resolves re-runs the effect, which
    // runs this cleanup first - `cancelled` stops the stale response from
    // opening the wrong file (or marking a id no longer in the params as
    // "restored").
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isLoading, data, isLibraryView, library.isLoading, searchParams]);

  // Mirror the open viewer/panel into the URL so it survives a reload.
  //
  // `viewerFile`/`panel` are this effect's only deps, so EVERY way either one
  // can change - a row click, a context-menu open, next/prev navigation, an
  // unlock, a close, or the restore effect's own open - runs this effect.
  // That makes it the single funnel to record "what the url now reflects
  // is state we already have": set `lastRestoredId` here, before writing
  // the params, so the restore effect that this write re-triggers (via its
  // own `searchParams` dependency) sees a match and decides `noop` instead
  // of opening the same file a second time. Without this, a plain click
  // would: setPanel -> mirror writes ?panel=<id> -> searchParams changes ->
  // restore effect re-runs with a stale (pre-click) `lastRestoredId` ->
  // sees a "new" id -> calls openFileWithLockCheck again.
  useEffect(() => {
    lastRestoredId.current = viewerFile?.id ?? panel?.file.id ?? null;
    if (!restorePassed.current) return;
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      if (viewerFile) { next.set("view", viewerFile.id); next.delete("panel"); }
      else if (panel) { next.set("panel", panel.file.id); next.delete("view"); }
      else { next.delete("view"); next.delete("panel"); }
      // `versions=1` rides along only while the panel it opened is the one shown.
      if (panel?.versions && !viewerFile) next.set("versions", "1");
      else next.delete("versions");
      return next.toString() === prev.toString() ? prev : next;
    }, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewerFile, panel]);

  // ── Upload plumbing (drag-and-drop + new version) ──────────

  // Takes an explicit folder per file rather than reading `folderId` for all of
  // them: a dropped folder tree lands across many folders in one batch.
  const uploadFiles = useCallback(async (targets: { file: File; folderId: string | null }[]) => {
    // fileIds/errors: what New > file needs - the id to open or select, and
    // the server's sentence when it refused.
    const fileIds: string[] = [];
    const errors: string[] = [];
    if (!active?.id) return { uploaded: 0, failed: 0, fileIds, errors };
    let uploaded = 0;
    let failed = 0;
    for (const { file, folderId: target } of targets) {
      try {
        // Single PUT under 50 MB, resumable parts above - the edge refuses
        // any one request body over 100 MB, so a big file must be split.
        const out = await uploadFileInParts(
          {
            file, fileName: file.name, mimeType: file.type,
            workspaceId: active.id, folderId: target,
            lastModifiedMs: file.lastModified,
            signal: uploadAbortRef.current?.signal,
          },
          uploadTransport,
        );
        uploaded++;
        if (out.fileId) fileIds.push(out.fileId);
      } catch (err) {
        // Page unmounted (logout/navigation) mid-upload - stop silently,
        // don't count the aborted-and-unattempted rest as failures.
        if (isUploadCancelled(err) || (err as { name?: string })?.name === "AbortError") break;
        failed++;
        if (err instanceof Error && err.message) errors.push(err.message);
      }
    }
    return { uploaded, failed, fileIds, errors };
  }, [active?.id]);

  /** Find-or-create one folder; the server reuses an existing row by name. */
  const createFolder = useCallback(async (name: string, parentId: string | null) => {
    const res = await api.post<{ ok: boolean; folder?: { id: string }; error?: string }>("/api/folders", {
      workspace_id: active?.id, parent_id: parentId, name,
    });
    if (!res.ok || !res.folder?.id) throw new Error(res.error ?? t("common.error.couldNotCreateFolder"));
    return res.folder.id;
  }, [active?.id, t]);

  // ── New (toolbar dropdown + right-click on empty space) ─────

  const pickNew = (choice: NewChoice) => {
    setBlankMenu(null);
    if (choice === "folder") setShowCreateFolder(true);
    else setNewFileKind(choice);
  };

  /** Right-click on the listing's empty space. Rows and tiles open their own menu first. */
  const openBlankMenu = (e: React.MouseEvent) => {
    if (e.isDefaultPrevented() || newChoices.length === 0) return;
    e.preventDefault();
    setContextMenu(null);
    setBlankMenu({ x: e.clientX, y: e.clientY });
  };

  /**
   * Creates a blank file in the open folder. Answers with a sentence for the
   * dialog to show (the name is taken), "" to stay open after a toast (the
   * upload failed), or null once the file exists.
   *
   * The upload API turns a same-name upload into a new version of the file
   * already there, so a taken name never reaches it: the loaded rows are
   * checked first, then the API, for rows this page does not have.
   */
  const createBlankFile = async (kind: NewFileKind, name: string): Promise<string | null> => {
    if (!active?.id) return t("files.error.fileCouldNotBeCreated");
    const target = uploadFolderId || null;
    const taken = t("files.error.aFileWithThisNameAlreadyExists");
    if (nameTaken(name, [...allFiles, ...allFolders])) return taken;
    try {
      if (await nameTakenInFolder(api.get, active.id, target, name)) return taken;
    } catch (err) {
      return err instanceof Error && err.message ? err.message : t("files.error.fileCouldNotBeCreated");
    }
    const file = new File([blankFileBytes(kind)], name, { type: NEW_FILE_TYPES[kind].mime });
    const { uploaded, fileIds, errors } = await uploadFiles([{ file, folderId: target }]);
    if (!pageAliveRef.current) return null;
    if (uploaded === 0) {
      // Nothing failed either: the upload was cancelled because the page is going away.
      if (errors.length === 0) return null;
      toast.error(t("files.error.fileCouldNotBeCreated"), { description: errors[0] });
      return "";
    }
    toast.success(t("files.status.createdName", { name }));
    refresh();
    const id = fileIds[0];
    if (id && kind === "word") {
      // Same route as "Open in editor".
      navigate(`/editor/${id}`);
    } else if (id) {
      // Markdown and text open in the text editor, like Word opens in its
      // own. `back` lets its close return here instead of to the folder root.
      navigate(`/text-editor/${id}`, { state: { back: true } });
    }
    return null;
  };

  // The empty-space menu holds no focus, so Escape is heard on the document.
  useEffect(() => {
    if (!blankMenu) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setBlankMenu(null); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [blankMenu]);

  // Scroll a just-created file into view once the refreshed listing renders it.
  useEffect(() => {
    if (!revealId) return;
    const el = document.getElementById(`file-${revealId}`);
    if (!el) return;
    el.scrollIntoView?.({ block: "nearest" });
    setRevealId(null);
  }, [revealId, allFiles]);

  // An in-app move drag (rows and tiles carry DRAG_MOVE_TYPE) is not an
  // upload: the zone neither shows its overlay nor accepts the drop, so
  // releasing one anywhere but a move target does nothing.
  const handleDragOver = (e: React.DragEvent) => { if (isMoveDrag(e.dataTransfer.types)) return; e.preventDefault(); e.stopPropagation(); if (!showDeleted) setDragging(true); };
  const handleDragLeave = (e: React.DragEvent) => {
    if (isMoveDrag(e.dataTransfer.types)) return;
    e.preventDefault(); e.stopPropagation();
    if (e.currentTarget === e.target) { setDragging(false); setDropTarget(null); setUploadHover(null); }
  };
  // Not `async`, and it must stay that way: readDroppedEntries reads
  // dataTransfer.items - the only API that can see inside a dropped folder -
  // before its own first await, and that list is dead once this handler
  // returns. Passing dataTransfer.files instead (as this used to) handed the
  // uploader an unreadable directory handle for the folder itself.
  const handleDrop = (e: React.DragEvent) => {
    if (isMoveDrag(e.dataTransfer.types)) { e.preventDefault(); endMoveDrag(); return; }
    e.preventDefault(); e.stopPropagation(); setDragging(false); setDropTarget(null); setUploadHover(null);
    // "" is the URL's spelling of the workspace root; the API and the folder plan speak null.
    uploadDropped(e.dataTransfer, uploadFolderId || null);
  };

  /**
   * Uploads what was dropped into `root` (null = workspace root): the open
   * folder from the page's drop zone, or a folder row / tile / crumb the files
   * were released on. Must be called synchronously from the drop handler -
   * see readDroppedEntries above.
   */
  const uploadDropped = (dataTransfer: DataTransfer, root: string | null) => {
    if (showDeleted || !active?.id) return;

    void readDroppedEntries(dataTransfer).then(async (tree) => {
      if (tree.entries.length === 0 && tree.dirs.length === 0) return;

      // Screen before a single folder is created. The tree recreation below is
      // a round trip per folder, so building it for files this workspace was
      // never going to accept is the expensive half of finding out late.
      if (tree.entries.length > 0) {
        const limits = await fetchUploadLimits(active.id);
        if (!pageAliveRef.current) return;
        const rejected: { name: string; reason: string }[] = [];
        const accepted = tree.entries.filter((entry) => {
          const reason = uploadFileError(
            { name: entry.file.name, size: entry.file.size }, limits,
          );
          if (reason) { rejected.push({ name: entry.file.name, reason }); return false; }
          return true;
        });
        if (rejected.length > 0) {
          toast.error(
            accepted.length > 0
              ? t("files.label.fileLeftOut", { rejectedCount: rejected.length })
              : t("files.label.nothingCouldBeUploaded"),
            // One file: its name isolated, the reason (a translation)
            // following the page. Otherwise the translated summary as is.
            { description: rejected.length === 1 ? namedLine(rejected[0].name, rejected[0].reason) : rejectionsSummary(rejected) },
          );
        }
        if (accepted.length === 0) return;
        const fit = checkBatchFitsQuota(
          accepted.reduce((n, entry) => n + entry.file.size, 0), limits,
        );
        if (!fit.fits) {
          toast.warning(t("files.label.thisMayNotAllFit"), {
            description: t("files.error.thisUploadIsLargerThanTheSpaceLeftIn"),
          });
        }
        tree = { ...tree, entries: accepted };
      }

      let plan: FolderPlan = { ids: new Map(), failed: [] };
      if (tree.hadDirectory) {
        const dirs = orderedDirs(tree);
        // Recreating a deep tree is a round trip per folder - say so up front,
        // or the drop looks dead until the first file finishes.
        toast.info(t("common.label.uploadingFolder"), {
          description: t("common.description.recreatingFolderThenUploadingFile", { dirCount: dirs.length, entryCount: tree.entries.length }),
        });
        plan = await createFolderTree(dirs, root, createFolder);
        if (!pageAliveRef.current) return;
        if (plan.failed.length > 0) {
          toast.error(t("common.error.someFoldersCouldNotBeCreated"), {
            description: t("common.error.folderFailedError", { failedCount: plan.failed.length, error: plan.error ?? "" }).trim(),
          });
        }
        // Folders exist before their files finish, so show them now.
        if (plan.ids.size > 0) refresh();
      }

      const { targets, skipped } = resolveTargets(tree.entries, plan, root);
      if (skipped > 0 && pageAliveRef.current) {
        toast.error(t("common.label.someFilesWereSkipped"), {
          description: t("common.description.fileHadNoFolderToGoIn", { skipped }),
        });
      }
      if (tree.skipped > 0 && pageAliveRef.current) {
        toast.error(t("common.error.tooManyFilesInOneGo"), {
          description: t("files.description.onlyTheFirstMaxDroppedFilesFilesWereUploadedSkippedLeft", {
            maxDroppedFiles: MAX_DROPPED_FILES.toLocaleString(intlLocale()), skipped: String(tree.skipped),
          }),
        });
      }
      if (targets.length === 0) {
        if (tree.hadDirectory && plan.ids.size > 0 && pageAliveRef.current) {
          toast.success(t("common.label.folderCreated"), { description: t("common.description.thereWereNoFilesInsideToUpload") });
        }
        return;
      }

      const { uploaded, failed } = await uploadFiles(targets);
      if (!pageAliveRef.current) return; // page (or session) is gone - no toasts
      if (uploaded > 0) {
        toast.success(t("common.status.uploaded"), { description: t("files.message.fileUploaded", { count: uploaded }) });
        refresh();
      }
      if (failed > 0) {
        toast.error(t("files.error.someUploadsFailed"), { description: t("files.error.fileCouldNotBeUploaded", { count: failed }) });
      }
    });
  };

  const handleVersionUpload = async (fileId: string, file: File) => {
    if (!active?.id) return;
    try {
      // No folderId: a new version stays in the file's own folder. Big
      // versions go through the part API like any other large upload.
      await uploadFileInParts(
        {
          file, fileName: file.name, mimeType: file.type,
          workspaceId: active.id, fileId,
          lastModifiedMs: file.lastModified,
          signal: uploadAbortRef.current?.signal,
        },
        uploadTransport,
      );
      if (!pageAliveRef.current) return;
      toast.success(t("files.label.versionUploaded"), { description: t("files.description.theFileNowPointsToYourNewVersion") });
      refresh();
    } catch (err) {
      if (!pageAliveRef.current || isUploadCancelled(err)) return;
      const why = err instanceof ApiError && err.message ? autoDir(err.message) : err instanceof Error && err.message ? err.message : t("files.error.theNewVersionCouldNotBeUploaded");
      toast.error(t("common.error.uploadFailed"), { description: why });
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

  // ── Application menu ───────────────────────────────────────

  // What File and View need to enable and check: the folder listing's layout
  // (the library keeps its own per-kind layout, so it reports none) and how
  // much is selected. Reset when the page unmounts so a stale count cannot
  // leave "Download Selected…" lit on the dashboard.
  useMenuState(
    {
      viewMode: isLibraryView ? null : viewMode,
      // Trashed items are restored or purged, never downloaded, shared or
      // inspected, so the trash reports no selection to the menu.
      selectionCount: showDeleted ? 0 : selected.size + selectedFolders.size,
    },
    { viewMode: null, selectionCount: 0 },
  );

  useMenuActions((action) => {
    if (action.kind === "view") {
      if (!isLibraryView) setViewMode(action.mode);
      return true;
    }
    if (action.kind !== "simple") return false;
    switch (action.id) {
      case "new-folder":
        if (!showDeleted && !isLibraryView) setShowCreateFolder(true);
        return true;
      case "download-selected": {
        if (!can("download_files") || (selected.size === 0 && selectedFolders.size === 0)) return true;
        void (async () => {
          try {
            const r = await window.electronAPI.downloadArchive(Array.from(selected), Array.from(selectedFolders));
            if (r.ok) toast.success(t("common.status.downloaded"), { description: r.path ? t("common.description.savedToPath", { path: r.path }) : t("common.description.savedToDisk") });
            else if (!r.canceled) toast.error(t("common.error.downloadFailed"));
          } catch (e: any) {
            toast.error(e instanceof ApiError ? autoDir(e.message) : t("common.error.failed"));
          }
        })();
        return true;
      }
      case "share-selected": {
        if (!can("create_share_links")) return true;
        // A share link names one file or one folder (ShareTarget), the same
        // rule the toolbar's Share button follows.
        const fileIds = Array.from(selected);
        const folderIds = Array.from(selectedFolders);
        if (fileIds.length === 1 && folderIds.length === 0) {
          const file = allFiles.find((f) => f.id === fileIds[0]);
          setShareTarget({ target: { kind: "file", fileIds: [fileIds[0]] }, name: file?.name ?? t("files.label.file") });
        } else if (folderIds.length === 1 && fileIds.length === 0) {
          const folder = allFolders.find((f) => f.id === folderIds[0]);
          setShareTarget({ target: { kind: "folder", folderId: folderIds[0] }, name: folder?.name ?? t("files.label.folder") });
        } else if (fileIds.length + folderIds.length > 0) {
          toast.error(t("files.label.selectOneFileOrOneFolderToShare"));
        }
        return true;
      }
      case "toggle-details": {
        if (panel) { setPanel(null); return true; }
        if (showDeleted || selected.size !== 1 || selectedFolders.size !== 0) return true;
        const file = allFiles.find((f) => f.id === Array.from(selected)[0]);
        if (file) setPanel({ file, tab: "info" });
        return true;
      }
      default:
        return false;
    }
  });

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
        setDeleteConfirm(fileDeleteConfirm(panel.file));
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
    if (fail === 0) toast.success(t("files.status.restored"), { description: t("files.description.itemRestored", { ok }) });
    else toast.error(t("files.error.someItemsCouldNotBeRestored"), { description: t("files.error.okRestoredFailFailed", { ok: String(ok), fail: String(fail) }) });
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
    // A trashed FOLDER empties in bounded passes: the server answers 202
    // `complete: false` when its round-trip budget runs out, and the call is
    // idempotent, so finishing the job is asking again. Counting that first
    // 202 as a deleted item is what reported success over a folder that was
    // still half full - see lib/folder-purge.ts.
    const incomplete: UnfinishedFolder[] = [];
    for (const id of selectedFolders) {
      const name = allFolders.find((f) => f.id === id)?.name ?? id;
      try {
        const outcome = await purgeTrashedFolder(() => api.delete<PurgeResponse>(`/api/folders/${id}`));
        if (outcome.complete) ok++;
        else incomplete.push({ name, filesAffected: outcome.filesAffected, remaining: outcome.remaining });
      } catch { fail++; }
    }
    showPurgeMessage(bulkPurgeSummary({ deleted: ok, failed: fail, incomplete }));
    clearSelection();
    refresh();
  };

  /** One place decides which toast a purge outcome deserves. */
  const showPurgeMessage = (msg: PurgeMessage) => {
    if (msg.kind === "success") toast.success(msg.title, { description: msg.body });
    else if (msg.kind === "info") toast.info(msg.title, { description: msg.body });
    else toast.error(msg.title, { description: msg.body });
  };

  // Row-level restore from the trash context menu (Restore/Delete permanently
  // are the only two actions offered there - see the context menu below).
  const restoreItem = async (id: string, kind: "file" | "folder") => {
    try {
      await api.put(kind === "folder" ? `/api/folders/${id}` : `/api/files/${id}`);
      toast.success(t("files.status.restored"));
      refresh();
    } catch (e) {
      toast.error(e instanceof ApiError ? autoDir(e.message) : t("files.error.restoreFailed"));
    }
  };

  const visibleCols = ALL_COLUMNS.filter((c) => visibleColumns.has(c.key));

  // The library's own column set, built once and used twice: the picker lists
  // all of it, the table gets the visible ones. Null outside the library, where
  // the picker falls back to ALL_COLUMNS and the table below has no columns to
  // render at all.
  const libraryColumns = libraryKind ? libraryColumnsFor(libraryKind) : null;
  const pickerColumns = libraryColumns ?? ALL_COLUMNS;
  // `taken` is the date the library is ordered by, so it is on whatever the
  // saved set says - like Name, it cannot be switched off, and it is never part
  // of the folder listing's saved set in the first place.
  const activeColumns = libraryColumns?.filter((c) => c.key === "taken" || visibleColumns.has(c.key)) ?? [];

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
            <p className="text-sm font-semibold">{t("files.label.dropFilesOrFoldersToUpload")}</p>
            <p className="text-xs opacity-70">{uploadHover
              ? t("files.description.toValueName", { valueName: uploadHover.name })
              : uploadFolderId ? t("files.description.toValueName", { valueName: breadcrumbs.at(-1)?.name ?? t("files.label.folder") }) : t("files.label.toRootFolder")}</p>
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
          {/* Breadcrumbs. The library spans every folder, so there is no path
              to walk: its name and its size take the trail's place. */}
          {libraryKind ? (
            <div className="flex min-w-0 items-center gap-2.5 text-sm">
              <LibraryIcon size={16} className="shrink-0" />
              <span className="font-semibold">{t(KIND_COPY[libraryKind].title)}</span>
              <span className="truncate whitespace-nowrap text-xs tabular-nums text-[var(--color-text-muted)]">
                {library.isLoading ? t("common.status.loading") : t("files.status.photoAllFolders", { count: library.total, kind: libraryKind })}
              </span>
            </div>
          ) : (
          <div className="flex min-w-0 items-center gap-1 text-sm">
            <button
              onClick={() => setSearchParams({})}
              {...dropTargetProps(null, t("common.label.files"))}
              className={`-mx-1 shrink-0 rounded px-1 text-[var(--color-text-secondary)] hover:text-[var(--color-text)] ${dropTarget === "" ? CRUMB_DROP_ACTIVE : ""}`}
            >
              {t("common.label.files")}
            </button>

            {/* Past a few levels the middle of the trail collapses behind a "…"
                menu. Truncation alone is not enough here - the useful ends of a
                path are its root and where you are standing, and squeezing
                every level equally hides both. */}
            {hiddenCrumbs.length > 0 && (
              <span className="relative flex shrink-0 items-center gap-1">
                <ChevronRight size={14} className="text-[var(--color-text-muted)] rtl:-scale-x-100" />
                <button
                  onClick={() => setCrumbsOpen((v) => !v)}
                  // Mid-drag, hovering "…" springs the hidden ancestors open
                  // so they can take the drop too.
                  onDragEnter={(e) => {
                    if (!canDragMove || !moveDragRef.current || !isMoveDrag(e.dataTransfer.types)) return;
                    e.stopPropagation();
                    setCrumbsDragOpen(true);
                  }}
                  title={hiddenCrumbs.map((c) => c.name).join(" / ")}
                  aria-label={t("files.accessibility.showHiddenFolder", { hiddenCrumbCount: hiddenCrumbs.length })}
                  aria-expanded={crumbsOpen}
                  className="rounded px-1 leading-none text-[var(--color-text-muted)] hover:bg-[var(--color-bg-tertiary)] hover:text-[var(--color-text)]"
                >
                  …
                </button>
                {(crumbsOpen || crumbsDragOpen) && (
                  <>
                    {/* The click-catcher only for a click-opened menu: during a
                        drag it would sit over every row and tile target. */}
                    {crumbsOpen && <div className="fixed inset-0 z-40" onClick={() => setCrumbsOpen(false)} />}
                    <div
                      className="absolute inset-s-4 top-6 z-50 max-h-64 w-56 overflow-y-auto rounded-lg border py-1 shadow-lg"
                      style={{ borderColor: "var(--color-border)", background: "var(--color-bg)" }}
                    >
                      {hiddenCrumbs.map((c) => (
                        <button
                          key={c.id}
                          onClick={() => { setCrumbsOpen(false); navigateToFolder(c.id); }}
                          {...dropTargetProps(c.id, c.name)}
                          dir={ownDir}
                          className={`block w-full truncate px-3 py-1.5 text-start text-xs text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-secondary)] hover:text-[var(--color-text)] ${dropTarget === c.id ? "bg-[var(--color-primary)]/10 text-[var(--color-primary)] outline outline-1 -outline-offset-1 outline-[var(--color-primary)]" : ""}`}
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
                <ChevronRight size={14} className="shrink-0 text-[var(--color-text-muted)] rtl:-scale-x-100" />
                <button
                  onClick={() => navigateToFolder(bc.id)}
                  {...dropTargetProps(bc.id, bc.name)}
                  title={bc.name}
                  dir={ownDir}
                  // The folder you are in keeps the most room; its ancestors
                  // give way first, which is the order you can afford to lose.
                  className={`-mx-1 truncate rounded px-1 text-[var(--color-text-secondary)] hover:text-[var(--color-text)] ${
                    i === shownCrumbs.length - 1 ? "max-w-[22rem] font-medium text-[var(--color-text)]" : "max-w-[10rem]"
                  } ${dropTarget === bc.id ? CRUMB_DROP_ACTIVE : ""}`}
                >
                  {bc.name}
                </button>
              </span>
            ))}
          </div>
          )}
        </div>
        {/* Wraps internally too. Making only the outer header wrap moved the
            whole toolbar onto its own line but kept it one unbreakable row, so
            at 700px Upload still sat ~100px past the right edge - off screen
            and, because nothing here scrolls sideways, unreachable. */}
        <div className="flex flex-wrap items-center justify-end gap-2">
          {/* Search */}
          <div className="relative">
            {/* The magnifier turns into a spinner from the first keystroke
                until the results for that text are on screen: the typing
                pause plus the request, which otherwise looked like nothing
                was happening. */}
            {searching ? (
              <Loader2
                size={14}
                aria-hidden
                data-testid="files-search-spinner"
                className="absolute inset-s-2.5 top-1/2 -translate-y-1/2 animate-spin text-[var(--color-primary)]"
              />
            ) : (
              <Search
                size={14}
                className="absolute inset-s-2.5 top-1/2 -translate-y-1/2 text-[var(--color-text-muted)]"
              />
            )}
            <input
              type="text"
              value={searchInput}
              onChange={(e) => {
                setSearchInput(e.target.value);
                // Emptying the box restores the full listing at once rather
                // than after the typing pause.
                if (e.target.value === "") commitSearch("");
              }}
              onKeyDown={(e) => e.key === "Enter" && commitSearch(searchInput)}
              aria-busy={searching}
              placeholder={libraryKind ? t(KIND_COPY[libraryKind].searchPlaceholder) : t("files.placeholder.searchFiles")}
              // Was a hard 200px, which is a lot to spend on one control in a
              // 700px window. It now gives way down to 120 before anything
              // else in the row has to.
              className="w-[200px] min-w-[120px] max-w-full rounded-lg border py-1.5 ps-8 pe-3 text-sm outline-none focus:border-[var(--color-primary)]"
              style={{ borderColor: "var(--color-border)" }}
            />
          </div>

          {/* Sort. The library orders by the item's own date - when a photo was
              taken, when a video or document was created - which none of the
              folder listing's six orders can express. */}
          {libraryKind ? (
            <select
              value={photoSort}
              onChange={(e) => setPhotoSort(e.target.value as LibrarySort)}
              aria-label={t("files.accessibility.sortPhotos", { kind: libraryKind })}
              className="rounded-lg border px-2.5 py-1.5 text-sm outline-none"
              style={{ borderColor: "var(--color-border)" }}
            >
              {sortOptionsFor(libraryKind).map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
          ) : (
          <select
            value={sort}
            onChange={(e) => setSort(e.target.value)}
            className="rounded-lg border px-2.5 py-1.5 text-sm outline-none"
            style={{ borderColor: "var(--color-border)" }}
          >
            <option value="newest">{t("files.option.newest")}</option>
            <option value="oldest">{t("files.option.oldest")}</option>
            <option value="name_asc">{t("files.option.nameAZ")}</option>
            <option value="name_desc">{t("files.option.nameZA")}</option>
            <option value="largest">{t("files.option.largest")}</option>
            <option value="smallest">{t("files.option.smallest")}</option>
            {/* A column-header sort (e.g. Comments) is not one of the six
                presets; list it so the menu still names the active order. */}
            {!PRESET_SORTS.has(sort) && (
              <option value={sort}>
                {t("files.label.allColumnsfindcSortdirascSelectTrueOther", {
                  ALL_COLUMNSFindC: ALL_COLUMNS.find((c) => c.key === sortSpec.key)?.label ?? sortSpec.key,
                  sortDirAsc: sortSpec.dir === "asc" ? "true" : "false",
                })}
              </option>
            )}
          </select>
          )}

          {/* View toggle. Every library kind can be tiles or a table now, so the
              library gets the same List/Grid pair the folder listing has - bound
              to its own per-kind preference, not `viewMode`. The tile-size
              toggle follows the tiles only (documents included, now that they
              can be a grid); a table is one size, and gets the column picker
              below instead. */}
          {isLibraryView ? (
            <>
              <div className="flex rounded-lg border" style={{ borderColor: "var(--color-border)" }}>
                <button
                  onClick={() => changeLibraryLayout("list")}
                  aria-label={t("files.accessibility.listView")}
                  aria-pressed={libraryLayout === "list"}
                  title={t("files.accessibility.listView")}
                  className={`p-1.5 ${libraryLayout === "list" ? "bg-[var(--color-bg-tertiary)]" : ""}`}
                >
                  <LayoutList size={16} />
                </button>
                <button
                  onClick={() => changeLibraryLayout("grid")}
                  aria-label={t("files.accessibility.gridView")}
                  aria-pressed={libraryLayout === "grid"}
                  title={t("files.accessibility.gridView")}
                  className={`p-1.5 ${libraryLayout === "grid" ? "bg-[var(--color-bg-tertiary)]" : ""}`}
                >
                  <LayoutGrid size={16} />
                </button>
              </div>
              {/* Zoom glyphs, not a second pair of grid marks: sitting beside the
                  layout toggle, a shared Grid icon made the two controls read as
                  one. The titles are unchanged. */}
              {libraryLayout === "grid" && (
                <div className="flex rounded-lg border" style={{ borderColor: "var(--color-border)" }}>
                  <button
                    onClick={() => setTileSize("small")}
                    aria-label={t("files.accessibility.smallTiles")}
                    aria-pressed={tileSize === "small"}
                    title={t("files.accessibility.smallTiles")}
                    className={`p-1.5 ${tileSize === "small" ? "bg-[var(--color-bg-tertiary)]" : ""}`}
                  >
                    <ZoomOut size={16} />
                  </button>
                  <button
                    onClick={() => setTileSize("large")}
                    aria-label={t("files.accessibility.largeTiles")}
                    aria-pressed={tileSize === "large"}
                    title={t("files.accessibility.largeTiles")}
                    className={`p-1.5 ${tileSize === "large" ? "bg-[var(--color-bg-tertiary)]" : ""}`}
                  >
                    <ZoomIn size={16} />
                  </button>
                </div>
              )}
            </>
          ) : (
          <div className="flex rounded-lg border" style={{ borderColor: "var(--color-border)" }}>
            <button
              onClick={() => setViewMode("table")}
              aria-label={t("files.accessibility.listView")}
              aria-pressed={viewMode === "table"}
              title={t("files.accessibility.listView")}
              className={`p-1.5 ${viewMode === "table" ? "bg-[var(--color-bg-tertiary)]" : ""}`}
            >
              <LayoutList size={16} />
            </button>
            <button
              onClick={() => setViewMode("card")}
              aria-label={t("files.accessibility.gridView")}
              aria-pressed={viewMode === "card"}
              title={t("files.accessibility.gridView")}
              className={`p-1.5 ${viewMode === "card" ? "bg-[var(--color-bg-tertiary)]" : ""}`}
            >
              <LayoutGrid size={16} />
            </button>
          </div>
          )}

          {/* Column picker. One picker, two tables: the folder listing's list
              view and the library's, each gated on the mode that owns it. */}
          {((viewMode === "table" && !isLibraryView) || (isLibraryView && libraryLayout === "list")) && (
            <div className="relative">
              <button
                onClick={() => setColumnPickerOpen((v) => !v)}
                className={`flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-sm ${columnPickerOpen ? "bg-[var(--color-bg-tertiary)]" : ""}`}
                style={{ borderColor: "var(--color-border)" }}
                title={t("files.tooltip.tableColumns")}
              >
                <SlidersHorizontal size={14} /> {t("files.action.columns")}
              </button>
              {columnPickerOpen && (
                <>
                  <div className="fixed inset-0 z-40" onClick={() => setColumnPickerOpen(false)} />
                  <div
                    className="absolute inset-e-0 z-50 mt-1 w-44 rounded-lg border bg-[var(--color-bg)] py-1 shadow-lg"
                    style={{ borderColor: "var(--color-border)" }}
                  >
                    {pickerColumns.map((col) => {
                      // Name anchors the table, and the library's primary date is
                      // what its rows are ordered by: both are forced on. `taken`
                      // only exists in the library's set, so the folder listing's
                      // picker behaves exactly as it did.
                      const locked = col.key === "name" || col.key === "taken";
                      return (
                        <label
                          key={col.key}
                          className={`flex w-full items-center gap-2 px-3 py-1.5 text-xs ${locked ? "opacity-50" : "cursor-pointer hover:bg-[var(--color-bg-secondary)]"}`}
                        >
                          <input
                            type="checkbox"
                            checked={col.key === "taken" || visibleColumns.has(col.key)}
                            disabled={locked}
                            onChange={() => toggleColumn(col.key)}
                            className="accent-[var(--color-primary)]"
                          />
                          {col.label}
                        </label>
                      );
                    })}
                  </div>
                </>
              )}
            </div>
          )}

          {/* New: folder or a blank file */}
          <NewMenuButton choices={newChoices} onPick={pickNew} />

          {/* Upload */}
          {!showDeleted && (
            <button
              onClick={() => navigate("/upload")}
              className="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium text-[var(--color-primary-fg)]"
              style={{ background: "var(--color-primary)" }}
            >
              <Upload size={14} />
              {t("common.action.upload")}
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
          {t("files.description.itemsInTheTrashStillCountAgainstYourStorage")}
        </div>
      )}

      {/* Bulk Actions */}
      {totalSelected > 0 && (
        <div className="mb-3 flex flex-wrap items-center gap-3 rounded-lg bg-[var(--color-bg-tertiary)] px-4 py-2 text-sm">
          <span className="font-medium">{t("files.label.totalselectedSelected", { totalSelected: String(totalSelected) })}</span>
          {showDeleted ? (
            <>
              <button
                className="flex items-center gap-1 text-[var(--color-text-secondary)] hover:text-[var(--color-text)]"
                onClick={bulkRestore}
              >
                <RotateCcw size={14} /> {t("files.action.restore")}
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
                <Trash2 size={14} /> {t("files.action.deletePermanently")}
              </button>
            </>
          ) : (
            <>
              {can("download_files") && <button
                className="flex items-center gap-1 text-[var(--color-text-secondary)] hover:text-[var(--color-text)]"
                onClick={async () => {
                  try {
                    const r = await window.electronAPI.downloadArchive(Array.from(selected), Array.from(selectedFolders));
                    if (r.ok) toast.success(t("common.status.downloaded"), { description: r.path ? t("common.description.savedToPath", { path: r.path }) : t("common.description.savedToDisk") });
                    else if (!r.canceled) toast.error(t("common.error.downloadFailed"));
                  } catch (e: any) {
                    toast.error(e instanceof ApiError ? autoDir(e.message) : t("common.error.failed"));
                  }
                }}
              >
                <FileArchive size={14} /> {t("files.action.downloadZIP")}
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
                title={selectedFolders.size > 0 ? t("files.tooltip.aLinkCoversOneFolderOrASetOf") : undefined}
                onClick={async () => {
                  try {
                    const ids = Array.from(selected);
                    const res = await api.post<{ ok: boolean; url: string; token: string }>("/api/files/share-bundle", { file_ids: ids, workspace_id: active!.id });
                    if (res.url) {
                      navigator.clipboard.writeText(res.url);
                      toast.success(t("files.status.shareBundleLinkCopied"));
                    }
                  } catch (e: any) {
                    toast.error(e instanceof ApiError ? autoDir(e.message) : t("common.error.failed"));
                  }
                }}
              >
                <Link2 size={14} /> {t("files.action.shareBundle")}
              </button>}
              {(can("upload_files") || can("rename_folders")) && <button
                className="flex items-center gap-1 text-[var(--color-text-secondary)] hover:text-[var(--color-text)]"
                onClick={() => { setBulkMoveIds(Array.from(selected)); setBulkMoveFolderIds(Array.from(selectedFolders)); setPickerFolder(null); }}
              >
                <Move size={14} /> {t("files.action.move")}
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
                <Trash2 size={14} /> {t("common.delete")}
              </button>}
            </>
          )}
          <div className="ms-auto flex items-center gap-3">
            <button className="text-xs text-[var(--color-text-muted)]" onClick={selectAll}>
              {t("common.action.selectAll")}
            </button>
            <button className="text-xs text-[var(--color-text-muted)]" onClick={clearSelection}>
              {t("common.action.clear")}
            </button>
          </div>
        </div>
      )}

      {/* Content. The library branch comes first on purpose: the folder
          listing is disabled in this view, so its skeleton would otherwise
          have the grid's own loading state to itself. */}
      {libraryKind ? (
        /* No horizontal padding on the scroller, like the two branches below -
           it is what lets the grid's sticky month header blur the tiles from
           edge to edge as they pass under it. */
        <div className="flex-1 overflow-auto">
          <LibraryGrid
            kind={libraryKind}
            months={library.months}
            total={library.total}
            loaded={library.loaded}
            hasMore={library.hasMore}
            isLoading={library.isLoading}
            isLoadingMore={library.isLoadingMore}
            error={library.error}
            search={search}
            selected={selected}
            favourites={favourites}
            unlockedFiles={unlockedFiles}
            activeId={panel?.file.id ?? null}
            tileSize={tileSize}
            layout={libraryLayout}
            columns={activeColumns}
            onLoadMore={library.loadMore}
            onRetry={library.refresh}
            onUploadClick={() => navigate("/upload")}
            onOpen={(f) => openFileWithLockCheck(f, "view")}
            onToggleSelect={toggleSelect}
            onSelectMany={(ids) => setSelected((prev) => new Set([...prev, ...ids]))}
            onFavourite={toggleFavourite}
            onContextMenu={(e, f) => {
              e.preventDefault();
              setContextMenu({ x: e.clientX, y: e.clientY, item: { id: f.id, name: f.name, kind: "file" } });
            }}
          />
        </div>
      ) : isLoading ? (
        <div className="space-y-2">
          {Array.from({ length: 8 }).map((_, i) => (
            <div key={i} className="h-12 animate-pulse rounded-lg bg-[var(--color-bg-tertiary)]" />
          ))}
        </div>
      ) : viewMode === "table" ? (
        <div className="flex-1 overflow-auto" onContextMenu={openBlankMenu}>
          <table
            className="w-full table-fixed text-start text-sm"
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
                <th className="w-8 py-2 ps-3 text-start">
                  <input
                    type="checkbox"
                    aria-label={t("common.action.selectAll")}
                    checked={totalSelected > 0 && selected.size >= selectableFiles.length && selectedFolders.size >= folders.length && (selectableFiles.length + folders.length) > 0}
                    onChange={(e) => {
                      if (e.target.checked) selectAll();
                      else clearSelection();
                    }}
                  />
                </th>
                {visibleCols.map((col) => {
                  // Click a column name to sort by it, click again to flip
                  // (same as the web table). The trash cannot order by
                  // uploader server-side, so that header stays plain there.
                  const sortable = isSortKey(col.key) && !(showDeleted && col.key === "uploader");
                  const active = sortable && sortSpec.key === col.key;
                  return (
                    <th
                      key={col.key}
                      className="py-2 pe-3 text-start font-medium"
                      aria-sort={active ? (sortSpec.dir === "asc" ? "ascending" : "descending") : undefined}
                    >
                      {sortable ? (
                        <button
                          type="button"
                          onClick={() => setSort(serializeSort(toggleSort(sortSpec, col.key as SortKey)))}
                          title={t("common.action.sortByLabeltolowercase", { labelToLowerCase: col.label.toLocaleLowerCase(locale) })}
                          className={`flex max-w-full items-center gap-1 rounded text-start transition-colors hover:text-[var(--color-text)] ${active ? "text-[var(--color-text)]" : ""}`}
                        >
                          <span className="truncate">{col.label}</span>
                          {active && (sortSpec.dir === "asc"
                            ? <ArrowUp size={11} className="shrink-0" aria-hidden />
                            : <ArrowDown size={11} className="shrink-0" aria-hidden />)}
                        </button>
                      ) : (
                        <span className="block truncate">{col.label}</span>
                      )}
                    </th>
                  );
                })}
                <th className="w-10 py-2 text-start"></th>
              </tr>
            </thead>
            <tbody>
              {folders.map((folder) => (
                <tr
                  key={folder.id}
                  className={`cursor-pointer border-b transition-colors ${dropTarget === folder.id ? ROW_DROP_ACTIVE : "hover:bg-[var(--color-bg-secondary)]"}`}
                  style={{ borderColor: "var(--color-border)" }}
                  {...dragSourceProps({ id: folder.id, name: folder.name, kind: "folder" })}
                  {...dropTargetProps(folder.id, folder.name)}
                  onClick={(e) => { if (e.ctrlKey || e.metaKey) toggleSelectFolder(folder.id); else navigateToFolder(folder.id); }}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    setContextMenu({ x: e.clientX, y: e.clientY, item: { id: folder.id, name: folder.name, kind: "folder" } });
                  }}
                >
                  <td className="py-2 ps-3" onClick={(e) => e.stopPropagation()}>
                    <input
                      type="checkbox"
                      aria-label={t("files.accessibility.selectName", { name: folder.name })}
                      checked={selectedFolders.has(folder.id)}
                      onChange={() => toggleSelectFolder(folder.id)}
                    />
                  </td>
                  {visibleCols.map((col) => {
                    if (col.key === "name") {
                      return (
                        <td key="name" className="py-2 pe-3">
                          <div className="flex min-w-0 items-center gap-2.5">
                            <span className="relative shrink-0">
                              <FolderIcon fileCount={folder.file_count} size={18} synced={!!(syncedFolderIds.has(folder.id) || folder.is_synced)} />
                              <OriginBadge origin={folder.origin} />
                            </span>
                            <span dir={ownDir} className="truncate font-medium" title={folder.name}>{folder.name}</span>
                            <span className="shrink-0 text-xs text-[var(--color-text-muted)]">{t("common.label.filecountFiles", { fileCount: String(folder.file_count) })}</span>
                            {!!folder.lock_mode && folder.lock_mode !== "none" && (
                              <span title={t("files.status.locked")} className="inline-flex shrink-0"><Lock size={12} className="text-[var(--color-text-muted)]" /></span>
                            )}
                            {!!folder.is_hidden && (
                              <span title={hiddenTitle(folder.hidden_mode)} className="inline-flex shrink-0"><EyeOff size={12} className="text-[var(--color-text-muted)]" /></span>
                            )}
                          </div>
                        </td>
                      );
                    }
                    return (
                      <td key={col.key} className="truncate py-2 pe-3 text-xs text-[var(--color-text-muted)]">
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
                      aria-label={t("files.accessibility.actionsForName", { name: folder.name })}
                      className="rounded p-1 hover:bg-[var(--color-bg-tertiary)]"
                    >
                      <MoreHorizontal size={14} />
                    </button>
                  </td>
                </tr>
              ))}
              {listFiles.map((file) => {
                const isSel = selected.has(file.id);
                const isActive = panel?.file.id === file.id;
                return (
                  <tr
                    key={file.id}
                    id={`file-${file.id}`}
                    className={`cursor-pointer border-b transition-colors ${isActive ? "bg-green-50" : isSel ? "bg-[var(--color-primary)]/5" : "hover:bg-[var(--color-bg-secondary)]"}`}
                    style={{ borderColor: "var(--color-border)" }}
                    {...dragSourceProps({ id: file.id, name: file.name, kind: "file" })}
                    onClick={(e) => {
                      if (e.ctrlKey || e.metaKey) toggleSelect(file.id);
                      else openFileWithLockCheck(file, "detail");
                    }}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      setContextMenu({ x: e.clientX, y: e.clientY, item: { id: file.id, name: file.name, kind: "file" } });
                    }}
                  >
                    <td className="py-2 ps-3" onClick={(e) => e.stopPropagation()}>
                      <input
                        type="checkbox"
                        aria-label={t("files.accessibility.selectName", { name: file.name })}
                        checked={isSel}
                        onChange={() => toggleSelect(file.id)}
                      />
                    </td>
                    {visibleCols.map((col) => {
                      if (col.key === "name") {
                        return (
                          <td key="name" className="py-2 pe-3">
                            <div className={`flex min-w-0 items-center gap-2.5 ${isLiveTwin(file) ? "ps-9" : ""}`}>
                              <RowThumbnail fileId={file.id} fileName={file.name} />
                              <span
                                title={file.name}
                                dir={ownDir}
                                className="truncate hover:text-[var(--color-primary)] hover:underline"
                                onClick={(e) => { e.stopPropagation(); openFileWithLockCheck(file, "view"); }}
                              >
                                {file.name}
                              </span>
                              {isLiveStill(file) && <LiveBadge size="pill" />}
                              {isLiveTwin(file) && <span className="shrink-0 text-[10px] text-[var(--color-text-muted)]">{t("files.label.livePhotoVideo")}</span>}
                              {favourites.has(file.id) && <Star size={12} className="shrink-0 fill-orange-400 text-orange-400" />}
                              {(file.current_version ?? 1) > 1 && (
                                <span className="shrink-0 rounded bg-[var(--color-bg-tertiary)] px-1 text-[9px] font-medium">{t("common.label.vVersion", { version: String(file.current_version) })}</span>
                              )}
                              {!!file.lock_mode && file.lock_mode !== "none" && (
                                <span title={t("files.status.locked")} className="inline-flex shrink-0"><Lock size={12} className="text-[var(--color-text-muted)]" /></span>
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
                          className="truncate py-2 pe-3 text-xs text-[var(--color-text-muted)]"
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
                        aria-label={t("files.accessibility.actionsForName", { name: file.name })}
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
                    {showDeleted ? t("files.empty.trashIsEmpty")
                      : search ? t("files.label.noFilesMatchYourSearch")
                      : activeFilter === "favourites" ? t("files.label.noFavouritesYetStarAFileToCollectIt")
                      : t("files.empty.thisFolderIsEmpty")}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      ) : (
        /* Card View */
        <div className="flex-1 overflow-auto" onContextMenu={openBlankMenu}>
          {folders.length > 0 && (
            <div className="mb-5">
              <p className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">{t("common.label.folders")}</p>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
                {folders.map((folder) => {
                  const isFolderSel = selectedFolders.has(folder.id);
                  return (
                    <div
                      key={folder.id}
                      className={`group relative cursor-pointer rounded-xl border p-4 transition-colors ${
                        dropTarget === folder.id ? "bg-[var(--color-primary)]/10 ring-2 ring-[var(--color-primary)]"
                        : `hover:bg-[var(--color-bg-secondary)] ${isFolderSel ? "ring-2 ring-[var(--color-primary)]" : ""}`
                      }`}
                      style={{ borderColor: dropTarget === folder.id ? "var(--color-primary)" : "var(--color-border)" }}
                      {...dragSourceProps({ id: folder.id, name: folder.name, kind: "folder" })}
                      {...dropTargetProps(folder.id, folder.name)}
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
                        className={`absolute inset-s-2 top-2 z-20 h-4 w-4 accent-[var(--color-primary)] transition-all ${isFolderSel || selectedFolders.size > 0 ? "opacity-100" : "opacity-0 group-hover:opacity-100"}`}
                      />
                      <span className="relative mb-3 inline-block">
                        <FolderIcon fileCount={folder.file_count} size={32} synced={!!(syncedFolderIds.has(folder.id) || folder.is_synced)} />
                        <OriginBadge origin={folder.origin} />
                      </span>
                      <p dir={ownDir} className="truncate text-sm font-medium" title={folder.name}>{folder.name}</p>
                      <p className="text-xs text-[var(--color-text-muted)]">{t("files.description.filecountItems", { fileCount: String(folder.file_count) })}</p>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
          {files.length > 0 && (
            <div>
              <p className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">{t("common.label.files")}</p>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-4 xl:grid-cols-5">
                {gridFiles.map((file) => (
                  <FileCard
                    key={file.id}
                    file={file}
                    selected={selected.has(file.id)}
                    anySelected={selected.size > 0}
                    active={panel?.file.id === file.id}
                    isFavourite={favourites.has(file.id)}
                    dnd={dragSourceProps({ id: file.id, name: file.name, kind: "file" })}
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
              {showDeleted ? t("files.empty.trashIsEmpty")
                : search ? t("files.label.noFilesMatchYourSearch")
                : activeFilter === "favourites" ? t("files.label.noFavouritesYetStarAFileToCollectIt")
                : t("files.empty.thisFolderIsEmpty")}
            </div>
          )}
        </div>
      )}

      {/* Pagination */}
      {pagination && pagination.total_pages > 1 && (
        <div className="mt-4 flex items-center justify-between border-t pt-3" style={{ borderColor: "var(--color-border)" }}>
          <span className="text-xs text-[var(--color-text-muted)]">
            {t("files.label.pagePageOfTotalPagesTotalFilesFiles", { page: String(pagination.page), totalPages: String(pagination.total_pages), totalFiles: String(pagination.total_files) })}
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
              {t("files.action.prev")}
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
              {t("common.next")}
            </button>
          </div>
        </div>
      )}

      {/* Context Menu */}
      {contextMenu && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setContextMenu(null)} />
          <div
            // rtl-ok: mirrored, the menu grows from the corner at the cursor
            className="fixed z-50 w-52 origin-top-left rtl:origin-top-right overflow-y-auto rounded-lg border bg-[var(--color-bg)] py-1 shadow-lg"
            style={{
              ...atCursor(contextMenu.x, dir),
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
                <CtxItem icon={<RotateCcw size={14} />} label={t("files.action.restore")} onClick={() => {
                  restoreItem(contextMenu.item.id, contextMenu.item.kind);
                  setContextMenu(null);
                }} />
                <Divider />
                <CtxItem icon={<Trash2 size={14} />} label={t("files.action.deletePermanently")} danger onClick={() => {
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
                <CtxItem icon={<FolderOpen size={14} />} label={t("files.open")} onClick={() => { navigateToFolder(contextMenu.item.id); setContextMenu(null); }} />
                {can("create_share_links") && <CtxItem icon={<Share2 size={14} />} label={t("files.action.share")} onClick={() => {
                  setShareTarget({ target: { kind: "folder", folderId: contextMenu.item.id }, name: contextMenu.item.name });
                  setContextMenu(null);
                }} />}
                <CtxItem icon={<Info size={14} />} label={t("files.action.getInfo")} onClick={() => {
                  if (ctxFolder) setInfoTarget({ type: "folder", item: ctxFolder });
                  setContextMenu(null);
                }} />
                <Divider />
                {can("rename_folders") && <CtxItem icon={<Pencil size={14} />} label={t("common.action.rename")} onClick={() => {
                  setRenameItem(contextMenu.item); setRenameName(contextMenu.item.name); setContextMenu(null);
                }} />}
                {can("rename_folders") && <CtxItem icon={<Move size={14} />} label={t("files.label.moveTo")} onClick={() => {
                  setMoveTarget({ id: contextMenu.item.id, name: contextMenu.item.name, kind: "folder" });
                  setPickerFolder(null); setContextMenu(null);
                }} />}
                <Divider />
                {canLock && <CtxItem icon={<Lock size={14} />} label={ctxFolder && ctxFolder.lock_mode !== "none" ? t("common.action.unlock") : t("common.action.lock")} onClick={() => {
                  setLockTarget({ id: contextMenu.item.id, name: contextMenu.item.name, type: "folder", file_count: ctxFolder?.file_count, total_size_bytes: ctxFolder?.total_size_bytes, lock_mode: ctxFolder?.lock_mode }); setContextMenu(null);
                }} />}
                {canHide && <CtxItem icon={ctxFolder?.is_hidden ? <Eye size={14} /> : <EyeOff size={14} />} label={ctxFolder?.is_hidden ? t("files.action.unhide") : t("files.action.hide")} onClick={() => {
                  setHideTarget({ id: contextMenu.item.id, name: contextMenu.item.name, type: "folder" }); setContextMenu(null);
                }} />}
                <Divider />
                {(can("delete_any_file") || can("delete_own_files")) && <CtxItem icon={<Trash2 size={14} />} label={t("common.delete")} danger onClick={() => {
                  setDeleteConfirm({ ids: [contextMenu.item.id], names: [contextMenu.item.name], kinds: ["folder"] });
                  setContextMenu(null);
                }} />}
              </>
            ) : (
              <>
                <CtxItem icon={<Eye size={14} />} label={t("files.view")} onClick={() => {
                  if (ctxFile) openFileWithLockCheck(ctxFile, "view");
                  setContextMenu(null);
                }} />
                {isOfficeFile(contextMenu.item.name) && (
                  <CtxItem icon={<SquarePen size={14} />} label={t("files.label.openInEditor")} onClick={() => {
                    // In-app now. This used to window.open the web app, which
                    // threw the user out of the desktop app into a browser and a
                    // second login for a document they already had open here.
                    navigate(`/editor/${contextMenu.item.id}`);
                    setContextMenu(null);
                  }} />
                )}
                {/* Markdown and plain text: the in-app text editor. Saving is
                    an upload of a new version, hence upload_files. */}
                {ctxFile && canEditText(ctxFile) && can("upload_files") && (
                  <CtxItem icon={<SquarePen size={14} />} label={t("files.label.openInEditor")} onClick={() => {
                    navigate(`/text-editor/${ctxFile.id}`, { state: { back: true } });
                    setContextMenu(null);
                  }} />
                )}
                {can("download_files") && <CtxItem icon={<Download size={14} />} label={t("common.action.download")} onClick={() => {
                  if (ctxFile) downloadViaDialog(ctxFile);
                  setContextMenu(null);
                }} />}
                {can("create_share_links") && <CtxItem icon={<Share2 size={14} />} label={t("files.action.share")} onClick={() => {
                  setShareTarget({ target: { kind: "file", fileIds: [contextMenu.item.id] }, name: contextMenu.item.name }); setContextMenu(null);
                }} />}
                <CtxItem icon={<MessageCircle size={14} />} label={t("files.label.comments")} onClick={() => {
                  if (ctxFile) setPanel({ file: ctxFile, tab: "comments" });
                  setContextMenu(null);
                }} />
                <CtxItem icon={<Star size={14} />} label={favourites.has(contextMenu.item.id) ? t("files.label.removeFavourite") : t("files.label.addToFavourites")} onClick={() => {
                  toggleFavourite(contextMenu.item.id); setContextMenu(null);
                }} />
                <CtxItem icon={<Info size={14} />} label={t("files.action.getInfo")} onClick={() => {
                  if (ctxFile) setInfoTarget({ type: "file", item: ctxFile });
                  setContextMenu(null);
                }} />
                <Divider />
                {can("rename_files") && <CtxItem icon={<Pencil size={14} />} label={t("common.action.rename")} onClick={() => {
                  setRenameItem(contextMenu.item); setRenameName(contextMenu.item.name); setContextMenu(null);
                }} />}
                {can("upload_files") && <CtxItem icon={<Copy size={14} />} label={t("files.label.copyTo")} onClick={() => {
                  setCopyTarget({ id: contextMenu.item.id, name: contextMenu.item.name });
                  setPickerFolder(null); setContextMenu(null);
                }} />}
                {can("upload_files") && <CtxItem icon={<Move size={14} />} label={t("files.label.moveTo")} onClick={() => {
                  setMoveTarget({ id: contextMenu.item.id, name: contextMenu.item.name, kind: "file" });
                  setPickerFolder(null); setContextMenu(null);
                }} />}
                <Divider />
                <CtxItem icon={<ExternalLink size={14} />} label={t("files.label.openInSystemApp")} onClick={() => {
                  openFileInSystemApp(contextMenu.item.id, contextMenu.item.name); setContextMenu(null);
                }} />
                {can("upload_files") && <CtxItem icon={<Upload size={14} />} label={t("files.label.uploadNewVersion")} onClick={() => {
                  setVersionUploadTarget(contextMenu.item.id); setContextMenu(null);
                }} />}
                {/* Opens the detail panel, whose Info tab leads with the version
                    list. The viewer showed no versions at all for a single-version
                    file and only a collapsed toggle otherwise. */}
                <CtxItem icon={<History size={14} />} label={t("files.label.versionHistory")} onClick={() => {
                  if (ctxFile) openFileWithLockCheck(ctxFile, "versions");
                  setContextMenu(null);
                }} />
                {canLock && <CtxItem icon={<Lock size={14} />} label={ctxFile && ctxFile.lock_mode !== "none" ? t("common.action.unlock") : t("common.action.lock")} onClick={() => {
                  setLockTarget({ id: contextMenu.item.id, name: contextMenu.item.name, type: "file", size_bytes: ctxFile?.size_bytes, extension: ctxFile?.extension, lock_mode: ctxFile?.lock_mode }); setContextMenu(null);
                }} />}
                {canHide && <CtxItem icon={ctxFile?.is_hidden ? <Eye size={14} /> : <EyeOff size={14} />} label={ctxFile?.is_hidden ? t("files.action.unhide") : t("files.action.hide")} onClick={() => {
                  setHideTarget({ id: contextMenu.item.id, name: contextMenu.item.name, type: "file" }); setContextMenu(null);
                }} />}
                <Divider />
                {canDeleteFile(ctxFile) && <CtxItem icon={<Trash2 size={14} />} label={t("common.delete")} danger onClick={() => {
                  setDeleteConfirm(ctxFile ? fileDeleteConfirm(ctxFile) : { ids: [contextMenu.item.id], names: [contextMenu.item.name], kinds: ["file"] });
                  setContextMenu(null);
                }} />}
              </>
            )}
          </div>
        </>
      )}

      {/* Empty-space menu: New folder / file. Same surface as the row menu. */}
      {blankMenu && (
        <>
          <div
            className="fixed inset-0 z-40"
            onClick={() => setBlankMenu(null)}
            onContextMenu={(e) => { e.preventDefault(); setBlankMenu(null); }}
          />
          <div
            role="menu"
            aria-label={t("files.label.new")}
            // rtl-ok: mirrored, the menu grows from the corner at the cursor
            className="fixed z-50 w-52 origin-top-left rtl:origin-top-right overflow-y-auto rounded-lg border bg-[var(--color-bg)] py-1 shadow-lg"
            style={{
              ...atCursor(blankMenu.x, dir),
              top: Math.min(blankMenu.y, Math.max(8, window.innerHeight - 200)),
              maxHeight: window.innerHeight - 16,
              borderColor: "var(--color-border)",
            }}
          >
            <p className="px-3 pb-1 pt-1.5 text-[10px] font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">
              {t("files.label.new")}
            </p>
            {newChoices.map(({ choice, label }, i) => (
              <div key={choice}>
                {i > 0 && newChoices[i - 1].choice === "folder" && <Divider />}
                <CtxItem icon={<NewChoiceIcon choice={choice} />} label={label} onClick={() => pickNew(choice)} />
              </div>
            ))}
          </div>
        </>
      )}

      {/* New file: name it */}
      {newFileKind && (
        <NewFileDialog
          key={newFileKind}
          kind={newFileKind}
          onCancel={() => setNewFileKind(null)}
          onCreate={async (name) => {
            const result = await createBlankFile(newFileKind, name);
            if (result === null) setNewFileKind(null);
            return result;
          }}
        />
      )}

      {/* Create Folder Modal */}
      {showCreateFolder && (
        <Modal onClose={() => setShowCreateFolder(false)}>
          <h3 className="mb-4 text-lg font-semibold">{t("files.heading.createFolder")}</h3>
          <input
            type="text"
            value={newFolderName}
            onChange={(e) => setNewFolderName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && newFolderName && createFolderMut.mutate(newFolderName)}
            placeholder={t("common.placeholder.folderName")}
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
              {t("common.cancel")}
            </button>
            <button
              onClick={() => newFolderName && createFolderMut.mutate(newFolderName)}
              disabled={!newFolderName}
              className="rounded-lg px-4 py-2 text-sm font-medium text-[var(--color-primary-fg)] disabled:opacity-50"
              style={{ background: "var(--color-primary)" }}
            >
              {t("common.action.create")}
            </button>
          </div>
        </Modal>
      )}

      {/* Rename Modal */}
      {renameItem && (
        <Modal onClose={() => setRenameItem(null)}>
          <h3 className="mb-4 text-lg font-semibold">{t("files.heading.rename")}</h3>
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
              {t("common.cancel")}
            </button>
            <button
              onClick={() =>
                renameName && renameMut.mutate({ id: renameItem.id, name: renameName, kind: renameItem.kind })
              }
              className="rounded-lg px-4 py-2 text-sm font-medium text-[var(--color-primary-fg)]"
              style={{ background: "var(--color-primary)" }}
            >
              {t("common.action.rename")}
            </button>
          </div>
        </Modal>
      )}

      {/* Unlock password modal (full_lock gate) */}
      {unlockPrompt && (
        <Modal onClose={() => setUnlockPrompt(null)} maxWidth={340}>
          <h3 className="mb-1 flex items-center gap-2 text-lg font-semibold"><Lock size={16} /> {t("files.heading.fileIsLocked")}</h3>
          <p className="mb-3 text-xs text-[var(--color-text-muted)]">
            {richText(t, "files.description.enterThePasswordToAccessFileName", {}, {
              fileName: <span className="break-all font-semibold text-[var(--color-text)]">{unlockPrompt.file.name}</span>,
            })}
          </p>
          {unlockError && (
            <p dir={unlockErrorRaw ? ownDir : undefined} className="mb-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-[var(--color-danger)]">{unlockError}</p>
          )}
          <input
            type="password"
            value={unlockPassword}
            onChange={(e) => setUnlockPassword(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleUnlockSubmit()}
            placeholder={t("files.placeholder.enterPassword")}
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
              {t("common.cancel")}
            </button>
            <button
              onClick={handleUnlockSubmit}
              disabled={unlocking}
              className="flex items-center gap-1.5 rounded-lg px-4 py-2 text-sm font-medium text-[var(--color-primary-fg)] disabled:opacity-50"
              style={{ background: "var(--color-primary)" }}
            >
              {unlocking && <Loader2 size={14} className="animate-spin" />}
              {t("common.action.unlock")}
            </button>
          </div>
        </Modal>
      )}

      {/* Detail Panel */}
      {panel && (
        <FileDetailPanel
          key={`${panel.file.id}:${panel.tab}:${panel.versions ? "v" : ""}`}
          file={panel.file}
          workspaceId={active!.id}
          initialTab={panel.tab}
          showVersions={panel.versions}
          onClose={() => setPanel(null)}
          onCopy={(id) => { setCopyTarget({ id, name: panel.file.name }); setPickerFolder(null); }}
          onDelete={() => setDeleteConfirm(fileDeleteConfirm(panel.file))}
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
                    ? t("files.heading.deleteItemPermanently", { nameCount: deleteConfirm.names.length })
                    : t("files.heading.deletePermanently")
                  : t("files.heading.deleteItemCount", { count: deleteConfirm.names.length })}
              </h3>
              <p className={`mt-1 text-sm ${deleteConfirm.permanent ? "text-[var(--color-danger)]" : "text-[var(--color-text-secondary)]"}`}>
                {deleteConfirm.permanent ? (
                  deleteConfirm.bulk
                    ? t("files.description.permanentlyDeleteItemThisCannotBeUndone", { nameCount: deleteConfirm.names.length })
                    : deleteConfirm.kinds[0] === "folder" && !!deleteConfirm.fileCount
                      ? richText(t, "files.description.permanentlyDeleteNameAndItsFileThisCannotBe", { fileCount: deleteConfirm.fileCount }, {
                        name: <strong>{deleteConfirm.names[0]}</strong>,
                      })
                      : richText(t, "files.description.permanentlyDeleteNameThisCannotBeUndone", {}, {
                        name: <strong>{deleteConfirm.names[0]}</strong>,
                      })
                ) : deleteConfirm.names.length === 1 ? (
                  richText(t, "files.description.areYouSureYouWantToDeleteName", {}, { name: <strong>{deleteConfirm.names[0]}</strong> })
                ) : (
                  t("files.description.areYouSureYouWantToDeleteTheseNameCount", { nameCount: String(deleteConfirm.names.length) })
                )}
              </p>
              {(!deleteConfirm.permanent || deleteConfirm.bulk) && deleteConfirm.names.length > 1 && deleteConfirm.names.length <= 5 && (
                <ul className="mt-2 space-y-0.5 text-xs text-[var(--color-text-muted)]">
                  {deleteConfirm.names.map((n, i) => (
                    <li key={i} className="truncate">· <Bdi>{n}</Bdi></li>
                  ))}
                </ul>
              )}
              {!deleteConfirm.permanent && (
                <p className="mt-2 text-xs text-[var(--color-text-muted)]">
                  {t("files.description.thisActionCanBeUndoneFromTheDeletedFilter")}
                </p>
              )}
              {deleteConfirm.twin && (
                <label className="mt-2 flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={deleteConfirm.withTwin !== false}
                    onChange={(e) => setDeleteConfirm({ ...deleteConfirm, withTwin: e.target.checked })}
                  />
                  {t("files.label.alsoDeleteTwinName", { twinName: deleteConfirm.twin.name })}
                </label>
              )}
              {deleteConfirm.bulk && !deleteConfirm.permanent && confirmTwinIds.length > 0 && (
                <p className="mt-2 text-xs text-[var(--color-text-muted)]">
                  {t("files.description.includesLivePhotoVideo", { confirmTwinIdCount: confirmTwinIds.length })}
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
              {t("common.cancel")}
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
                    // Selected Live Photo stills take their twin video along -
                    // the count shown above stays the original selection, but
                    // the request also clears the twins from storage.
                    await api.post("/api/files/batch-delete", {
                      workspace_id: active!.id,
                      file_ids: [...deleteConfirm.ids, ...confirmTwinIds],
                      folder_ids: deleteConfirm.folderIds ?? [],
                    });
                    const count = deleteConfirm.ids.length + (deleteConfirm.folderIds?.length ?? 0);
                    toast.success(t("files.heading.deleted"), { description: t("files.description.deletedItemCount", { count }) });
                    refresh();
                    clearSelection();
                  } catch (e: any) {
                    toast.error(e instanceof ApiError ? autoDir(e.message) : t("common.error.deleteFailed"));
                  }
                } else if (deleteConfirm.permanent) {
                  // Same bounded purge as the bulk path: a folder is asked
                  // again until the server says it is finished, and a run that
                  // hits the pass cap says so instead of claiming the folder
                  // is gone.
                  try {
                    let stillEmptying: PurgeMessage | null = null;
                    for (let i = 0; i < deleteConfirm.ids.length; i++) {
                      const id = deleteConfirm.ids[i];
                      if (deleteConfirm.kinds[i] !== "folder") {
                        await api.delete(`/api/files/${id}`);
                        continue;
                      }
                      const outcome = await purgeTrashedFolder(() => api.delete<PurgeResponse>(`/api/folders/${id}`));
                      if (!outcome.complete) {
                        stillEmptying = purgeSummary(outcome, deleteConfirm.names[i] ?? t("files.label.thatFolder"));
                      }
                    }
                    if (stillEmptying) showPurgeMessage(stillEmptying);
                    else toast.success(t("files.status.permanentlyDeleted"));
                  } catch (e) {
                    toast.error(e instanceof ApiError ? autoDir(e.message) : t("common.error.deleteFailed"));
                  }
                  refresh();
                  clearSelection();
                } else {
                  deleteConfirm.ids.forEach((id, i) => deleteMut.mutate({ id, kind: deleteConfirm.kinds[i] }));
                  // Deleting a still is always two requests (the still, then
                  // the twin) - twinDeleteEndpoint pins when the checkbox
                  // means the twin should go too.
                  const twinEp = twinDeleteEndpoint({ type: "file", twin: deleteConfirm.twin ?? null, withTwin: deleteConfirm.withTwin, permanent: deleteConfirm.permanent });
                  // A twin that refuses to follow is a leftover video, not a
                  // failed delete - the still is already gone. Say so in its own
                  // words instead of the mutation's bare failure, and refresh
                  // either way so the list stops showing the deleted still.
                  if (twinEp) deleteMut.mutate({ id: deleteConfirm.twin!.id, kind: "file" }, {
                    onError: () => {
                      toast.warning(t("files.error.photoDeletedButVideoCouldNotBeDeleted"));
                      refresh();
                    },
                  });
                  toast.success(t("files.heading.deleted"));
                  clearSelection();
                }
                setPanel((p) => (p && deleteConfirm.ids.includes(p.file.id) ? null : p));
                setDeleteConfirm(null);
              }}
              className="rounded-lg bg-[var(--color-danger)] px-4 py-2 text-sm font-medium text-white hover:opacity-90"
            >
              {deleteConfirm.permanent ? t("files.action.deletePermanently") : t("common.delete")}
            </button>
          </div>
        </Modal>
      )}

      {/* Drag-to-move confirmation: nothing moves until Move. */}
      {moveConfirm && (
        <MoveConfirmModal
          names={moveConfirmNames}
          fileCount={moveConfirm.payload.fileIds.length}
          folderCount={moveConfirm.payload.folderIds.length}
          folderName={moveConfirm.folderName}
          pending={moveConfirmPending}
          onConfirm={() => { void confirmDragMove(); }}
          onCancel={() => { if (!moveConfirmPending) setMoveConfirm(null); }}
        />
      )}

      {/* Move / Copy / Bulk-move Folder Picker Modal */}
      {(moveTarget || copyTarget || bulkMoveIds || bulkMoveFolderIds) && (
        <FolderPickerModal
          title={
            moveTarget ? t("files.tooltip.moveMoveTargetName", { moveTargetName: moveTarget.name })
            : copyTarget ? t("files.tooltip.copyCopyTargetName", { copyTargetName: copyTarget.name })
            : t("files.tooltip.moveCountItems", { count: String((bulkMoveIds?.length ?? 0) + (bulkMoveFolderIds?.length ?? 0)) })
          }
          actionLabel={copyTarget ? t("files.action.copyHere") : t("files.action.moveHere")}
          folders={folderTreeData?.folders ?? []}
          selectedId={pickerFolder}
          excludeId={moveTarget?.kind === "folder" ? moveTarget.id : undefined}
          isPending={moveMut.isPending || copyMut.isPending}
          onSelect={setPickerFolder}
          onConfirm={async () => {
            if (moveTarget) {
              // A refusal was already toasted by moveMut; the picker stays
              // open so another folder can be chosen.
              const moved = await runMove({
                fileIds: moveTarget.kind === "file" ? [moveTarget.id] : [],
                folderIds: moveTarget.kind === "folder" ? [moveTarget.id] : [],
                targetId: pickerFolder,
                bulk: false,
              });
              if (!moved) return;
            } else if (copyTarget) {
              // A Live Photo copies as a pair, the same rule move follows: the
              // copy of the still would otherwise land beside a video it no
              // longer claims. The copies keep a shared stem ("Copy of IMG_1"),
              // so they re-pair in the destination. Sent directly rather than
              // through copyMut, which would fire a second "Copied successfully".
              const still = allFiles.find((f) => f.id === copyTarget.id);
              const twinId = still && isLiveStill(still) ? still.live_video_id! : null;
              copyMut.mutate({ id: copyTarget.id, targetId: pickerFolder }, twinId ? {
                onSuccess: () => {
                  void api.post(`/api/files/${twinId}/copy`, { folder_id: pickerFolder })
                    .catch(() => toast.warning(t("files.error.photoCopiedButVideoCouldNotBeCopied")))
                    .finally(() => refresh());
                },
              } : undefined);
              return;
            } else if (bulkMoveIds) {
              // The twins of the selected stills go with them, by the same rule
              // the single move and the bulk delete follow (inside runMove).
              await runMove({ fileIds: bulkMoveIds, folderIds: bulkMoveFolderIds ?? [], targetId: pickerFolder, bulk: true });
            }
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
        location={breadcrumbs.length ? breadcrumbs.map((b) => b.name).join(" / ") : t("files.label.home")}
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
          workspaceId={active?.id}
          onEdit={can("upload_files") ? (f) => navigate(`/text-editor/${f.id}`, { state: { back: true } }) : undefined}
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
  file, selected, anySelected, active, isFavourite, dnd,
  onClick, onSelect, onNameClick, onContextMenu, onFavourite, onComments, onShare, onMore,
}: {
  file: FileRow;
  /** Drag-to-move source props (draggable + handlers), or `{ draggable: false }`. */
  dnd?: Pick<React.HTMLAttributes<HTMLDivElement>, "draggable" | "onDragStart" | "onDragEnd">;
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
  const ownDir = useAutoDir();
  const t = useT();
  const ext = extOf(file.name).toUpperCase() || t("common.label.fileUppercase");

  return (
    <div
      className={`group relative aspect-[3/2] cursor-pointer overflow-hidden rounded-xl transition-all hover:-translate-y-px hover:shadow-lg ${
        active ? "ring-2 ring-green-500" : selected ? "ring-2 ring-[var(--color-primary)]" : "ring-1 ring-black/10"
      }`}
      id={`file-${file.id}`}
      {...dnd}
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
      {isLiveStill(file) && <LiveBadge size="tile" className="absolute inset-s-9 top-2 z-10" />}

      {/* Top-left: multi-select checkbox (hidden for fully-locked files) */}
      {file.lock_mode !== "full_lock" && (
        <input
          type="checkbox"
          checked={selected}
          onChange={onSelect}
          onClick={(e) => e.stopPropagation()}
          className={`absolute inset-s-2 top-2 z-20 h-4 w-4 accent-[var(--color-primary)] transition-all ${selected || anySelected ? "opacity-100" : "opacity-0 group-hover:opacity-100"}`}
        />
      )}

      {/* Top-right: lock (if any) + hidden (if any) + file-format pill */}
      <div className="absolute inset-e-2 top-2 z-10 flex items-center gap-1">
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
      <div className="absolute bottom-2 inset-e-2 z-20 flex flex-col gap-2 opacity-90 transition-opacity group-hover:opacity-100">
        <button
          className="flex h-8 w-8 items-center justify-center rounded-full bg-black/35 backdrop-blur-sm transition-colors hover:bg-black/55"
          title={isFavourite ? t("files.accessibility.removeFromFavourites") : t("files.label.addToFavourites")}
          onClick={(e) => { e.stopPropagation(); onFavourite(); }}
        >
          <Star size={16} className={isFavourite ? "fill-orange-400 text-orange-400" : "text-white"} />
        </button>
        {file.comment_count > 0 && (
          <button
            className="relative flex h-8 w-8 items-center justify-center rounded-full bg-black/35 backdrop-blur-sm transition-colors hover:bg-black/55"
            title={t("files.tooltip.commentOpen", { commentCount: file.comment_count })}
            onClick={(e) => { e.stopPropagation(); onComments(); }}
          >
            <MessageCircle size={16} className="text-white" />
            <span className="absolute -inset-e-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-blue-500 px-1 font-mono text-[9px] text-white">{file.comment_count}</span>
          </button>
        )}
        <button
          className="flex h-8 w-8 items-center justify-center rounded-full bg-black/35 backdrop-blur-sm transition-colors hover:bg-black/55"
          title={file.share_count > 0 ? t("files.tooltip.sharedShareCountManage", { shareCount: String(file.share_count) }) : t("files.action.share")}
          onClick={(e) => { e.stopPropagation(); onShare(); }}
        >
          <Share2 size={16} className={file.share_count > 0 ? "text-green-400" : "text-white"} />
        </button>
        <button
          className="flex h-7 w-7 items-center justify-center self-center rounded-full bg-white/10 backdrop-blur-sm transition-colors hover:bg-white/25"
          title={t("files.tooltip.more")}
          onClick={onMore}
        >
          <MoreHorizontal size={16} className="text-white" />
        </button>
      </div>

      {/* Bottom-left: filename + meta line (padded so it clears the rail) */}
      <div className="absolute inset-x-0 bottom-0 z-10 p-2.5 pe-12">
        <div className="flex min-w-0 items-center gap-1.5">
          <button
            className="min-w-0 truncate text-start font-mono text-sm font-semibold text-white drop-shadow hover:underline"
            title={file.name}
            dir={ownDir}
            onClick={(e) => { e.stopPropagation(); onNameClick(); }}
          >
            {file.name}
          </button>
          {(file.current_version ?? 1) > 1 && (
            <span className="shrink-0 rounded border border-white/30 px-1 font-mono text-[9px] text-white/80">{t("common.label.vVersion", { version: String(file.current_version) })}</span>
          )}
        </div>
        <p className="truncate font-mono text-[11px] text-white/70 drop-shadow">
          <Part>{formatBytes(file.size_bytes)}</Part> · <Part>{formatDate(file.updated_at)}</Part>
        </p>
      </div>
    </div>
  );
}

