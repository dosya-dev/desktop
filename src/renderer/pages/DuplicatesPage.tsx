import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CopyX, Folder, Loader2, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { api, ApiError } from "@/lib/api-client";
import { useWorkspace } from "@/lib/workspace-context";
import { humanSize, timeAgo } from "@/lib/file-type";
import {
  allButNewest, chunk, duplicatesQueryKey, fetchDuplicates,
  fullySelectedGroups, selectedBytes, type DuplicatesResponse,
} from "@/lib/duplicates";

/** Poll while the scanner is still draining this workspace's candidates. */
const SCAN_POLL_MS = 15_000;

export function DuplicatesPage() {
  const { active } = useWorkspace();
  const wsId = active?.id ?? "";
  const navigate = useNavigate();
  const queryClient = useQueryClient();

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
      toast.success("Moved to trash", { description: `${count} file${count === 1 ? "" : "s"} moved to trash.` });
      setSelected(new Set());
    } catch (err) {
      toast.error("Delete failed", {
        description: err instanceof ApiError ? err.message : "The selected files could not be moved to trash.",
      });
    }
    // Refresh both this page and the file listing - a soft delete changes both.
    // On a partial failure the refetch shows what actually happened.
    queryClient.invalidateQueries({ queryKey: duplicatesQueryKey(wsId) });
    queryClient.invalidateQueries({ queryKey: ["files"] });
    setDeleting(false);
  };

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Duplicates</h1>
          <p className="text-sm text-[var(--color-text-muted)]">
            Identical files, by content - not by name
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
              Select all but newest
            </button>
            <button
              data-testid="dup-clear"
              onClick={() => setSelected(new Set())}
              disabled={selected.size === 0}
              className="rounded-lg border px-3 py-2 text-sm disabled:opacity-40"
              style={{ borderColor: "var(--color-border)" }}
            >
              Clear
            </button>
            <button
              data-testid="dup-delete"
              onClick={() => setConfirming(true)}
              disabled={selected.size === 0 || deleting}
              className="flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium text-white disabled:opacity-50"
              style={{ background: "var(--color-danger)" }}
            >
              {deleting ? <Loader2 size={13} className="animate-spin" /> : <Trash2 size={13} />}
              Delete {selected.size > 0 ? selected.size : ""}
            </button>
          </div>
        )}
      </div>

      {data && data.total_groups > 0 && (
        <p data-testid="dup-summary" className="text-sm text-[var(--color-text-muted)]">
          {data.total_groups} duplicate group{data.total_groups === 1 ? "" : "s"}
          {" · "}{humanSize(data.total_wasted_bytes)} reclaimable
          {selected.size > 0 && ` · ${humanSize(bytesSelected)} selected`}
        </p>
      )}

      {pending > 0 && (
        // Without this an incomplete answer is indistinguishable from a complete
        // one, and "no duplicates" would be a lie told confidently.
        <p data-testid="dup-scanning" className="rounded-lg border px-3 py-2 text-xs text-[var(--color-text-muted)]" style={{ borderColor: "var(--color-border)" }}>
          Still scanning {pending} file{pending === 1 ? "" : "s"}. This list will fill in as it goes.
        </p>
      )}

      {query.isLoading ? (
        <div className="space-y-3">
          {[1, 2, 3].map((i) => <div key={i} className="h-24 animate-pulse rounded-xl bg-[var(--color-bg-tertiary)]" />)}
        </div>
      ) : query.isError ? (
        <div className="flex flex-col items-center rounded-xl border py-16" style={{ borderColor: "var(--color-border)" }} data-testid="dup-error">
          <p className="text-sm">Couldn't check for duplicates.</p>
          <button data-testid="dup-retry" onClick={() => query.refetch()} className="mt-2 text-xs font-medium text-[var(--color-primary)]">
            Retry
          </button>
        </div>
      ) : groups.length === 0 ? (
        <div className="flex flex-col items-center justify-center rounded-xl border py-16" style={{ borderColor: "var(--color-border)" }} data-testid="dup-empty">
          <CopyX size={36} className="mb-3 text-[var(--color-text-muted)]" />
          <p className="text-sm font-medium">No duplicates</p>
          <p className="mt-1 text-xs text-[var(--color-text-muted)]">
            Nothing in this workspace is stored twice.
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {groups.map((g) => (
            <div key={g.content_hash} data-testid={`dup-group-${g.content_hash}`} className="rounded-xl border p-4" style={{ borderColor: "var(--color-border)" }}>
              <div className="mb-2 flex items-center justify-between">
                <p className="truncate text-sm font-semibold">{g.files[0]?.name ?? "Unnamed"}</p>
                <span className="text-xs text-[var(--color-text-muted)]">
                  {g.count} copies · {humanSize(g.wasted_bytes)} reclaimable
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
                      className="flex-1 truncate text-left hover:underline"
                    >
                      {f.folder_path ?? "Workspace root"}
                    </button>
                    {i === 0 && (
                      <span data-testid={`dup-newest-${f.id}`} className="rounded-full bg-[var(--color-bg-tertiary)] px-1.5 text-xs">
                        newest
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
            <h3 className="text-lg font-semibold">Move {selected.size} file{selected.size === 1 ? "" : "s"} to trash?</h3>
            <p className="mt-2 text-sm text-[var(--color-text-muted)]">
              This reclaims {humanSize(bytesSelected)}. They go to trash, not straight out.
            </p>
            {fullGroups > 0 && (
              // Allowed, but never silently: this is the one selection that
              // leaves no copy of the file behind.
              <p data-testid="dup-full-group-warning" className="mt-3 rounded-lg border px-3 py-2 text-xs text-[var(--color-danger)]" style={{ borderColor: "var(--color-danger)" }}>
                {fullGroups} group{fullGroups === 1 ? " has" : "s have"} every copy selected. No copy of
                {fullGroups === 1 ? " that file" : " those files"} will be left.
              </p>
            )}
            <div className="mt-5 flex justify-end gap-2">
              <button data-testid="dup-confirm-cancel" onClick={() => setConfirming(false)} className="rounded-lg border px-4 py-2 text-sm" style={{ borderColor: "var(--color-border)" }}>
                Cancel
              </button>
              <button
                data-testid="dup-confirm"
                onClick={runDelete}
                className="rounded-lg px-4 py-2 text-sm font-medium text-white"
                style={{ background: "var(--color-danger)" }}
              >
                Move to trash
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
