import { useState, useCallback, useRef, useEffect, type DragEvent, type ChangeEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Upload,
  X,
  Shield,
  Plus,
  ChevronRight,
  Pause,
  Play,
  RefreshCw,
  FilePlus,
  FolderUp,
} from "lucide-react";
import { api, ApiError, apiRequest } from "@/lib/api-client";
import { uploadFileInParts } from "@/lib/upload-in-parts";
import { uploadTransport } from "@/lib/upload-transport";
import { LIBRARY_QUERY_ROOT } from "@/lib/library-request";
import { useWorkspace } from "@/lib/workspace-context";
import { formatBytes } from "@/lib/format";
import { toast } from "sonner";
import { autoDir } from "@/lib/bidi-ui";
import { FolderIcon } from "@/components/files/FileIcon";
import { CountsLine, UploadQueueTree, type UploadQueueItem as QueueItem } from "@/components/upload/UploadQueueTree";
import {
  readDroppedEntries, entriesFromPickedFiles, orderedDirs, createFolderTree, resolveTargets,
  MAX_DROPPED_FILES, type DroppedTree, type FolderPlan,
} from "@/lib/dropped-entries";
import { intlLocale } from "@/lib/locale-state";
import { useT, t as translate } from "@/lib/i18n";
import { richText } from "@/lib/rich-text";
import type { MessageKey } from "../../i18n/keys";

// ── Types ────────────────────────────────────────────────────────────

interface PickerFolder {
  id: string;
  name: string;
  parent_id: string | null;
  file_count: number;
}

// ── Concurrent upload limit ──────────────────────────────────────────

const MAX_CONCURRENT = 3;

/** The format chips under the drop zone. */
const FORMAT_CHIPS: MessageKey[] = [
  "common.label.videoTitleCase", "common.label.images", "common.label.documents", "upload.label.archives", "upload.label.anyFormat",
];

// ── Page ─────────────────────────────────────────────────────────────

