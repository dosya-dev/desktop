import { useState, useCallback, useEffect } from "react";
import { useSearchParams } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  ChevronRight,
  LayoutGrid,
  LayoutList,
  Plus,
  Search,
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
  FolderOpen,
  Info,
  X,
  MessageCircle,
  Send,
  History,
  LockKeyhole,
  Unlock,
  EyeOff,
  Mail,
  FileArchive,
  Link2,
  ExternalLink,
} from "lucide-react";
import { api, ApiError } from "@/lib/api-client";
import { useWorkspace } from "@/lib/workspace-context";
import { formatBytes, formatDate, formatRelative } from "@/lib/format";
import { toast } from "sonner";
import { FileIcon, FolderIcon } from "@/components/files/FileIcon";

interface FilesResponse {
  ok: boolean;
  folders: {
    id: string;
    name: string;
    created_at: number;
    file_count: number;
    lock_mode: string;
    is_hidden: number;
    is_synced: number;
  }[];
  files: {
    id: string;
    name: string;
    size_bytes: number;
    mime_type: string;
    extension: string | null;
    region: string;
    uploaded_by: string;
    created_at: number;
    updated_at: number;
    lock_mode: string;
    is_hidden: number;
    is_synced: number;
    uploader_name: string | null;
    share_count: number;
    comment_count: number;
  }[];
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

export function FileBrowserPage() {
  const { active } = useWorkspace();
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

  const folderId = searchParams.get("folder") || "";
  const filter = searchParams.get("filter") || "all";
  const sort = searchParams.get("sort") || "newest";
  const search = searchParams.get("q") || "";
  const page = parseInt(searchParams.get("page") || "1", 10);
  const showDeleted = searchParams.get("deleted") === "1";
  const showHidden = searchParams.get("hidden") === "1";

  // Determine which filter chip is active
  const activeFilter = showDeleted ? "deleted" : showHidden ? "hidden" : filter;

  const [viewMode, setViewMode] = useState<ViewMode>("table");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [searchInput, setSearchInput] = useState(search);
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    item: { id: string; name: string; kind: "file" | "folder" };
  } | null>(null);
  const [showCreateFolder, setShowCreateFolder] = useState(false);
  const [newFolderName, setNewFolderName] = useState("");
  const [renameItem, setRenameItem] = useState<{
    id: string;
    name: string;
    kind: "file" | "folder";
  } | null>(null);
  const [renameName, setRenameName] = useState("");
  const [infoFile, setInfoFile] = useState<{
    id: string;
    name: string;
    size_bytes: number;
    mime_type: string;
    extension: string | null;
    region: string;
    uploader_name: string | null;
    created_at: number;
    updated_at: number;
    lock_mode: string;
    share_count: number;
    comment_count: number;
  } | null>(null);
  const [moveTarget, setMoveTarget] = useState<{
    id: string;
    name: string;
    kind: "file" | "folder";
  } | null>(null);
  const [copyTarget, setCopyTarget] = useState<{
    id: string;
    name: string;
  } | null>(null);
  const [pickerFolder, setPickerFolder] = useState<string | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<{
    ids: string[];
    names: string[];
  } | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ["files", active?.id, folderId, filter, sort, search, page, showDeleted, showHidden],
    queryFn: () => {
      const params = new URLSearchParams({
        workspace_id: active!.id,
        page: String(page),
        per_page: "50",
        sort,
        filter: showDeleted ? "all" : filter,
      });
      if (folderId && !showDeleted) params.set("folder_id", folderId);
      if (search) params.set("q", search);
      if (showDeleted) params.set("deleted", "1");
      if (showHidden) params.set("hidden", "1");
      return api.get<FilesResponse>(`/api/files?${params}`);
    },
    enabled: !!active,
  });

  const navigateToFolder = useCallback(
    (id: string) => {
      setSelected(new Set());
      setSearchParams({ folder: id });
    },
    [setSearchParams],
  );

  const setFilter = (f: string) => {
    const p = new URLSearchParams(searchParams);
    // Clear special params
    p.delete("deleted");
    p.delete("hidden");

    if (f === "deleted") {
      p.set("filter", "all");
      p.set("deleted", "1");
    } else if (f === "hidden") {
      p.set("filter", "all");
      p.set("hidden", "1");
    } else {
      p.set("filter", f);
    }
    p.delete("page");
    p.delete("folder"); // deleted/hidden views show all, not per-folder
    if (f !== "deleted" && f !== "hidden") {
      // Keep folder context for normal filters
    }
    setSearchParams(p);
  };

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
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  // Mutations
  const deleteMut = useMutation({
    mutationFn: (id: string) => api.delete(`/api/files/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["files"] });
      toast.success("File deleted");
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
      queryClient.invalidateQueries({ queryKey: ["files"] });
      setShowCreateFolder(false);
      setNewFolderName("");
      toast.success("Folder created");
    },
  });

  const renameMut = useMutation({
    mutationFn: ({ id, name, kind }: { id: string; name: string; kind: string }) =>
      api.put(`/api/${kind === "folder" ? "folders" : "files"}/${id}/rename`, { name }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["files"] });
      setRenameItem(null);
      toast.success("Renamed");
    },
  });

  const favouriteMut = useMutation({
    mutationFn: ({ id, kind }: { id: string; kind: string }) =>
      api.post(`/api/favourites`, { resource_id: id, resource_type: kind }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["files"] }),
  });

  const moveMut = useMutation({
    mutationFn: ({ id, kind, targetId }: { id: string; kind: "file" | "folder"; targetId: string | null }) => {
      if (kind === "folder") {
        return api.put(`/api/folders/${id}/move`, { parent_id: targetId });
      }
      return api.put(`/api/files/${id}/move`, { folder_id: targetId });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["files"] });
      setMoveTarget(null);
      setPickerFolder(null);
      toast.success("Moved successfully");
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : "Move failed"),
  });

  const copyMut = useMutation({
    mutationFn: ({ id, targetId }: { id: string; targetId: string | null }) =>
      api.post(`/api/files/${id}/copy`, { folder_id: targetId }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["files"] });
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
    enabled: !!active && (!!moveTarget || !!copyTarget),
  });

  const openFile = useCallback(async (fileId: string, fileName: string) => {
    try {
      await window.electronAPI.openFile(fileId, fileName);
    } catch {
      toast.error("Failed to open file");
    }
  }, []);

  const allFolders = data?.folders ?? [];
  const allFiles = data?.files ?? [];
  const breadcrumbs = data?.breadcrumbs ?? [];
  const pagination = data?.pagination;

  // Client-side filter for "shared" — show only files with share links
  const folders = activeFilter === "shared" ? [] : allFolders;
  const files = activeFilter === "shared"
    ? allFiles.filter((f) => f.share_count > 0)
    : allFiles;

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="mb-4 flex items-center justify-between">
        <div>
          {/* Breadcrumbs */}
          <div className="flex items-center gap-1 text-sm">
            <button
              onClick={() => setSearchParams({})}
              className="text-[var(--color-text-secondary)] hover:text-[var(--color-text)]"
            >
              Files
            </button>
            {breadcrumbs.map((bc) => (
              <span key={bc.id} className="flex items-center gap-1">
                <ChevronRight
                  size={14}
                  className="text-[var(--color-text-muted)]"
                />
                <button
                  onClick={() => navigateToFolder(bc.id)}
                  className="text-[var(--color-text-secondary)] hover:text-[var(--color-text)]"
                >
                  {bc.name}
                </button>
              </span>
            ))}
          </div>
        </div>
        <div className="flex items-center gap-2">
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
              className="rounded-lg border py-1.5 pl-8 pr-3 text-sm outline-none focus:border-[var(--color-primary)]"
              style={{ borderColor: "var(--color-border)", width: 200 }}
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
              className={`p-1.5 ${viewMode === "table" ? "bg-[var(--color-bg-tertiary)]" : ""}`}
            >
              <LayoutList size={16} />
            </button>
            <button
              onClick={() => setViewMode("card")}
              className={`p-1.5 ${viewMode === "card" ? "bg-[var(--color-bg-tertiary)]" : ""}`}
            >
              <LayoutGrid size={16} />
            </button>
          </div>

          {/* New Folder */}
          <button
            onClick={() => setShowCreateFolder(true)}
            className="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium text-white"
            style={{ background: "var(--color-primary)" }}
          >
            <Plus size={14} />
            New folder
          </button>
        </div>
      </div>

      {/* Filter Chips */}
      <div className="mb-3 flex items-center gap-1.5">
        {[
          { id: "all", label: "All" },
          { id: "documents", label: "Documents" },
          { id: "videos", label: "Videos" },
          { id: "images", label: "Images" },
          { id: "shared", label: "Shared" },
          { id: "deleted", label: "Deleted" },
          { id: "hidden", label: "Hidden" },
        ].map((f) => (
          <button
            key={f.id}
            onClick={() => setFilter(f.id)}
            className={`rounded-full px-3 py-1 text-xs font-medium transition-colors ${
              activeFilter === f.id
                ? f.id === "deleted"
                  ? "bg-red-50 text-red-600"
                  : f.id === "hidden"
                    ? "bg-orange-50 text-orange-600"
                    : "bg-[var(--color-primary)]/10 text-[var(--color-primary)]"
                : "text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-tertiary)]"
            }`}
          >
            {f.label}
          </button>
        ))}
      </div>

      {/* Bulk Actions */}
      {selected.size > 0 && (
        <div className="mb-3 flex items-center gap-3 rounded-lg bg-[var(--color-bg-tertiary)] px-4 py-2 text-sm">
          <span className="font-medium">{selected.size} selected</span>
          <button
            className="flex items-center gap-1 text-[var(--color-text-secondary)] hover:text-[var(--color-text)]"
            onClick={async () => {
              try {
                const ids = Array.from(selected);
                const res = await api.post<{ ok: boolean; url: string }>("/api/files/download-zip", { file_ids: ids, workspace_id: active!.id });
                if (res.url) window.open(res.url, "_blank");
                else toast.success("Download started");
              } catch (e: any) {
                toast.error(e instanceof ApiError ? e.message : "Failed");
              }
            }}
          >
            <FileArchive size={14} /> Download ZIP
          </button>
          <button
            className="flex items-center gap-1 text-[var(--color-text-secondary)] hover:text-[var(--color-text)]"
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
          </button>
          <button
            className="flex items-center gap-1 text-[var(--color-danger)] hover:text-[var(--color-danger-hover)]"
            onClick={() => {
              const ids = Array.from(selected);
              const names = ids.map((id) => {
                const file = allFiles.find((f) => f.id === id);
                const folder = allFolders.find((f) => f.id === id);
                return file?.name ?? folder?.name ?? id;
              });
              setDeleteConfirm({ ids, names });
            }}
          >
            <Trash2 size={14} /> Delete
          </button>
          <button
            className="ml-auto text-xs text-[var(--color-text-muted)]"
            onClick={() => setSelected(new Set())}
          >
            Clear
          </button>
        </div>
      )}

      {/* Content */}
      {isLoading ? (
        <div className="space-y-2">
          {Array.from({ length: 8 }).map((_, i) => (
            <div
              key={i}
              className="h-12 animate-pulse rounded-lg bg-[var(--color-bg-tertiary)]"
            />
          ))}
        </div>
      ) : viewMode === "table" ? (
        <div className="flex-1 overflow-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b text-xs text-[var(--color-text-muted)]" style={{ borderColor: "var(--color-border)" }}>
                <th className="w-8 py-2 pl-3">
                  <input
                    type="checkbox"
                    onChange={(e) => {
                      if (e.target.checked) {
                        setSelected(
                          new Set([
                            ...folders.map((f) => f.id),
                            ...files.map((f) => f.id),
                          ]),
                        );
                      } else {
                        setSelected(new Set());
                      }
                    }}
                  />
                </th>
                <th className="py-2 font-medium">Name</th>
                <th className="py-2 font-medium w-24">Size</th>
                <th className="py-2 font-medium w-28">Modified</th>
                <th className="py-2 font-medium w-28">Region</th>
                <th className="w-10 py-2"></th>
              </tr>
            </thead>
            <tbody>
              {folders.map((folder) => (
                <tr
                  key={folder.id}
                  className="border-b hover:bg-[var(--color-bg-secondary)] cursor-pointer transition-colors"
                  style={{ borderColor: "var(--color-border)" }}
                  onDoubleClick={() => navigateToFolder(folder.id)}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    setContextMenu({
                      x: e.clientX,
                      y: e.clientY,
                      item: { id: folder.id, name: folder.name, kind: "folder" },
                    });
                  }}
                >
                  <td className="py-2 pl-3">
                    <input
                      type="checkbox"
                      checked={selected.has(folder.id)}
                      onChange={() => toggleSelect(folder.id)}
                      onClick={(e) => e.stopPropagation()}
                    />
                  </td>
                  <td className="py-2">
                    <div className="flex items-center gap-2.5">
                      <FolderIcon fileCount={folder.file_count} size={18} className="shrink-0" synced={!!(syncedFolderIds.has(folder.id) || folder.is_synced)} />
                      <span className="truncate font-medium">{folder.name}</span>
                      {folder.lock_mode !== "none" && (
                        <Lock size={12} className="text-[var(--color-text-muted)]" />
                      )}
                    </div>
                  </td>
                  <td className="py-2 text-[var(--color-text-muted)]">
                    {folder.file_count} items
                  </td>
                  <td className="py-2 text-[var(--color-text-muted)]">
                    {formatDate(folder.created_at)}
                  </td>
                  <td className="py-2 text-[var(--color-text-muted)]">—</td>
                  <td className="py-2">
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        setContextMenu({
                          x: e.clientX,
                          y: e.clientY,
                          item: { id: folder.id, name: folder.name, kind: "folder" },
                        });
                      }}
                      className="rounded p-1 hover:bg-[var(--color-bg-tertiary)]"
                    >
                      <MoreHorizontal size={14} />
                    </button>
                  </td>
                </tr>
              ))}
              {files.map((file) => (
                <tr
                  key={file.id}
                  className="border-b hover:bg-[var(--color-bg-secondary)] cursor-pointer transition-colors"
                  style={{ borderColor: "var(--color-border)" }}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    setContextMenu({
                      x: e.clientX,
                      y: e.clientY,
                      item: { id: file.id, name: file.name, kind: "file" },
                    });
                  }}
                >
                  <td className="py-2 pl-3">
                    <input
                      type="checkbox"
                      checked={selected.has(file.id)}
                      onChange={() => toggleSelect(file.id)}
                    />
                  </td>
                  <td className="py-2">
                    <div className="flex items-center gap-2.5">
                      <FileIcon name={file.name} size={18} className="shrink-0" />
                      <span
                        className="truncate hover:text-[var(--color-primary)] hover:underline"
                        onClick={() => openFile(file.id, file.name)}
                      >
                        {file.name}
                      </span>
                      {file.lock_mode !== "none" && (
                        <Lock size={12} className="text-[var(--color-text-muted)]" />
                      )}
                      {file.share_count > 0 && (
                        <Share2 size={12} className="text-[var(--color-primary)]" />
                      )}
                    </div>
                  </td>
                  <td className="py-2 text-[var(--color-text-muted)]">
                    {formatBytes(file.size_bytes)}
                  </td>
                  <td className="py-2 text-[var(--color-text-muted)]">
                    {formatDate(file.updated_at)}
                  </td>
                  <td className="py-2 text-[var(--color-text-muted)] text-xs">
                    {file.region}
                  </td>
                  <td className="py-2">
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        setContextMenu({
                          x: e.clientX,
                          y: e.clientY,
                          item: { id: file.id, name: file.name, kind: "file" },
                        });
                      }}
                      className="rounded p-1 hover:bg-[var(--color-bg-tertiary)]"
                    >
                      <MoreHorizontal size={14} />
                    </button>
                  </td>
                </tr>
              ))}
              {folders.length === 0 && files.length === 0 && (
                <tr>
                  <td colSpan={6} className="py-16 text-center text-sm text-[var(--color-text-muted)]">
                    {search ? "No files match your search" : "This folder is empty"}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      ) : (
        /* Card View */
        <div className="flex-1 overflow-auto">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
            {folders.map((folder) => (
              <div
                key={folder.id}
                className="cursor-pointer rounded-xl border p-4 hover:bg-[var(--color-bg-secondary)] transition-colors"
                style={{ borderColor: "var(--color-border)" }}
                onDoubleClick={() => navigateToFolder(folder.id)}
              >
                <FolderIcon fileCount={folder.file_count} size={32} className="mb-3" synced={!!(syncedFolderIds.has(folder.id) || folder.is_synced)} />
                <p className="truncate text-sm font-medium">{folder.name}</p>
                <p className="text-xs text-[var(--color-text-muted)]">
                  {folder.file_count} items
                </p>
              </div>
            ))}
            {files.map((file) => (
              <div
                key={file.id}
                className="cursor-pointer rounded-xl border p-4 hover:bg-[var(--color-bg-secondary)] transition-colors"
                style={{ borderColor: "var(--color-border)" }}
                onClick={() => openFile(file.id, file.name)}
              >
                <FileIcon name={file.name} size={32} className="mb-3" />
                <p className="truncate text-sm font-medium">{file.name}</p>
                <p className="text-xs text-[var(--color-text-muted)]">
                  {formatBytes(file.size_bytes)}
                </p>
              </div>
            ))}
          </div>
          {folders.length === 0 && files.length === 0 && (
            <div className="py-16 text-center text-sm text-[var(--color-text-muted)]">
              {search ? "No files match your search" : "This folder is empty"}
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
          <div
            className="fixed inset-0 z-40"
            onClick={() => setContextMenu(null)}
          />
          <div
            className="fixed z-50 w-48 origin-top-left rounded-lg border bg-[var(--color-bg)] py-1 shadow-lg animate-[ctx-in_0.15s_ease-out]"
            style={{
              left: Math.min(contextMenu.x, window.innerWidth - 208),
              top: Math.min(contextMenu.y, window.innerHeight - 400),
              borderColor: "var(--color-border)",
            }}
          >
            {contextMenu.item.kind === "folder" && (
              <CtxItem
                icon={<FolderOpen size={14} />}
                label="Open"
                onClick={() => {
                  navigateToFolder(contextMenu.item.id);
                  setContextMenu(null);
                }}
              />
            )}
            <CtxItem
              icon={<Pencil size={14} />}
              label="Rename"
              onClick={() => {
                setRenameItem(contextMenu.item);
                setRenameName(contextMenu.item.name);
                setContextMenu(null);
              }}
            />
            {contextMenu.item.kind === "file" && (
              <CtxItem
                icon={<ExternalLink size={14} />}
                label="Open"
                onClick={() => {
                  openFile(contextMenu.item.id, contextMenu.item.name);
                  setContextMenu(null);
                }}
              />
            )}
            <CtxItem icon={<Share2 size={14} />} label="Share" onClick={() => setContextMenu(null)} />
            {contextMenu.item.kind === "file" && (
              <CtxItem
                icon={<Copy size={14} />}
                label="Copy to..."
                onClick={() => {
                  setCopyTarget({ id: contextMenu.item.id, name: contextMenu.item.name });
                  setPickerFolder(null);
                  setContextMenu(null);
                }}
              />
            )}
            <CtxItem
              icon={<Move size={14} />}
              label="Move to..."
              onClick={() => {
                setMoveTarget({ id: contextMenu.item.id, name: contextMenu.item.name, kind: contextMenu.item.kind });
                setPickerFolder(null);
                setContextMenu(null);
              }}
            />
            {contextMenu.item.kind === "file" && (
              <CtxItem
                icon={<Info size={14} />}
                label="Info"
                onClick={() => {
                  const f = files.find((f) => f.id === contextMenu.item.id);
                  if (f) setInfoFile(f);
                  setContextMenu(null);
                }}
              />
            )}
            {contextMenu.item.kind === "file" && (
              <CtxItem
                icon={<History size={14} />}
                label="Version history"
                onClick={() => {
                  window.open(`https://dosya.dev/files/versions?id=${contextMenu.item.id}`, "_blank");
                  setContextMenu(null);
                }}
              />
            )}
            {contextMenu.item.kind === "file" && (
              <CtxItem
                icon={<Mail size={14} />}
                label="Share via email"
                onClick={async () => {
                  const email = prompt("Enter recipient email:");
                  if (email) {
                    try {
                      await api.post(`/api/files/${contextMenu.item.id}/share-email`, { email, workspace_id: active!.id });
                      toast.success(`Share link sent to ${email}`);
                    } catch (e: any) {
                      toast.error(e instanceof ApiError ? e.message : "Failed");
                    }
                  }
                  setContextMenu(null);
                }}
              />
            )}
            <CtxItem
              icon={<LockKeyhole size={14} />}
              label="Lock"
              onClick={async () => {
                try {
                  const endpoint = contextMenu.item.kind === "folder"
                    ? `/api/folders/${contextMenu.item.id}/lock`
                    : `/api/files/${contextMenu.item.id}/lock`;
                  await api.put(endpoint, { lock_mode: "view_only" });
                  queryClient.invalidateQueries({ queryKey: ["files"] });
                  toast.success("Locked");
                } catch (e: any) {
                  toast.error(e instanceof ApiError ? e.message : "Failed");
                }
                setContextMenu(null);
              }}
            />
            <CtxItem
              icon={<Unlock size={14} />}
              label="Unlock"
              onClick={async () => {
                try {
                  const endpoint = contextMenu.item.kind === "folder"
                    ? `/api/folders/${contextMenu.item.id}/unlock`
                    : `/api/files/${contextMenu.item.id}/unlock`;
                  await api.put(endpoint);
                  queryClient.invalidateQueries({ queryKey: ["files"] });
                  toast.success("Unlocked");
                } catch (e: any) {
                  toast.error(e instanceof ApiError ? e.message : "Failed");
                }
                setContextMenu(null);
              }}
            />
            <CtxItem
              icon={<EyeOff size={14} />}
              label="Hide"
              onClick={async () => {
                try {
                  const endpoint = contextMenu.item.kind === "folder"
                    ? `/api/folders/${contextMenu.item.id}/hide`
                    : `/api/files/${contextMenu.item.id}/hide`;
                  await api.put(endpoint, { hidden_mode: "everyone" });
                  queryClient.invalidateQueries({ queryKey: ["files"] });
                  toast.success("Hidden");
                } catch (e: any) {
                  toast.error(e instanceof ApiError ? e.message : "Failed");
                }
                setContextMenu(null);
              }}
            />
            <div className="my-1 h-px bg-[var(--color-border)]" />
            <CtxItem
              icon={<Trash2 size={14} />}
              label="Delete"
              danger
              onClick={() => {
                setDeleteConfirm({
                  ids: [contextMenu.item.id],
                  names: [contextMenu.item.name],
                });
                setContextMenu(null);
              }}
            />
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
            onKeyDown={(e) =>
              e.key === "Enter" && newFolderName && createFolderMut.mutate(newFolderName)
            }
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
                renameName &&
                renameMut.mutate({ id: renameItem.id, name: renameName, kind: renameItem.kind })
              }
              className="rounded-lg px-4 py-2 text-sm font-medium text-white"
              style={{ background: "var(--color-primary)" }}
            >
              Rename
            </button>
          </div>
        </Modal>
      )}

      {/* File Info & Comments Panel */}
      {infoFile && (
        <FileDetailPanel
          file={infoFile}
          workspaceId={active!.id}
          onClose={() => setInfoFile(null)}
        />
      )}

      {/* Move / Copy Folder Picker Modal */}
      {/* Delete Confirmation Modal */}
      {deleteConfirm && (
        <Modal onClose={() => setDeleteConfirm(null)}>
          <div className="flex items-start gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-red-50">
              <Trash2 size={20} className="text-[var(--color-danger)]" />
            </div>
            <div>
              <h3 className="text-lg font-semibold">Delete {deleteConfirm.ids.length === 1 ? "item" : `${deleteConfirm.ids.length} items`}?</h3>
              <p className="mt-1 text-sm text-[var(--color-text-secondary)]">
                {deleteConfirm.ids.length === 1 ? (
                  <>Are you sure you want to delete <strong>{deleteConfirm.names[0]}</strong>?</>
                ) : (
                  <>Are you sure you want to delete these {deleteConfirm.ids.length} items?</>
                )}
              </p>
              {deleteConfirm.ids.length > 1 && deleteConfirm.ids.length <= 5 && (
                <ul className="mt-2 space-y-0.5 text-xs text-[var(--color-text-muted)]">
                  {deleteConfirm.names.map((n, i) => (
                    <li key={i} className="truncate">· {n}</li>
                  ))}
                </ul>
              )}
              <p className="mt-2 text-xs text-[var(--color-text-muted)]">
                This action can be undone from the Deleted filter.
              </p>
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
              onClick={() => {
                deleteConfirm.ids.forEach((id) => deleteMut.mutate(id));
                setSelected(new Set());
                setDeleteConfirm(null);
              }}
              className="rounded-lg bg-[var(--color-danger)] px-4 py-2 text-sm font-medium text-white hover:opacity-90"
            >
              Delete
            </button>
          </div>
        </Modal>
      )}

      {(moveTarget || copyTarget) && (
        <FolderPickerModal
          title={moveTarget ? `Move "${moveTarget.name}"` : `Copy "${copyTarget!.name}"`}
          actionLabel={moveTarget ? "Move here" : "Copy here"}
          folders={folderTreeData?.folders ?? []}
          selectedId={pickerFolder}
          excludeId={moveTarget?.kind === "folder" ? moveTarget.id : undefined}
          isPending={moveMut.isPending || copyMut.isPending}
          onSelect={setPickerFolder}
          onConfirm={() => {
            if (moveTarget) {
              moveMut.mutate({ id: moveTarget.id, kind: moveTarget.kind, targetId: pickerFolder });
            } else if (copyTarget) {
              copyMut.mutate({ id: copyTarget.id, targetId: pickerFolder });
            }
          }}
          onClose={() => {
            setMoveTarget(null);
            setCopyTarget(null);
            setPickerFolder(null);
          }}
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

function Modal({
  children,
  onClose,
}: {
  children: React.ReactNode;
  onClose: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30">
      <div
        className="w-full max-w-md rounded-xl bg-[var(--color-bg)] p-6 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        {children}
      </div>
      <div className="fixed inset-0 -z-10" onClick={onClose} />
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
  // Build tree from flat list
  const getChildren = (parentId: string | null) =>
    folders.filter((f) => f.parent_id === parentId && f.id !== excludeId);

  const rootFolders = getChildren(null);

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

        <div className="max-h-72 overflow-y-auto p-2">
          {/* Root option */}
          <button
            onClick={() => onSelect(null)}
            className={`flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-sm transition-colors ${
              selectedId === null
                ? "bg-[var(--color-primary)]/10 font-medium text-[var(--color-primary)]"
                : "hover:bg-[var(--color-bg-secondary)]"
            }`}
          >
            <FolderIcon fileCount={1} size={16} />
            Root (top level)
          </button>

          {/* Folder tree */}
          {rootFolders.map((f) => (
            <FolderTreeItem
              key={f.id}
              folder={f}
              allFolders={folders}
              excludeId={excludeId}
              selectedId={selectedId}
              onSelect={onSelect}
              depth={0}
            />
          ))}

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

function FolderTreeItem({
  folder,
  allFolders,
  excludeId,
  selectedId,
  onSelect,
  depth,
}: {
  folder: { id: string; name: string; parent_id: string | null; file_count: number };
  allFolders: { id: string; name: string; parent_id: string | null; file_count: number }[];
  excludeId?: string;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  depth: number;
}) {
  const children = allFolders.filter((f) => f.parent_id === folder.id && f.id !== excludeId);

  return (
    <>
      <button
        onClick={() => onSelect(folder.id)}
        className={`flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-sm transition-colors ${
          selectedId === folder.id
            ? "bg-[var(--color-primary)]/10 font-medium text-[var(--color-primary)]"
            : "hover:bg-[var(--color-bg-secondary)]"
        }`}
        style={{ paddingLeft: `${12 + depth * 20}px` }}
      >
        <FolderIcon fileCount={folder.file_count} size={16} />
        <span className="truncate">{folder.name}</span>
      </button>
      {children.map((child) => (
        <FolderTreeItem
          key={child.id}
          folder={child}
          allFolders={allFolders}
          excludeId={excludeId}
          selectedId={selectedId}
          onSelect={onSelect}
          depth={depth + 1}
        />
      ))}
    </>
  );
}

interface Comment {
  id: string;
  user_id: string;
  parent_id: string | null;
  body: string;
  is_edited: number;
  created_at: number;
  user_name: string;
  user_email: string;
  user_avatar: string | null;
}

function FileDetailPanel({
  file,
  workspaceId,
  onClose,
}: {
  file: {
    id: string;
    name: string;
    size_bytes: number;
    mime_type: string;
    extension: string | null;
    region: string;
    uploader_name: string | null;
    created_at: number;
    updated_at: number;
    lock_mode: string;
    share_count: number;
    comment_count: number;
  };
  workspaceId: string;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<"info" | "comments">("info");
  const [newComment, setNewComment] = useState("");
  const queryClient = useQueryClient();

  const { data: commentsData, isLoading: commentsLoading } = useQuery({
    queryKey: ["comments", file.id],
    queryFn: () =>
      api.get<{ ok: boolean; comments: Comment[] }>(
        `/api/comments?file_id=${file.id}&workspace_id=${workspaceId}`,
      ),
    enabled: tab === "comments",
  });

  const postMut = useMutation({
    mutationFn: (body: string) =>
      api.post<{ ok: boolean; comment: Comment }>("/api/comments", {
        file_id: file.id,
        workspace_id: workspaceId,
        body,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["comments", file.id] });
      setNewComment("");
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : "Failed"),
  });

  const deleteMut = useMutation({
    mutationFn: (id: string) => api.delete(`/api/comments/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["comments", file.id] });
      toast.success("Comment deleted");
    },
  });

  const comments = commentsData?.comments ?? [];
  // Group: top-level + replies
  const topLevel = comments.filter((c) => !c.parent_id);
  const replies = (parentId: string) => comments.filter((c) => c.parent_id === parentId);

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/20">
      <div className="fixed inset-0" onClick={onClose} />
      <div
        className="relative z-10 flex h-full w-80 flex-col border-l bg-[var(--color-bg)] shadow-xl"
        style={{ borderColor: "var(--color-border)" }}
      >
        {/* Header */}
        <div
          className="flex items-center justify-between border-b px-5 py-3"
          style={{ borderColor: "var(--color-border)" }}
        >
          <span className="text-sm font-semibold">File details</span>
          <button
            onClick={onClose}
            className="rounded p-1 hover:bg-[var(--color-bg-tertiary)]"
          >
            <X size={14} />
          </button>
        </div>

        {/* Preview */}
        <div className="flex items-center justify-center bg-[var(--color-bg-tertiary)] py-6">
          <FileIcon name={file.name} size={56} />
        </div>

        {/* File name */}
        <div
          className="border-b px-5 py-3"
          style={{ borderColor: "var(--color-border)" }}
        >
          <p className="text-sm font-semibold break-all">{file.name}</p>
          <p className="mt-0.5 text-xs text-[var(--color-text-muted)]">
            {formatBytes(file.size_bytes)} · {file.mime_type} ·{" "}
            {formatRelative(file.created_at)}
          </p>
        </div>

        {/* Tabs */}
        <div
          className="flex border-b"
          style={{ borderColor: "var(--color-border)" }}
        >
          <button
            onClick={() => setTab("info")}
            className={`flex-1 py-2.5 text-xs font-medium transition-colors ${
              tab === "info"
                ? "border-b-2 border-[var(--color-primary)] text-[var(--color-primary)]"
                : "text-[var(--color-text-secondary)]"
            }`}
          >
            Properties
          </button>
          <button
            onClick={() => setTab("comments")}
            className={`flex flex-1 items-center justify-center gap-1.5 py-2.5 text-xs font-medium transition-colors ${
              tab === "comments"
                ? "border-b-2 border-[var(--color-primary)] text-[var(--color-primary)]"
                : "text-[var(--color-text-secondary)]"
            }`}
          >
            <MessageCircle size={12} />
            Comments
            {file.comment_count > 0 && (
              <span className="rounded-full bg-[var(--color-bg-tertiary)] px-1.5 text-xs">
                {file.comment_count}
              </span>
            )}
          </button>
        </div>

        {/* Tab Content */}
        {tab === "info" ? (
          <div className="flex-1 overflow-y-auto px-5 py-4">
            <div className="space-y-2.5">
              <InfoRow label="Uploaded by" value={file.uploader_name ?? "Unknown"} />
              <InfoRow label="Region" value={file.region} />
              <InfoRow label="Size" value={formatBytes(file.size_bytes)} />
              <InfoRow label="Type" value={file.mime_type} />
              <InfoRow label="Extension" value={file.extension ?? "—"} />
              <InfoRow label="Created" value={formatDate(file.created_at)} />
              <InfoRow label="Modified" value={formatDate(file.updated_at)} />
              <InfoRow
                label="Lock"
                value={
                  file.lock_mode === "none"
                    ? "Unlocked"
                    : file.lock_mode === "view_only"
                      ? "View only"
                      : "Full lock"
                }
              />
              <InfoRow label="Shares" value={String(file.share_count)} />
              <InfoRow label="Comments" value={String(file.comment_count)} />
            </div>
          </div>
        ) : (
          <div className="flex flex-1 flex-col overflow-hidden">
            {/* Comments list */}
            <div className="flex-1 overflow-y-auto px-4 py-3">
              {commentsLoading ? (
                <div className="space-y-3">
                  {[1, 2, 3].map((i) => (
                    <div
                      key={i}
                      className="h-14 animate-pulse rounded-lg bg-[var(--color-bg-tertiary)]"
                    />
                  ))}
                </div>
              ) : comments.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-10 text-center">
                  <MessageCircle
                    size={28}
                    className="mb-2 text-[var(--color-text-muted)]"
                  />
                  <p className="text-sm text-[var(--color-text-muted)]">
                    No comments yet
                  </p>
                  <p className="text-xs text-[var(--color-text-muted)]">
                    Be the first to comment
                  </p>
                </div>
              ) : (
                <div className="space-y-3">
                  {topLevel.map((c) => (
                    <div key={c.id}>
                      <CommentBubble
                        comment={c}
                        onDelete={(id) => deleteMut.mutate(id)}
                      />
                      {/* Replies */}
                      {replies(c.id).map((r) => (
                        <div key={r.id} className="ml-6 mt-2">
                          <CommentBubble
                            comment={r}
                            onDelete={(id) => deleteMut.mutate(id)}
                          />
                        </div>
                      ))}
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* New comment input */}
            <div
              className="border-t px-4 py-3"
              style={{ borderColor: "var(--color-border)" }}
            >
              <div className="flex items-end gap-2">
                <textarea
                  value={newComment}
                  onChange={(e) => setNewComment(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey && newComment.trim()) {
                      e.preventDefault();
                      postMut.mutate(newComment.trim());
                    }
                  }}
                  placeholder="Write a comment..."
                  rows={1}
                  className="flex-1 resize-none rounded-lg border px-3 py-2 text-sm outline-none focus:border-[var(--color-primary)]"
                  style={{ borderColor: "var(--color-border)" }}
                />
                <button
                  onClick={() =>
                    newComment.trim() && postMut.mutate(newComment.trim())
                  }
                  disabled={!newComment.trim() || postMut.isPending}
                  className="rounded-lg p-2 text-white disabled:opacity-50"
                  style={{ background: "var(--color-primary)" }}
                >
                  <Send size={14} />
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function CommentBubble({
  comment,
  onDelete,
}: {
  comment: Comment;
  onDelete: (id: string) => void;
}) {
  return (
    <div className="group rounded-lg bg-[var(--color-bg-secondary)] px-3 py-2.5">
      <div className="mb-1 flex items-center justify-between">
        <div className="flex items-center gap-2">
          {comment.user_avatar ? (
            <img
              src={comment.user_avatar}
              alt=""
              className="h-5 w-5 rounded-full object-cover"
            />
          ) : (
            <div
              className="flex h-5 w-5 items-center justify-center rounded-full text-[10px] font-medium text-white"
              style={{ background: "var(--color-primary)" }}
            >
              {comment.user_name?.charAt(0).toUpperCase() || "?"}
            </div>
          )}
          <span className="text-xs font-medium">{comment.user_name}</span>
          <span className="text-[10px] text-[var(--color-text-muted)]">
            {formatRelative(comment.created_at)}
            {comment.is_edited === 1 && " (edited)"}
          </span>
        </div>
        <button
          onClick={() => onDelete(comment.id)}
          className="rounded p-0.5 text-[var(--color-text-muted)] opacity-0 transition-opacity hover:text-[var(--color-danger)] group-hover:opacity-100"
        >
          <Trash2 size={12} />
        </button>
      </div>
      <p className="text-sm whitespace-pre-wrap">{comment.body}</p>
    </div>
  );
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-start justify-between gap-4">
      <span className="text-xs text-[var(--color-text-muted)] shrink-0">{label}</span>
      <span className="text-xs text-right break-all">{value}</span>
    </div>
  );
}
