import { useState, useCallback, useRef, useEffect } from "react";
import { useDropzone } from "react-dropzone";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Upload,
  X,
  Check,
  Loader2,
  Shield,
  Globe,
  Plus,
  ChevronRight,
} from "lucide-react";
import { api, ApiError, apiRequest } from "@/lib/api-client";
import { useWorkspace } from "@/lib/workspace-context";
import { formatBytes } from "@/lib/format";
import { toast } from "sonner";
import { FileIcon, FolderIcon } from "@/components/files/FileIcon";

// ── Types ────────────────────────────────────────────────────────────

interface QueueItem {
  file: File;
  id: string;
  status: "pending" | "uploading" | "done" | "error";
  progress: number;
  error?: string;
}

interface RegionInfo {
  code: string;
  city: string;
  country: string;
  continent: string;
  flag?: string;
}

interface PickerFolder {
  id: string;
  name: string;
  parent_id: string | null;
  file_count: number;
}

// ── Page ─────────────────────────────────────────────────────────────

export function UploadPage() {
  const { active } = useWorkspace();
  const queryClient = useQueryClient();
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [selectedFolder, setSelectedFolder] = useState<{
    id: string | null;
    name: string;
  }>({ id: null, name: "Root (top level)" });
  const [selectedRegion, setSelectedRegion] = useState("");
  const [showFolderPicker, setShowFolderPicker] = useState(false);
  const [showCreateFolder, setShowCreateFolder] = useState(false);
  const [newFolderName, setNewFolderName] = useState("");
  const [pickerSelected, setPickerSelected] = useState<string | null>(null);

  // Fetch regions from API
  const { data: regionsData } = useQuery({
    queryKey: ["regions"],
    queryFn: () => api.get<{ ok: boolean; regions: RegionInfo[] }>("/api/regions"),
  });

  // Fetch workspace settings for available_regions + default_region
  const { data: wsData } = useQuery({
    queryKey: ["workspace-detail", active?.id],
    queryFn: () =>
      api.get<{
        ok: boolean;
        workspace?: { default_region: string };
        settings?: { available_regions: string | null } | null;
      }>(`/api/workspaces/${active?.id}`),
    enabled: !!active,
  });

  // Fetch folder tree
  const { data: foldersData } = useQuery({
    queryKey: ["folders-tree", active?.id],
    queryFn: () =>
      api.get<{ ok: boolean; folders: PickerFolder[] }>(
        `/api/folders/tree?workspace_id=${active?.id}`,
      ),
    enabled: !!active,
  });

  // Compute available regions
  const allRegions = regionsData?.regions ?? [];
  let availableCodes: string[] = [];
  if (wsData?.settings?.available_regions) {
    try {
      availableCodes = JSON.parse(wsData.settings.available_regions);
    } catch {}
  }
  const regions =
    availableCodes.length > 0
      ? allRegions.filter((r) => availableCodes.includes(r.code))
      : allRegions;

  // Set default region from workspace
  useEffect(() => {
    if (!selectedRegion && wsData?.workspace?.default_region) {
      setSelectedRegion(wsData.workspace.default_region);
    } else if (!selectedRegion && regions.length > 0) {
      setSelectedRegion(regions[0].code);
    }
  }, [wsData, regions, selectedRegion]);

  // Create folder mutation
  const createFolderMut = useMutation({
    mutationFn: (name: string) =>
      api.post<{ ok: boolean; folder: { id: string; name: string } }>("/api/folders", {
        workspace_id: active!.id,
        name,
        parent_id: selectedFolder.id,
      }),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["folders-tree"] });
      setShowCreateFolder(false);
      setNewFolderName("");
      if (data.folder) {
        setSelectedFolder({ id: data.folder.id, name: data.folder.name });
        setPickerSelected(data.folder.id);
      }
      toast.success("Folder created");
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : "Failed"),
  });

  // ── Upload logic ───────────────────────────────────────────────────

  const uploadFileRef = useRef<(item: QueueItem) => Promise<void>>(() => Promise.resolve());

  const uploadFile = async (item: QueueItem) => {
    setQueue((prev) =>
      prev.map((q) => (q.id === item.id ? { ...q, status: "uploading" } : q)),
    );
    try {
      const initRes = await api.post<{
        ok: boolean;
        session_id: string;
      }>("/api/upload/init", {
        workspace_id: active!.id,
        file_name: item.file.name,
        file_size: item.file.size,
        mime_type: item.file.type || "application/octet-stream",
        folder_id: selectedFolder.id,
        region: selectedRegion,
      });

      const buffer = await item.file.arrayBuffer();
      await apiRequest(`/api/upload/${initRes.session_id}`, {
        method: "PUT",
        body: buffer,
        headers: { "Content-Type": "application/octet-stream" },
      });

      setQueue((prev) =>
        prev.map((q) =>
          q.id === item.id ? { ...q, status: "done", progress: 100 } : q,
        ),
      );
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Upload failed";
      setQueue((prev) =>
        prev.map((q) =>
          q.id === item.id ? { ...q, status: "error", error: message } : q,
        ),
      );
    }
  };

  uploadFileRef.current = uploadFile;

  const onDrop = useCallback((acceptedFiles: File[]) => {
    const items: QueueItem[] = acceptedFiles.map((file) => ({
      file,
      id: crypto.randomUUID(),
      status: "pending" as const,
      progress: 0,
    }));
    setQueue((prev) => [...prev, ...items]);
    setTimeout(() => {
      for (const item of items) {
        uploadFileRef.current(item);
      }
    }, 0);
  }, []);

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    noClick: false,
    multiple: true,
  });

  const uploadAll = async () => {
    const pending = queue.filter((q) => q.status === "pending");
    for (const item of pending) {
      await uploadFile(item);
    }
    queryClient.invalidateQueries({ queryKey: ["files"] });
    queryClient.invalidateQueries({ queryKey: ["dashboard"] });
    toast.success(`${pending.length} file(s) uploaded`);
  };

  const clearDone = () => setQueue((prev) => prev.filter((q) => q.status !== "done"));
  const removeItem = (id: string) => setQueue((prev) => prev.filter((q) => q.id !== id));

  const pendingCount = queue.filter((q) => q.status === "pending").length;
  const uploading = queue.some((q) => q.status === "uploading");
  const folders = foldersData?.folders ?? [];

  // Sort regions: selected first
  const sortedRegions = [...regions].sort((a, b) => {
    if (a.code === selectedRegion) return -1;
    if (b.code === selectedRegion) return 1;
    return 0;
  });

  return (
    <div className="flex h-full gap-6">
      {/* Left Column */}
      <div className="flex-1 space-y-4">
        <div>
          <h1 className="text-2xl font-semibold">Upload files</h1>
          <p className="text-sm text-[var(--color-text-muted)]">
            {selectedFolder.id
              ? <>Uploading to <strong className="text-[var(--color-text)]">{selectedFolder.name}</strong> · encrypted in transit</>
              : "Files are end-to-end encrypted in transit. You pick the region."}
          </p>
        </div>

        {/* Drop Zone */}
        <div
          {...getRootProps()}
          className={`flex cursor-pointer flex-col items-center justify-center rounded-xl border-2 border-dashed p-12 transition-colors ${
            isDragActive
              ? "border-[var(--color-primary)] bg-[var(--color-primary)]/5"
              : "border-[var(--color-border)] hover:border-[var(--color-primary)]/50"
          }`}
        >
          <input {...getInputProps()} />
          <Upload
            size={40}
            className={`mb-4 ${isDragActive ? "text-[var(--color-primary)]" : "text-[var(--color-text-muted)]"}`}
          />
          <p className="text-sm font-medium">
            {isDragActive ? "Drop files here" : "Drop files here to upload"}
          </p>
          <p className="mt-1 text-xs text-[var(--color-text-muted)]">
            Drag and drop anything, or <span className="font-semibold cursor-pointer">browse your computer</span>
          </p>
          <div className="mt-3 flex gap-2">
            {["Video", "Images", "Documents", "Archives", "Any format"].map((t) => (
              <span key={t} className="rounded-full bg-[var(--color-bg-tertiary)] px-2.5 py-0.5 text-[10px] font-medium text-[var(--color-text-secondary)]">
                {t}
              </span>
            ))}
          </div>
        </div>

        {/* Queue */}
        {queue.length > 0 && (
          <div className="rounded-xl border p-4" style={{ borderColor: "var(--color-border)" }}>
            <div className="mb-3 flex items-center justify-between">
              <div>
                <h3 className="text-sm font-semibold">Upload queue</h3>
                <p className="text-xs text-[var(--color-text-muted)]">
                  {queue.length} file{queue.length !== 1 ? "s" : ""} · {formatBytes(queue.reduce((s, q) => s + q.file.size, 0))} total · {queue.filter((q) => q.status === "done").length} complete
                </p>
              </div>
            </div>
            <div className="space-y-1 max-h-80 overflow-auto">
              {queue.map((item) => (
                <div key={item.id} className="flex items-center gap-3 rounded-lg px-3 py-2 text-sm hover:bg-[var(--color-bg-secondary)]">
                  {item.status === "done" ? (
                    <Check size={16} className="text-[var(--color-primary)] shrink-0" />
                  ) : item.status === "uploading" ? (
                    <Loader2 size={16} className="animate-spin text-[var(--color-primary)] shrink-0" />
                  ) : item.status === "error" ? (
                    <X size={16} className="text-[var(--color-danger)] shrink-0" />
                  ) : (
                    <FileIcon name={item.file.name} size={16} className="shrink-0" />
                  )}
                  <span className="flex-1 truncate">{item.file.name}</span>
                  <span className="text-xs text-[var(--color-text-muted)]">{formatBytes(item.file.size)}</span>
                  {item.status === "error" && (
                    <span className="text-xs text-[var(--color-danger)]">{item.error}</span>
                  )}
                  {item.status === "pending" && (
                    <button onClick={() => removeItem(item.id)} className="text-[var(--color-text-muted)] hover:text-[var(--color-danger)]">
                      <X size={14} />
                    </button>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Right Column: Options */}
      <div className="w-72 space-y-4">
        <div className="rounded-xl border p-4" style={{ borderColor: "var(--color-border)" }}>
          <p className="mb-3 text-xs font-semibold text-[var(--color-text-secondary)]">Upload options</p>

          {/* Folder */}
          <div className="mb-4">
            <p className="mb-1.5 flex items-center gap-1 text-xs font-medium text-[var(--color-text-secondary)]">
              <FolderIcon fileCount={1} size={13} />
              Folder
            </p>
            <button
              onClick={() => {
                setPickerSelected(selectedFolder.id);
                setShowFolderPicker(true);
              }}
              className="flex w-full items-center gap-2 rounded-lg border px-3 py-2 text-sm transition-colors hover:bg-[var(--color-bg-secondary)]"
              style={{ borderColor: "var(--color-border)" }}
            >
              {selectedFolder.id ? (
                <FolderIcon fileCount={1} size={14} />
              ) : (
                <svg viewBox="0 0 14 14" fill="none" width="14" height="14"><path d="M2 7.5V12a1 1 0 001 1h3V10h2v3h3a1 1 0 001-1V7.5M1 7l6-5 6 5" stroke="#706E69" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" /></svg>
              )}
              <span className={`flex-1 truncate text-left ${!selectedFolder.id ? "text-[var(--color-text-muted)]" : ""}`}>
                {selectedFolder.name}
              </span>
              <ChevronRight size={12} className="text-[var(--color-text-muted)]" />
            </button>
            <button
              onClick={() => setShowCreateFolder(true)}
              className="mt-1.5 flex items-center gap-1.5 text-xs text-[var(--color-text-secondary)] hover:text-[var(--color-text)]"
            >
              <Plus size={11} />
              Create new folder
            </button>
          </div>

          <div className="my-3 h-px bg-[var(--color-border)]" />

          {/* Region */}
          <div>
            <p className="mb-1.5 flex items-center gap-1 text-xs font-medium text-[var(--color-text-secondary)]">
              <Globe size={13} />
              Select region
              <span className="ml-auto text-[10px] font-normal text-[var(--color-text-muted)]">
                {regions.length} available
              </span>
            </p>
            <div className="grid grid-cols-1 gap-1.5 max-h-60 overflow-y-auto">
              {sortedRegions.map((r) => (
                <button
                  key={r.code}
                  onClick={() => setSelectedRegion(r.code)}
                  className={`flex items-start rounded-lg border px-3 py-2 text-left transition-colors ${
                    selectedRegion === r.code
                      ? "border-[var(--color-primary)] bg-[var(--color-primary)]/5"
                      : "hover:bg-[var(--color-bg-secondary)]"
                  }`}
                  style={{
                    borderColor:
                      selectedRegion === r.code ? "var(--color-primary)" : "var(--color-border)",
                  }}
                >
                  <div>
                    <p className={`text-xs font-medium ${selectedRegion === r.code ? "text-[var(--color-primary)]" : ""}`}>
                      {r.city}, {r.country}
                    </p>
                    <p className="text-[10px] text-[var(--color-text-muted)]">{r.code}</p>
                  </div>
                </button>
              ))}
              {regions.length === 0 && (
                <p className="py-3 text-center text-xs text-[var(--color-text-muted)]">Loading regions...</p>
              )}
            </div>
          </div>
        </div>

        {/* Info */}
        <div className="rounded-xl bg-[var(--color-bg-secondary)] p-4 text-xs text-[var(--color-text-secondary)]">
          <div className="flex items-center gap-2 mb-2">
            <Shield size={14} />
            <span className="font-medium">Secure upload</span>
          </div>
          <p>Encrypted in transit with TLS 1.3</p>
          <p className="mt-1">No egress fees — ever</p>
        </div>
      </div>

      {/* Folder Picker Modal */}
      {showFolderPicker && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30">
          <div className="w-full max-w-sm rounded-xl bg-[var(--color-bg)] shadow-xl" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between border-b px-5 py-4" style={{ borderColor: "var(--color-border)" }}>
              <h3 className="text-base font-semibold">Select folder</h3>
              <button onClick={() => setShowFolderPicker(false)} className="rounded p-1 hover:bg-[var(--color-bg-tertiary)]">
                <X size={14} />
              </button>
            </div>
            <div className="max-h-72 overflow-y-auto p-2">
              {/* Root */}
              <button
                onClick={() => setPickerSelected(null)}
                className={`flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-sm transition-colors ${
                  pickerSelected === null
                    ? "bg-[var(--color-primary)]/10 font-medium text-[var(--color-primary)]"
                    : "hover:bg-[var(--color-bg-secondary)]"
                }`}
              >
                <svg viewBox="0 0 14 14" fill="none" width="14" height="14"><path d="M2 7.5V12a1 1 0 001 1h3V10h2v3h3a1 1 0 001-1V7.5M1 7l6-5 6 5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" /></svg>
                Root (top level)
              </button>
              {/* Tree */}
              {folders
                .filter((f) => f.parent_id === null)
                .map((f) => (
                  <PickerTreeItem
                    key={f.id}
                    folder={f}
                    all={folders}
                    selectedId={pickerSelected}
                    onSelect={setPickerSelected}
                    depth={0}
                  />
                ))}
            </div>
            <div className="flex justify-end gap-2 border-t px-5 py-3" style={{ borderColor: "var(--color-border)" }}>
              <button
                onClick={() => setShowFolderPicker(false)}
                className="rounded-lg border px-4 py-2 text-sm"
                style={{ borderColor: "var(--color-border)" }}
              >
                Cancel
              </button>
              <button
                onClick={() => {
                  const f = folders.find((f) => f.id === pickerSelected);
                  setSelectedFolder(
                    f ? { id: f.id, name: f.name } : { id: null, name: "Root (top level)" },
                  );
                  setShowFolderPicker(false);
                }}
                className="rounded-lg px-4 py-2 text-sm font-medium text-white"
                style={{ background: "var(--color-primary)" }}
              >
                Select folder
              </button>
            </div>
          </div>
          <div className="fixed inset-0 -z-10" onClick={() => setShowFolderPicker(false)} />
        </div>
      )}

      {/* Create Folder Modal */}
      {showCreateFolder && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30">
          <div className="w-full max-w-sm rounded-xl bg-[var(--color-bg)] p-6 shadow-xl" onClick={(e) => e.stopPropagation()}>
            <h3 className="mb-4 text-lg font-semibold">New folder</h3>
            <input
              type="text"
              value={newFolderName}
              onChange={(e) => setNewFolderName(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && newFolderName.trim() && createFolderMut.mutate(newFolderName.trim())}
              placeholder="Folder name"
              autoFocus
              className="mb-4 w-full rounded-lg border px-3 py-2 text-sm outline-none focus:border-[var(--color-primary)]"
              style={{ borderColor: "var(--color-border)" }}
            />
            <div className="flex justify-end gap-2">
              <button onClick={() => { setShowCreateFolder(false); setNewFolderName(""); }} className="rounded-lg border px-4 py-2 text-sm" style={{ borderColor: "var(--color-border)" }}>
                Cancel
              </button>
              <button
                onClick={() => newFolderName.trim() && createFolderMut.mutate(newFolderName.trim())}
                disabled={!newFolderName.trim() || createFolderMut.isPending}
                className="rounded-lg px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
                style={{ background: "var(--color-primary)" }}
              >
                {createFolderMut.isPending ? "Creating..." : "Create"}
              </button>
            </div>
          </div>
          <div className="fixed inset-0 -z-10" onClick={() => { setShowCreateFolder(false); setNewFolderName(""); }} />
        </div>
      )}
    </div>
  );
}

function PickerTreeItem({
  folder,
  all,
  selectedId,
  onSelect,
  depth,
}: {
  folder: PickerFolder;
  all: PickerFolder[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  depth: number;
}) {
  const children = all.filter((f) => f.parent_id === folder.id);
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
        <FolderIcon fileCount={folder.file_count} size={14} />
        <span className="truncate">{folder.name}</span>
      </button>
      {children.map((c) => (
        <PickerTreeItem key={c.id} folder={c} all={all} selectedId={selectedId} onSelect={onSelect} depth={depth + 1} />
      ))}
    </>
  );
}