export function UploadPage() {
  const t = useT();
  const { active } = useWorkspace();
  const queryClient = useQueryClient();
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [paused, setPaused] = useState(false);
  const [selectedFolder, setSelectedFolder] = useState<{
    id: string | null;
    name: string;
  }>({ id: null, name: "" });
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

  // Fetch folder tree
  const { data: foldersData } = useQuery({
    queryKey: ["folders-tree", active?.id],
    queryFn: () =>
      api.get<{ ok: boolean; folders: PickerFolder[] }>(
        `/api/folders/tree?workspace_id=${active?.id}`,
      ),
    enabled: !!active,
  });

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
      toast.success(t("common.label.folderCreated"));
    },
    onError: (e) => toast.error(e instanceof ApiError ? autoDir(e.message) : t("common.error.failed")),
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
      // Small files go up as one PUT; anything over 50 MB goes through the
      // resumable part API - the edge refuses any single body over 100 MB.
      await uploadFileInParts(
        {
          file: item.file,
          fileName: item.file.name,
          mimeType: item.file.type,
          workspaceId: item.workspaceId,
          folderId: item.folderId,
          lastModifiedMs: item.file.lastModified,
          signal: controller.signal,
          onProgress: (bytes) => {
            const pct = item.file.size > 0 ? Math.round((bytes / item.file.size) * 100) : 100;
            updateItem(item.id, { progress: Math.min(100, pct), bytesUploaded: bytes });
          },
        },
        uploadTransport,
      );

      updateItem(item.id, { status: "done", progress: 100, bytesUploaded: item.file.size });
    } catch (err: unknown) {
      if (controller.signal.aborted) {
        updateItem(item.id, { status: "pending", progress: 0, bytesUploaded: 0 });
      } else {
        // Module-level translate: this runs from a scheduler closure that may
        // predate the last language switch.
        const message = err instanceof Error ? err.message : translate("common.error.uploadFailed");
        updateItem(item.id, { status: "error", error: message, errorRaw: err instanceof ApiError });
      }
    } finally {
      abortControllers.current.delete(item.id);
    }
  };

  // ── Concurrent upload processor ──────────────────────────────────

  // Live count of uploads actually in flight, plus the ids already claimed by
  // this scheduler. Both are refs so the scheduler reads them synchronously:
  // `queueRef.current` only reflects the last render, so relying on its
  // "uploading" count (or re-`find`ing the same "pending" item) before setQueue
  // flushes could start one file twice or exceed MAX_CONCURRENT.
  const inFlightCount = useRef(0);
  const claimedIds = useRef(new Set<string>());

  const processQueue = useCallback(() => {
    if (pausedRef.current) return;

    while (inFlightCount.current < MAX_CONCURRENT) {
      if (pausedRef.current) break;

      const next = queueRef.current.find(
        (q) => q.status === "pending" && !claimedIds.current.has(q.id),
      );
      if (!next) break;

      // Claim + count synchronously so a concurrent pass (e.g. the one kicked
      // off from another upload's completion) can't grab the same item or blow
      // past the concurrency cap before React re-renders.
      claimedIds.current.add(next.id);
      inFlightCount.current++;

      uploadFile(next).finally(() => {
        inFlightCount.current--;
        claimedIds.current.delete(next.id);
        // A slot freed up - try to start the next pending file. No shared
        // "processing" guard is cleared here, so this can't race the loop above.
        processQueue();
      });
    }
  }, [active, selectedFolder]);

  // Abort any in-flight uploads when leaving the page so their XHRs don't
  // outlive the component (orphaned requests / setState-after-unmount).
  useEffect(() => {
    const controllers = abortControllers.current;
    return () => {
      for (const [, ctrl] of controllers) ctrl.abort();
      controllers.clear();
    };
  }, []);

  // Switching workspace mid-queue: cancel everything. Continuing would keep a
  // progress panel on screen for a workspace the user has left, and pending
  // items pointing at the old workspace would quietly upload "somewhere else".
  const prevWsIdRef = useRef<string | null>(null);
  useEffect(() => {
    const wsId = active?.id ?? null;
    const prev = prevWsIdRef.current;
    prevWsIdRef.current = wsId;
    if (!prev || !wsId || prev === wsId) return; // initial load or no real switch
    if (queueRef.current.length === 0) return;
    for (const [, ctrl] of abortControllers.current) ctrl.abort();
    abortControllers.current.clear();
    // Each aborted controller's uploadFile() eventually settles and its
    // processQueue().finally() re-entry reads queueRef.current to claim the
    // next "pending" sibling. queueRef.current is normally kept in sync only
    // by the render-time `queueRef.current = queue` assignment above, which
    // depends on React flushing the setQueue([]) update before that re-entry
    // runs. That ordering currently holds (React 18 flushes a passive
    // effect's own setState synchronously before the callstack returns to
    // the microtask queue, so it wins against the abort's continuation) but
    // it is an implementation detail of the framework/engine, not a
    // contract this scheduler should depend on. Clearing the ref here,
    // synchronously and unconditionally, makes the invariant hold by
    // construction instead of by scheduling luck.
    queueRef.current = [];
    setQueue([]);
    toast.info(t("upload.label.uploadsCanceled"), {
      description: t("upload.description.theUploadQueueWasClearedBecauseYouSwitchedWorkspace"),
    });
  }, [active?.id]);

  // ── Adding files ──────────────────────────────────────────────────

  const [dragging, setDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);
  const activeIdRef = useRef(active?.id);
  activeIdRef.current = active?.id;
  const aliveRef = useRef(true);
  useEffect(() => {
    aliveRef.current = true;
    return () => { aliveRef.current = false; };
  }, []);

  // Turns the second hidden input into a folder picker. Set as an attribute
  // because React's input types have no webkitdirectory prop.
  useEffect(() => {
    const el = folderInputRef.current;
    if (!el) return;
    el.setAttribute("webkitdirectory", "");
    el.setAttribute("directory", "");
  }, []);

  /** Find-or-create one folder; the server reuses an existing row by name. */
  const createFolder = useCallback(async (workspaceId: string, name: string, parentId: string | null) => {
    const res = await api.post<{ ok: boolean; folder?: { id: string }; error?: string }>("/api/folders", {
      workspace_id: workspaceId, parent_id: parentId, name,
    });
    if (!res.ok || !res.folder?.id) throw new Error(res.error ?? t("common.error.couldNotCreateFolder"));
    return res.folder.id;
  }, [t]);

  /**
   * Queue a dropped or picked tree. Every file used to go into the selected
   * folder, so a dropped folder arrived flat; now its folders are recreated
   * under the selection first and each file is queued into its own.
   */
  const enqueueTree = useCallback(async (tree: DroppedTree) => {
    if (!active) return;
    const workspaceId = active.id;
    const root = selectedFolder.id;
    if (tree.entries.length === 0 && tree.dirs.length === 0) return;

    let plan: FolderPlan = { ids: new Map(), failed: [] };
    if (tree.hadDirectory) {
      const dirs = orderedDirs(tree);
      // Recreating a deep tree is a round trip per folder - say so up front,
      // or the upload looks dead until the queue appears.
      toast.info(t("common.label.uploadingFolder"), {
        description: t("common.description.recreatingFolderThenUploadingFile", { dirCount: dirs.length, entryCount: tree.entries.length }),
      });
      plan = await createFolderTree(dirs, root, (name, parentId) => createFolder(workspaceId, name, parentId));
      if (!aliveRef.current) return;
      if (plan.failed.length > 0) {
        toast.error(t("common.error.someFoldersCouldNotBeCreated"), {
          description: t("common.error.folderFailedError", { failedCount: plan.failed.length, error: plan.error ?? "" }).trim(),
        });
      }
      if (plan.ids.size > 0) {
        queryClient.invalidateQueries({ queryKey: ["folders-tree"] });
        queryClient.invalidateQueries({ queryKey: ["files"] });
      }
    }
    // The workspace changed while folders were being made: these files belong
    // to the one the user left, and the switch already cleared its queue.
    if (activeIdRef.current !== workspaceId) return;

    const { targets, skipped } = resolveTargets(tree.entries, plan, root);
    if (skipped > 0) {
      toast.error(t("common.label.someFilesWereSkipped"), {
        description: t("common.description.fileHadNoFolderToGoIn", { skipped }),
      });
    }
    if (tree.skipped > 0) {
      toast.error(t("common.error.tooManyFilesInOneGo"), {
        description: t("upload.description.onlyTheFirstMaxDroppedFilesFilesWereQueuedSkippedLeft", {
          maxDroppedFiles: MAX_DROPPED_FILES.toLocaleString(intlLocale()), skipped: String(tree.skipped),
        }),
      });
    }
    if (targets.length === 0) {
      if (tree.hadDirectory && plan.ids.size > 0) {
        toast.success(t("common.label.folderCreated"), { description: t("common.description.thereWereNoFilesInsideToUpload") });
      }
      return;
    }

    const items: QueueItem[] = targets.map((target) => ({
      file: target.file,
      id: crypto.randomUUID(),
      status: "pending" as const,
      progress: 0,
      bytesUploaded: 0,
      workspaceId,
      folderId: target.folderId,
      relativePath: target.path,
    }));
    setQueue((prev) => [...prev, ...items]);
    // Start processing after state update
    setTimeout(() => processQueue(), 50);
  }, [processQueue, active, selectedFolder.id, createFolder, queryClient, t]);

  const onDragOver = (e: DragEvent) => { e.preventDefault(); setDragging(true); };
  const onDragLeave = (e: DragEvent) => {
    // Leaving for a child element is not leaving the zone.
    if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false);
  };
  // Not `async`, and it must stay that way: readDroppedEntries reads
  // dataTransfer.items - the only API that can see inside a dropped folder -
  // before its own first await, and that list is dead once this returns.
  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragging(false);
    void readDroppedEntries(e.dataTransfer).then(enqueueTree);
  };
  // Files from the folder picker carry webkitRelativePath, so the same tree is
  // rebuilt as for a drop.
  const onPicked = (e: ChangeEvent<HTMLInputElement>) => {
    if (e.target.files?.length) void enqueueTree(entriesFromPickedFiles(e.target.files));
    e.target.value = "";
  };

  // ── Queue actions ─────────────────────────────────────────────────

  const clearDone = () => setQueue((prev) => prev.filter((q) => q.status !== "done"));

  const removeItems = (ids: string[]) => {
    for (const id of ids) abortControllers.current.get(id)?.abort();
    const gone = new Set(ids);
    setQueue((prev) => prev.filter((q) => !gone.has(q.id)));
  };

  const retryItems = (ids: string[]) => {
    const again = new Set(ids);
    setQueue((prev) =>
      prev.map((q) =>
        again.has(q.id) && q.status === "error"
          ? { ...q, status: "pending" as const, progress: 0, bytesUploaded: 0, error: undefined }
          : q,
      ),
    );
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
  const counts = { doneCount, totalFiles, uploadedBytes: formatBytes(uploadedBytes), totalBytes: formatBytes(totalBytes) };

  const folders = foldersData?.folders ?? [];

  // Invalidate file queries when all uploads are done
  useEffect(() => {
    if (totalFiles > 0 && pendingCount === 0 && uploading.length === 0 && doneCount > 0) {
      queryClient.invalidateQueries({ queryKey: ["files"] });
      // An uploaded file belongs to the workspace-wide library view too (photos,
      // videos, documents), and that view is not a folder listing - ["files"] does
      // not partial-match it, so without this the grid stayed stale until its own
      // staleTime expired.
      queryClient.invalidateQueries({ queryKey: [LIBRARY_QUERY_ROOT] });
      queryClient.invalidateQueries({ queryKey: ["dashboard"] });
    }
  }, [totalFiles, pendingCount, uploading.length, doneCount]);

  return (
    <div className="flex h-full gap-6" data-testid="upload-page">
      {/* Left Column. `min-w-0` is load-bearing: a flex item's automatic
          minimum width is its min-content width, which for a long file name
          in the queue is the whole name on one line. Without it the column
          grew past the window and the content area scrolled sideways. */}
      <div className="min-w-0 flex-1 space-y-4">
        <div>
          <h1 className="text-2xl font-semibold">{t("upload.heading.uploadFiles")}</h1>
          <p className="break-words text-sm text-[var(--color-text-muted)]">
            {selectedFolder.id
              ? richText(t, "upload.description.uploadingToSelectedFolderNameEncryptedInTransit", {}, {
                  selectedFolderName: <strong className="text-[var(--color-text)]">{selectedFolder.name}</strong>,
                })
              : t("upload.description.filesAreEncryptedInTransitTLS13They")}
          </p>
        </div>

        {/* Drop Zone. The pickers sit OUTSIDE it: a hidden input's click
            bubbles, and inside the zone it would also fire the zone's own
            file picker - which is how "pick a folder" broke on the web. */}
        <input ref={fileInputRef} type="file" multiple hidden onChange={onPicked} data-testid="upload-files-input" />
        <input ref={folderInputRef} type="file" multiple hidden onChange={onPicked} data-testid="upload-folder-input" />
        <div
          onClick={() => fileInputRef.current?.click()}
          onDragOver={onDragOver}
          onDragLeave={onDragLeave}
          onDrop={onDrop}
          className={`flex cursor-pointer flex-col items-center justify-center rounded-xl border-2 border-dashed p-12 transition-colors ${
            dragging
              ? "border-[var(--color-primary)] bg-[var(--color-primary)]/5"
              : "border-[var(--color-border)] hover:border-[var(--color-primary)]/50"
          }`}
        >
          <Upload
            size={40}
            className={`mb-4 ${dragging ? "text-[var(--color-primary)]" : "text-[var(--color-text-muted)]"}`}
          />
          <p className="text-sm font-medium">
            {dragging ? t("upload.label.dropFilesOrFoldersHere") : t("upload.label.dropFilesOrFoldersHereToUpload")}
          </p>
          <p className="mt-1 text-xs text-[var(--color-text-muted)]">
            {t("upload.description.foldersKeepTheirSubfoldersOrBrowseYourComputer")}
          </p>
          <div className="mt-3 flex gap-2">
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); fileInputRef.current?.click(); }}
              className="flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors hover:bg-[var(--color-bg-secondary)]"
              style={{ borderColor: "var(--color-border)" }}
            >
              <FilePlus size={13} />
              {t("upload.action.selectFiles")}
            </button>
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); folderInputRef.current?.click(); }}
              className="flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors hover:bg-[var(--color-bg-secondary)]"
              style={{ borderColor: "var(--color-border)" }}
            >
              <FolderUp size={13} />
              {t("upload.action.selectFolder")}
            </button>
          </div>
          <div className="mt-3 flex gap-2">
            {FORMAT_CHIPS.map((key) => (
              <span key={key} className="rounded-full bg-[var(--color-bg-tertiary)] px-2.5 py-0.5 text-[10px] font-medium text-[var(--color-text-secondary)]">
                {t(key)}
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
                    {isActive ? t("upload.heading.uploading") : doneCount === totalFiles ? t("upload.heading.complete") : t("upload.heading.uploadQueue")}
                  </h3>
                  <p className="text-xs text-[var(--color-text-muted)]">
                    <CountsLine
                      base={t("upload.description.donecountTotalFilesFilesUploadedBytesOfTotalBytes", counts)}
                      withFailed={errorCount > 0
                        ? t("upload.error.donecountTotalFilesFilesUploadedBytesOfTotalBytesErrorCountFailed", { ...counts, errorCount })
                        : null}
                    />
                  </p>
                </div>
                <div className="flex items-center gap-1">
                  {(isActive || pendingCount > 0) && (
                    <button onClick={togglePause} className="rounded p-1.5 text-[var(--color-text-muted)] hover:bg-[var(--color-bg-tertiary)]" title={paused ? t("common.tooltip.resume") : t("common.accessibility.pause")}>
                      {paused ? <Play size={14} /> : <Pause size={14} />}
                    </button>
                  )}
                  {(isActive || pendingCount > 0) && (
                    <button onClick={cancelAll} className="rounded p-1.5 text-[var(--color-text-muted)] hover:bg-[var(--color-bg-tertiary)]" title={t("upload.tooltip.cancelAll")}>
                      <X size={14} />
                    </button>
                  )}
                  {errorCount > 0 && (
                    <button onClick={retryAll} className="rounded p-1.5 text-[var(--color-text-muted)] hover:bg-[var(--color-bg-tertiary)]" title={t("upload.tooltip.retryAllFailed")}>
                      <RefreshCw size={14} />
                    </button>
                  )}
                  {doneCount > 0 && (
                    <button onClick={clearDone} className="text-xs text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)] px-2">
                      {t("upload.action.clearDone")}
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
                  <span className="text-xs font-semibold text-[var(--color-text-secondary)] w-10 text-end">{overallPct}%</span>
                </div>
              )}
            </div>

            {/* File list, grouped under the folders it came from */}
            <UploadQueueTree queue={queue} onRetry={retryItems} onRemove={removeItems} />
          </div>
        )}
      </div>

      {/* Right Column: Options */}
      <div className="w-72 shrink-0 space-y-4">
        <div className="rounded-xl border p-4" style={{ borderColor: "var(--color-border)" }}>
          <p className="mb-3 text-xs font-semibold text-[var(--color-text-secondary)]">{t("upload.label.uploadOptions")}</p>

          {/* Folder - the only upload option left. Where the bytes land is a
              property of the workspace, chosen once when it was created. */}
          <div>
            <p className="mb-1.5 flex items-center gap-1 text-xs font-medium text-[var(--color-text-secondary)]">
              <FolderIcon fileCount={1} size={13} />
              {t("common.label.folder")}
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
              <span className={`flex-1 truncate text-start ${!selectedFolder.id ? "text-[var(--color-text-muted)]" : ""}`}>
                {selectedFolder.id ? selectedFolder.name : t("common.label.rootTopLevel")}
              </span>
              <ChevronRight size={12} className="text-[var(--color-text-muted)] rtl:-scale-x-100" />
            </button>
            <button
              onClick={() => setShowCreateFolder(true)}
              className="mt-1.5 flex items-center gap-1.5 text-xs text-[var(--color-text-secondary)] hover:text-[var(--color-text)]"
            >
              <Plus size={11} />
              {t("upload.action.createNewFolder")}
            </button>
          </div>
        </div>

        {/* Info */}
        <div className="rounded-xl bg-[var(--color-bg-secondary)] p-4 text-xs text-[var(--color-text-secondary)]">
          <div className="flex items-center gap-2 mb-2">
            <Shield size={14} />
            <span className="font-medium">{t("upload.label.secureUpload")}</span>
          </div>
          <p>{t("upload.description.encryptedInTransitWithTLS13")}</p>
          <p className="mt-1">{t("upload.label.noEgressFeesEver")}</p>
        </div>
      </div>

      {/* Folder Picker Modal */}
      {showFolderPicker && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30">
          <div className="w-full max-w-sm rounded-xl bg-[var(--color-bg)] shadow-xl" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between border-b px-5 py-4" style={{ borderColor: "var(--color-border)" }}>
              <h3 className="text-base font-semibold">{t("upload.heading.selectFolder")}</h3>
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
                {t("common.label.rootTopLevel")}
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
                {t("common.cancel")}
              </button>
              <button
                onClick={() => {
                  const f = folders.find((f) => f.id === pickerSelected);
                  setSelectedFolder(
                    f ? { id: f.id, name: f.name } : { id: null, name: "" },
                  );
                  setShowFolderPicker(false);
                }}
                className="rounded-lg px-4 py-2 text-sm font-medium text-[var(--color-primary-fg)]"
                style={{ background: "var(--color-primary)" }}
              >
                {t("upload.action.selectFolder")}
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
            <h3 className="mb-4 text-lg font-semibold">{t("upload.heading.newFolder")}</h3>
            <input
              type="text"
              value={newFolderName}
              onChange={(e) => setNewFolderName(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && newFolderName.trim() && createFolderMut.mutate(newFolderName.trim())}
              placeholder={t("common.placeholder.folderName")}
              autoFocus
              className="mb-4 w-full rounded-lg border px-3 py-2 text-sm outline-none focus:border-[var(--color-primary)]"
              style={{ borderColor: "var(--color-border)" }}
            />
            <div className="flex justify-end gap-2">
              <button onClick={() => { setShowCreateFolder(false); setNewFolderName(""); }} className="rounded-lg border px-4 py-2 text-sm" style={{ borderColor: "var(--color-border)" }}>
                {t("common.cancel")}
              </button>
              <button
                onClick={() => newFolderName.trim() && createFolderMut.mutate(newFolderName.trim())}
                disabled={!newFolderName.trim() || createFolderMut.isPending}
                className="rounded-lg px-4 py-2 text-sm font-medium text-[var(--color-primary-fg)] disabled:opacity-50"
                style={{ background: "var(--color-primary)" }}
              >
                {createFolderMut.isPending ? t("common.status.creating") : t("common.action.create")}
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
        style={{ paddingInlineStart: `${12 + depth * 20}px` }}
      >
        <FolderIcon fileCount={folder.file_count} size={14} />
        <span className="truncate" title={folder.name}>{folder.name}</span>
      </button>
      {children.map((c) => (
        <PickerTreeItem key={c.id} folder={c} all={all} selectedId={selectedId} onSelect={onSelect} depth={depth + 1} />
      ))}
    </>
  );
}
