import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CopyX, Folder, Loader2, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { autoDir, useAutoDir } from "@/lib/bidi-ui";
import { api, ApiError } from "@/lib/api-client";
import { useWorkspace } from "@/lib/workspace-context";
import { usePermissions } from "@/lib/use-permissions";
import { humanSize, timeAgo } from "@/lib/file-type";
import {
  allButNewest, chunk, duplicatesQueryKey, fetchDuplicates,
  fullySelectedGroups, selectedBytes, type DuplicatesResponse,
} from "@/lib/duplicates";
import { useT } from "@/lib/i18n";

/** Poll while the scanner is still draining this workspace's candidates. */
const SCAN_POLL_MS = 15_000;

export function DuplicatesPage() {
  const ownDir = useAutoDir();
  const t = useT();
  const { active } = useWorkspace();
  const wsId = active?.id ?? "";
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  // batch-delete accepts either permission (delete_own_files is then scoped
  // to the caller's own uploads server-side). Without both, the button only
  // ever produced the 403 toast below.
  const { can } = usePermissions();
  const canDelete = can("delete_any_file") || can("delete_own_files");

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const query = useQuery({
    queryKey: duplicatesQueryKey(wsId),
    queryFn: () => fetchDuplicates(wsId),
    enabled: !!wsId,
    // Keep polling only while the hash scan has candidates left, so a partial
    // answer completes itself instead of looking final.
    refetchInterval: (q) =>
      ((q.state.data as DuplicatesResponse | undefined)?.scanning.pending ?? 0) > 0
        ? SCAN_POLL_MS
        : false,
  });

  const data = query.data;
  const groups = data?.groups ?? [];
  const pending = data?.scanning.pending ?? 0;
  const fullGroups = fullySelectedGroups(groups, selected);
  const bytesSelected = selectedBytes(groups, selected);

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const runDelete = async () => {
    setConfirming(false);
    setDeleting(true);
    const count = selected.size;
    try {
      // batch-delete caps file_ids at 500 per request.
      for (const ids of chunk(Array.from(selected))) {
        await api.post("/api/files/batch-delete", { workspace_id: wsId, file_ids: ids });
      }
      toast.success(t("duplicates.label.movedToTrash"), { description: t("duplicates.description.fileMovedToTrash", { count }) });
      setSelected(new Set());
    } catch (err) {
      toast.error(t("common.error.deleteFailed"), {
        description: err instanceof ApiError ? autoDir(err.message) : t("duplicates.error.theSelectedFilesCouldNotBeMovedToTrash"),
      });
    }
    // Refresh both this page and the file listing - a soft delete changes both.
    // On a partial failure the refetch shows what actually happened.
    queryClient.invalidateQueries({ queryKey: duplicatesQueryKey(wsId) });
    queryClient.invalidateQueries({ queryKey: ["files"] });
    setDeleting(false);
  };

  return (
    <div className="space-y-5" data-testid="duplicates-page">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">{t("duplicates.heading.duplicates")}</h1>
          <p className="text-sm text-[var(--color-text-muted)]">
            {t("duplicates.description.identicalFilesByContentNotByName")}
          </p>
        </div>
        {groups.length > 0 && (
          <div className="flex items-center gap-2">
            <button
              data-testid="dup-select-all-but-newest"
              onClick={() => setSelected(new Set(allButNewest(groups)))}
              className="rounded-lg border px-3 py-2 text-sm"
              style={{ borderColor: "var(--color-border)" }}
            >
              {t("duplicates.action.selectAllButNewest")}
            </button>
            <button
              data-testid="dup-clear"
              onClick={() => setSelected(new Set())}
              disabled={selected.size === 0}
              className="rounded-lg border px-3 py-2 text-sm disabled:opacity-40"
              style={{ borderColor: "var(--color-border)" }}
            >
              {t("common.action.clear")}
            </button>
            {canDelete && (
              <button
                data-testid="dup-delete"
                onClick={() => setConfirming(true)}
                disabled={selected.size === 0 || deleting}
                className="flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium text-white disabled:opacity-50"
                style={{ background: "var(--color-danger)" }}
              >
                {deleting ? <Loader2 size={13} className="animate-spin" /> : <Trash2 size={13} />}
                {selected.size > 0 ? t("duplicates.action.deleteCount", { count: selected.size }) : t("common.delete")}
              </button>
            )}
          </div>
        )}
      </div>

      {data && data.total_groups > 0 && (
        <p data-testid="dup-summary" className="text-sm text-[var(--color-text-muted)]">
          {selected.size > 0
            ? t("duplicates.description.duplicateGroupReclaimableReclaimableSelectedSizeSelected", {
                totalGroups: data.total_groups, reclaimable: humanSize(data.total_wasted_bytes), selectedSize: humanSize(bytesSelected),
              })
            : t("duplicates.description.duplicateGroupReclaimableReclaimable", {
                totalGroups: data.total_groups, reclaimable: humanSize(data.total_wasted_bytes),
              })}
        </p>
      )}

      {pending > 0 && (
        // Without this an incomplete answer is indistinguishable from a complete
        // one, and "no duplicates" would be a lie told confidently.
        <p data-testid="dup-scanning" className="rounded-lg border px-3 py-2 text-xs text-[var(--color-text-muted)]" style={{ borderColor: "var(--color-border)" }}>
          {t("duplicates.description.stillScanningFileThisListWillFillInAs", { pending })}
        </p>
      )}

      {query.isLoading ? (
        <div className="space-y-3">
          {[1, 2, 3].map((i) => <div key={i} className="h-24 animate-pulse rounded-xl bg-[var(--color-bg-tertiary)]" />)}
        </div>
      ) : query.isError ? (
        <div className="flex flex-col items-center rounded-xl border py-16" style={{ borderColor: "var(--color-border)" }} data-testid="dup-error">
          <p className="text-sm">{t("duplicates.error.couldnTCheckForDuplicates")}</p>
          <button data-testid="dup-retry" onClick={() => query.refetch()} className="mt-2 text-xs font-medium text-[var(--color-primary)]">
            {t("common.retry")}
          </button>
        </div>
      ) : groups.length === 0 ? (
        <div className="flex flex-col items-center justify-center rounded-xl border py-16" style={{ borderColor: "var(--color-border)" }} data-testid="dup-empty">
          <CopyX size={36} className="mb-3 text-[var(--color-text-muted)]" />
          <p className="text-sm font-medium">{t("duplicates.empty.noDuplicates")}</p>
          <p className="mt-1 text-xs text-[var(--color-text-muted)]">
            {t("duplicates.description.nothingInThisWorkspaceIsStoredTwice")}
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {groups.map((g) => (
            <div key={g.content_hash} data-testid={`dup-group-${g.content_hash}`} className="rounded-xl border p-4" style={{ borderColor: "var(--color-border)" }}>
              <div className="mb-2 flex items-center justify-between">
                <p dir={g.files[0]?.name != null ? ownDir : undefined} className="truncate text-sm font-semibold">{g.files[0]?.name ?? t("duplicates.label.unnamed")}</p>
                <span className="text-xs text-[var(--color-text-muted)]">
                  {t("duplicates.label.countCopiesReclaimableReclaimable", { count: g.count, reclaimable: humanSize(g.wasted_bytes) })}
                </span>
              </div>
              <div className="space-y-1.5">
                {g.files.map((f, i) => (
                  <label
                    key={f.id}
                    data-testid={`dup-file-${f.id}`}
                    className="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-xs hover:bg-[var(--color-bg-secondary)]"
                  >
                    <input
                      type="checkbox"
                      data-testid={`dup-check-${f.id}`}
                      checked={selected.has(f.id)}
                      onChange={() => toggle(f.id)}
                    />
                    <Folder size={11} className="shrink-0 text-[var(--color-text-muted)]" />
                    <button
                      onClick={(e) => { e.preventDefault(); navigate(`/files?panel=${f.id}`); }}
                      dir={f.folder_path != null ? ownDir : undefined}
                      className="flex-1 truncate text-start hover:underline"
                    >
                      {f.folder_path ?? t("file-requests.label.workspaceRoot")}
                    </button>
                    {i === 0 && (
                      <span data-testid={`dup-newest-${f.id}`} className="rounded-full bg-[var(--color-bg-tertiary)] px-1.5 text-xs">
                        {t("duplicates.label.newest")}
                      </span>
                    )}
                    <span className="text-[var(--color-text-muted)]">{timeAgo(f.created_at)}</span>
                  </label>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      {confirming && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30">
          <div className="w-full max-w-sm rounded-xl bg-[var(--color-bg)] p-6 shadow-xl">
            <h3 className="text-lg font-semibold">{t("duplicates.heading.moveFileToTrash", { count: selected.size })}</h3>
            <p className="mt-2 text-sm text-[var(--color-text-muted)]">
              {t("duplicates.description.thisReclaimsSizeTheyGoToTrashNotStraight", { size: humanSize(bytesSelected) })}
            </p>
            {fullGroups > 0 && (
              // Allowed, but never silently: this is the one selection that
              // leaves no copy of the file behind.
              <p data-testid="dup-full-group-warning" className="mt-3 rounded-lg border px-3 py-2 text-xs text-[var(--color-danger)]" style={{ borderColor: "var(--color-danger)" }}>
                {t("duplicates.description.groupHasEveryCopySelectedNoCopyOfThat", { count: fullGroups })}
              </p>
            )}
            <div className="mt-5 flex justify-end gap-2">
              <button data-testid="dup-confirm-cancel" onClick={() => setConfirming(false)} className="rounded-lg border px-4 py-2 text-sm" style={{ borderColor: "var(--color-border)" }}>
                {t("common.cancel")}
              </button>
              <button
                data-testid="dup-confirm"
                onClick={runDelete}
                className="rounded-lg px-4 py-2 text-sm font-medium text-white"
                style={{ background: "var(--color-danger)" }}
              >
                {t("duplicates.action.moveToTrash")}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
