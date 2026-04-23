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
  Pause,
  Play,
  RefreshCw,
  AlertCircle,
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
  progress: number; // 0-100 byte-level
  bytesUploaded: number;
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

// ── Concurrent upload limit ──────────────────────────────────────────

const MAX_CONCURRENT = 3;

// ── Page ─────────────────────────────────────────────────────────────

export function UploadPage() {
  const { active } = useWorkspace();
  const queryClient = useQueryClient();
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [paused, setPaused] = useState(false);
  const [selectedFolder, setSelectedFolder] = useState<{
    id: string | null;
    name: string;
  }>({ id: null, name: "Root (top level)" });
  const [selectedRegion, setSelectedRegion] = useState("");
  const [showFolderPicker, setShowFolderPicker] = useState(false);
  const [showCreateFolder, setShowCreateFolder] = useState(false);
  const [newFolderName, setNewFolderName] = useState("");
  const [pickerSelected, setPickerSelected] = useState<string | null>(null);

  // Refs for upload loop access
  const queueRef = useRef(queue);
  queueRef.current = queue;
  const pausedRef = useRef(paused);
  pausedRef.current = paused;
  const abortControllers = useRef(new Map<string, AbortController>());

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

  const updateItem = (id: string, updates: Partial<QueueItem>) => {
    setQueue((prev) => prev.map((q) => (q.id === id ? { ...q, ...updates } : q)));
  };

  const uploadFile = async (item: QueueItem) => {
    if (pausedRef.current) return;
    updateItem(item.id, { status: "uploading", progress: 0, bytesUploaded: 0 });

    const controller = new AbortController();
    abortControllers.current.set(item.id, controller);

    try {
      // Step 1: Init upload session
      const initRes = await api.post<{ ok: boolean; session_id: string }>("/api/upload/init", {
        workspace_id: active!.id,
        file_name: item.file.name,
        file_size: item.file.size,
        mime_type: item.file.type || "application/octet-stream",
        folder_id: selectedFolder.id,
        region: selectedRegion,
      });

      if (controller.signal.aborted) throw new Error("Cancelled");

      // Step 2: Stream upload with progress via XMLHttpRequest
      // (fetch API doesn't support upload progress in browsers/Electron renderer)
      await new Promise<void>((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        const apiBase = (window as any).__apiBase || "";
        xhr.open("PUT", `${apiBase}/api/upload/${initRes.session_id}`);
        xhr.withCredentials = true;
        xhr.setRequestHeader("Content-Type", "application/octet-stream");

        xhr.upload.onprogress = (e) => {
          if (e.lengthComputable) {
            const pct = Math.round((e.loaded / e.total) * 100);
            updateItem(item.id, { progress: pct, bytesUploaded: e.loaded });
          }
        };

        xhr.onload = () => {
          if (xhr.status >= 200 && xhr.status < 300) {
            resolve();
          } else {
            try {
              const data = JSON.parse(xhr.responseText);
              reject(new Error(data.error || `Upload failed (${xhr.status})`));
            } catch {
              reject(new Error(`Upload failed (${xhr.status})`));
            }
          }
        };

        xhr.onerror = () => reject(new Error("Network error"));
        xhr.ontimeout = () => reject(new Error("Upload timed out"));
        xhr.timeout = 600_000; // 10 minutes

        // Cancel support
        controller.signal.addEventListener("abort", () => xhr.abort());

        // Send the File object directly — XHR streams it, no arrayBuffer() needed.
        // Memory: ~0 extra (browser/Electron handles File → stream internally)
        xhr.send(item.file);
      });

      updateItem(item.id, { status: "done", progress: 100, bytesUploaded: item.file.size });
    } catch (err: unknown) {
      if (controller.signal.aborted) {
        updateItem(item.id, { status: "pending", progress: 0, bytesUploaded: 0 });
      } else {
        const message = err instanceof Error ? err.message : "Upload failed";
        updateItem(item.id, { status: "error", error: message });
      }
    } finally {
      abortControllers.current.delete(item.id);
    }
  };

  // ── Concurrent upload processor ──────────────────────────────────

  const processingRef = useRef(false);

  const processQueue = useCallback(async () => {
    if (processingRef.current || pausedRef.current) return;
    processingRef.current = true;

    while (true) {
      if (pausedRef.current) break;

      const currentQueue = queueRef.current;
      const uploading = currentQueue.filter((q) => q.status === "uploading").length;
      if (uploading >= MAX_CONCURRENT) break;

      const next = currentQueue.find((q) => q.status === "pending");
      if (!next) break;

      // Don't await — let it run concurrently, then loop to start more
      uploadFile(next).then(() => {
        // After each file completes, try to start the next one
        processingRef.current = false;
        processQueue();
      });

      // Small yield to let state update
      await new Promise((r) => setTimeout(r, 10));
    }

    processingRef.current = false;
  }, [active, selectedFolder, selectedRegion]);

  // ── Drop handler ──────────────────────────────────────────────────

  const onDrop = useCallback((acceptedFiles: File[]) => {
    const items: QueueItem[] = acceptedFiles.map((file) => ({
      file,
      id: crypto.randomUUID(),
      status: "pending" as const,
      progress: 0,
      bytesUploaded: 0,
    }));
    setQueue((prev) => [...prev, ...items]);
    // Start processing after state update
    setTimeout(() => processQueue(), 50);
  }, [processQueue]);

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    noClick: false,
    multiple: true,
  });

  // ── Queue actions ─────────────────────────────────────────────────

  const clearDone = () => setQueue((prev) => prev.filter((q) => q.status !== "done"));

  const removeItem = (id: string) => {
    const ctrl = abortControllers.current.get(id);
    if (ctrl) ctrl.abort();
    setQueue((prev) => prev.filter((q) => q.id !== id));
  };

  const retryItem = (id: string) => {
    updateItem(id, { status: "pending", progress: 0, bytesUploaded: 0, error: undefined });
    setTimeout(() => processQueue(), 50);
  };

  const retryAll = () => {
    setQueue((prev) =>
      prev.map((q) =>
        q.status === "error"
          ? { ...q, status: "pending" as const, progress: 0, bytesUploaded: 0, error: undefined }
          : q,
      ),
    );
    setTimeout(() => processQueue(), 50);
  };

  const togglePause = () => {
    if (paused) {
      setPaused(false);
      setTimeout(() => processQueue(), 50);
    } else {
      setPaused(true);
    }
  };

  const cancelAll = () => {
    for (const [, ctrl] of abortControllers.current) ctrl.abort();
    setQueue((prev) =>
      prev.map((q) =>
        q.status === "uploading" ? { ...q, status: "pending" as const, progress: 0, bytesUploaded: 0 } : q,
      ),
    );
    setPaused(true);
  };

  // ── Aggregate stats ───────────────────────────────────────────────

  const totalFiles = queue.length;
  const doneCount = queue.filter((q) => q.status === "done").length;
  const errorCount = queue.filter((q) => q.status === "error").length;
  const uploading = queue.filter((q) => q.status === "uploading");
  const pendingCount = queue.filter((q) => q.status === "pending").length;
  const totalBytes = queue.reduce((s, q) => s + q.file.size, 0);
  const uploadedBytes = queue.reduce((s, q) => s + (q.status === "done" ? q.file.size : q.bytesUploaded), 0);
  const overallPct = totalBytes > 0 ? Math.round((uploadedBytes / totalBytes) * 100) : 0;
  const isActive = uploading.length > 0;

  const folders = foldersData?.folders ?? [];

  // Sort regions: selected first
  const sortedRegions = [...regions].sort((a, b) => {
    if (a.code === selectedRegion) return -1;
    if (b.code === selectedRegion) return 1;
    return 0;
  });

  // Invalidate file queries when all uploads are done
  useEffect(() => {
    if (totalFiles > 0 && pendingCount === 0 && uploading.length === 0 && doneCount > 0) {
      queryClient.invalidateQueries({ queryKey: ["files"] });
      queryClient.invalidateQueries({ queryKey: ["dashboard"] });
    }
  }, [totalFiles, pendingCount, uploading.length, doneCount]);

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

        {/* Upload Queue */}
        {queue.length > 0 && (
          <div className="rounded-xl border p-4" style={{ borderColor: "var(--color-border)" }}>
            {/* Overall progress header */}
            <div className="mb-3">
              <div className="flex items-center justify-between mb-1.5">
                <div>
                  <h3 className="text-sm font-semibold">
                    {isActive ? "Uploading" : doneCount === totalFiles ? "Complete" : "Upload queue"}
                  </h3>
                  <p className="text-xs text-[var(--color-text-muted)]">
                    {doneCount}/{totalFiles} files · {formatBytes(uploadedBytes)} of {formatBytes(totalBytes)}
                    {errorCount > 0 && <span className="text-[var(--color-danger)]"> · {errorCount} failed</span>}
                  </p>
                </div>
                <div className="flex items-center gap-1">
                  {(isActive || pendingCount > 0) && (
                    <button onClick={togglePause} className="rounded p-1.5 text-[var(--color-text-muted)] hover:bg-[var(--color-bg-tertiary)]" title={paused ? "Resume" : "Pause"}>
                      {paused ? <Play size={14} /> : <Pause size={14} />}
                    </button>
                  )}
                  {(isActive || pendingCount > 0) && (
                    <button onClick={cancelAll} className="rounded p-1.5 text-[var(--color-text-muted)] hover:bg-[var(--color-bg-tertiary)]" title="Cancel all">
                      <X size={14} />
                    </button>
                  )}
                  {errorCount > 0 && (
                    <button onClick={retryAll} className="rounded p-1.5 text-[var(--color-text-muted)] hover:bg-[var(--color-bg-tertiary)]" title="Retry all failed">
                      <RefreshCw size={14} />
                    </button>
                  )}
                  {doneCount > 0 && (
                    <button onClick={clearDone} className="text-xs text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)] px-2">
                      Clear done
                    </button>
                  )}
                </div>
              </div>
              {/* Overall progress bar */}
              {totalFiles > 0 && (
                <div className="flex items-center gap-2">
                  <div className="h-2 flex-1 rounded-full bg-[var(--color-border)]">
                    <div
                      className="h-2 rounded-full transition-all duration-300"
                      style={{ width: `${Math.max(overallPct, 1)}%`, background: errorCount > 0 && !isActive ? "var(--color-danger)" : "var(--color-primary)" }}
                    />
                  </div>
                  <span className="text-xs font-semibold text-[var(--color-text-secondary)] w-10 text-right">{overallPct}%</span>
                </div>
              )}
            </div>

            {/* File list */}
            <div className="space-y-0.5 max-h-80 overflow-auto">
              {queue.map((item) => (
                <div key={item.id} className="group flex items-center gap-3 rounded-lg px-3 py-2 text-sm hover:bg-[var(--color-bg-secondary)]">
                  {/* Status icon */}
                  {item.status === "done" ? (
                    <Check size={16} className="text-[var(--color-primary)] shrink-0" />
                  ) : item.status === "uploading" ? (
                    <Loader2 size={16} className="animate-spin text-[var(--color-primary)] shrink-0" />
                  ) : item.status === "error" ? (
                    <AlertCircle size={16} className="text-[var(--color-danger)] shrink-0" />
                  ) : (
                    <FileIcon name={item.file.name} size={16} className="shrink-0" />
                  )}

                  {/* File info + progress */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between">
                      <span className="truncate text-sm">{item.file.name}</span>
                      <span className="text-xs text-[var(--color-text-muted)] ml-2 shrink-0">
                        {item.status === "uploading"
                          ? `${formatBytes(item.bytesUploaded)} / ${formatBytes(item.file.size)}`
                          : formatBytes(item.file.size)}
                      </span>
                    </div>
                    {/* Per-file progress bar */}
                    {item.status === "uploading" && (
                      <div className="mt-1 h-1 w-full rounded-full bg-[var(--color-border)]">
                        <div
                          className="h-1 rounded-full transition-all duration-200"
                          style={{ width: `${Math.max(item.progress, 1)}%`, background: "var(--color-primary)" }}
                        />
                      </div>
                    )}
                    {item.status === "error" && item.error && (
                      <p className="mt-0.5 text-[11px] text-[var(--color-danger)] truncate">{item.error}</p>
                    )}
                  </div>

                  {/* Actions */}
                  <div className="shrink-0 flex gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                    {item.status === "error" && (
                      <button onClick={() => retryItem(item.id)} className="rounded p-1 text-[var(--color-text-muted)] hover:text-[var(--color-primary)]" title="Retry">
                        <RefreshCw size={13} />
                      </button>
                    )}
                    {(item.status === "pending" || item.status === "uploading" || item.status === "error") && (
                      <button onClick={() => removeItem(item.id)} className="rounded p-1 text-[var(--color-text-muted)] hover:text-[var(--color-danger)]" title="Remove">
                        <X size={13} />
                      </button>
                    )}
                  </div>
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
