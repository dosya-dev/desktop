import { useEffect, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { toast } from "sonner";
import { ipcErrorText, useAutoDir } from "@/lib/bidi-ui";
import type { SyncConflict } from "@/lib/sync-store";
import { formatBytes, formatRelative } from "@/lib/format";
import { formatters, useT } from "@/lib/i18n";
import { richText } from "@/lib/rich-text";
import type { MessageKey } from "../../../i18n/keys";

/** Cards per page. A folder can pile up thousands of conflicts, and one card
 *  per conflict all at once froze the window and cost gigabytes of RAM. */
export const CONFLICTS_PER_PAGE = 50;

type Resolution = "keep-local" | "keep-remote" | "keep-both";

const BULK_LABELS: Record<Resolution, { button: MessageKey; confirm: MessageKey }> = {
  "keep-local": { button: "sync.label.keepAllLocal", confirm: "sync.label.uploadThisDeviceSVersionOfEveryFileOver" },
  "keep-remote": { button: "sync.label.keepAllRemote", confirm: "sync.label.moveThisDeviceSVersionsToTheTrashAnd" },
  "keep-both": { button: "sync.label.keepBothForAll", confirm: "sync.label.renameThisDeviceSVersionsToConflictCopiesAnd" },
};

/**
 * The Issues tab's conflict cards, one page at a time. The engine holds the
 * list; status ticks carry only the count (`total`), and this asks for the
 * page it shows. A change in `total` (a card resolved here, a bulk run
 * draining, a new conflict) re-reads the current page.
 */
export function ConflictList({ pairIds, total }: { pairIds: string[]; total: number }) {
  const t = useT();
  const [page, setPage] = useState(1);
  const [items, setItems] = useState<SyncConflict[]>([]);
  const [confirming, setConfirming] = useState<Resolution | null>(null);
  const [bulkBusy, setBulkBusy] = useState(false);
  const totalPages = Math.max(1, Math.ceil(total / CONFLICTS_PER_PAGE));
  // Resolving the last card on the last page shrinks the list under us; stay
  // on the nearest page that still has cards rather than showing an empty one.
  const current = Math.min(page, totalPages);
  const start = (current - 1) * CONFLICTS_PER_PAGE;
  const pairKey = pairIds.join(",");

  useEffect(() => {
    if (total === 0) {
      setItems([]);
      return;
    }
    let cancelled = false;
    window.electronAPI
      .listSyncConflicts({ pairIds, offset: start, limit: CONFLICTS_PER_PAGE })
      .then((res: { conflicts: SyncConflict[] }) => { if (!cancelled) setItems(res.conflicts); })
      .catch(() => { /* keep the last page on screen; the next tick retries */ });
    return () => { cancelled = true; };
    // pairKey stands in for pairIds, whose identity changes every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pairKey, start, total]);

  const resolveAll = async (resolution: Resolution) => {
    setBulkBusy(true);
    try {
      const { queued } = await window.electronAPI.resolveSyncConflicts(pairIds, resolution);
      toast.success(queued > 0 ? t("sync.label.resolvingQueuedConflictsInTheBackground", { queued }) : t("sync.label.alreadyResolvingGiveItAMoment"));
    } catch (e: any) {
      toast.error(ipcErrorText(e?.message, t("sync.error.couldNotStartResolvingTryAgain")));
    } finally {
      setBulkBusy(false);
      setConfirming(null);
    }
  };

  if (total === 0) return null;

  return (
    <>
      {total > 1 && (
        <div className="rounded-xl border p-3" style={{ borderColor: "var(--color-border)" }}>
          {confirming ? (
            <div className="flex flex-wrap items-center gap-2">
              <p className="min-w-0 flex-1 text-xs">
                <span className="font-medium">{t(BULK_LABELS[confirming].button)} ({formatters().formatNumber(total)})?</span>{" "}
                <span className="text-[var(--color-text-muted)]">{t(BULK_LABELS[confirming].confirm)}</span>
              </p>
              <button
                onClick={() => setConfirming(null)}
                disabled={bulkBusy}
                className="rounded-lg border px-3 py-1.5 text-xs font-medium hover:bg-[var(--color-bg-secondary)]"
                style={{ borderColor: "var(--color-border)" }}
              >
                {t("common.cancel")}
              </button>
              <button
                onClick={() => void resolveAll(confirming)}
                disabled={bulkBusy}
                className="rounded-lg border border-[var(--color-text)] bg-[var(--color-text)] px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50"
              >
                {t("sync.action.resolveAll")}
              </button>
            </div>
          ) : (
            <div className="flex flex-wrap items-center gap-2">
              <p className="min-w-0 flex-1 text-xs text-[var(--color-text-muted)]">
                {t("sync.description.resolveAllTotalConflictsTheSameWay", { total })}
              </p>
              {(Object.keys(BULK_LABELS) as Resolution[]).map((r) => (
                <button
                  key={r}
                  onClick={() => setConfirming(r)}
                  className="rounded-lg border px-3 py-1.5 text-xs font-medium hover:bg-[var(--color-bg-secondary)]"
                  style={{ borderColor: "var(--color-border)" }}
                >
                  {t(BULK_LABELS[r].button)}
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {items.map((c) => (
        <ConflictCard key={c.id} conflict={c} />
      ))}

      {totalPages > 1 && (
        <div className="flex items-center justify-between pt-1">
          <p className="text-xs text-[var(--color-text-muted)]">
            {richText(t, "sync.description.startToEndOfTotalConflicts", {}, {
              start: <span className="font-medium text-[var(--color-text)]">{start + 1}</span>,
              end: <span className="font-medium text-[var(--color-text)]">{Math.min(start + CONFLICTS_PER_PAGE, total)}</span>,
              total: <span className="font-medium text-[var(--color-text)]">{formatters().formatNumber(total)}</span>,
            })}
          </p>
          <div className="flex items-center gap-1">
            <button
              onClick={() => setPage(Math.max(1, current - 1))}
              disabled={current <= 1}
              aria-label={t("common.tooltip.previousPage")}
              className="flex h-8 w-8 items-center justify-center rounded-lg border text-sm disabled:opacity-30"
              style={{ borderColor: "var(--color-border)" }}
            >
              <ChevronLeft size={14} className="rtl:-scale-x-100" />
            </button>
            {buildPageNumbers(current, totalPages).map((p, i) =>
              p === "..." ? (
                <span key={`dots-${i}`} className="px-1 text-xs text-[var(--color-text-muted)]">
                  ...
                </span>
              ) : (
                <button
                  key={p}
                  onClick={() => setPage(p)}
                  aria-current={current === p ? "page" : undefined}
                  className={`flex h-8 min-w-8 items-center justify-center rounded-lg border px-2 text-xs font-medium ${
                    current === p
                      ? "border-[var(--color-text)] bg-[var(--color-text)] text-white"
                      : "hover:bg-[var(--color-bg-secondary)]"
                  }`}
                  style={{ borderColor: current === p ? "var(--color-text)" : "var(--color-border)" }}
                >
                  {p}
                </button>
              ),
            )}
            <button
              onClick={() => setPage(Math.min(totalPages, current + 1))}
              disabled={current >= totalPages}
              aria-label={t("common.tooltip.nextPage")}
              className="flex h-8 w-8 items-center justify-center rounded-lg border text-sm disabled:opacity-30"
              style={{ borderColor: "var(--color-border)" }}
            >
              <ChevronRight size={14} className="rtl:-scale-x-100" />
            </button>
          </div>
        </div>
      )}
    </>
  );
}

function buildPageNumbers(current: number, total: number): (number | "...")[] {
  if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1);
  const pages: (number | "...")[] = [1];
  if (current > 3) pages.push("...");
  for (let i = Math.max(2, current - 1); i <= Math.min(total - 1, current + 1); i++) pages.push(i);
  if (current < total - 2) pages.push("...");
  pages.push(total);
  return pages;
}

function ConflictCard({ conflict }: { conflict: SyncConflict }) {
  const ownDir = useAutoDir();
  const t = useT();
  // No refresh needed afterwards: the resolution changes the count on the
  // next status tick, and that re-reads this page.
  const resolve = async (resolution: string) => {
    try {
      await window.electronAPI.resolveConflict(conflict.id, resolution);
      toast.success(t("sync.label.conflictResolved"));
    } catch (error: any) {
      toast.error(ipcErrorText(error?.message, t("sync.error.couldNotResolveThisConflictFixTheCauseAnd")));
    }
  };

  return (
    <div className="rounded-xl border p-4" style={{ borderColor: "var(--color-border)" }}>
      <p dir={ownDir} className="text-sm font-semibold">{conflict.remoteName}</p>
      <p dir="ltr" className="ltr-value mt-1 text-xs text-[var(--color-text-muted)] font-mono">{conflict.localPath}</p>
      <div className="mt-3 grid grid-cols-2 gap-3 text-xs">
        <div className="rounded-lg bg-[var(--color-bg-secondary)] p-2.5">
          <p className="font-medium">{t("sync.label.local")}</p>
          <p className="text-[var(--color-text-muted)]">{formatBytes(conflict.localSizeBytes)}</p>
          <p className="text-[var(--color-text-muted)]">{formatRelative(conflict.localMtimeMs)}</p>
        </div>
        <div className="rounded-lg bg-[var(--color-bg-secondary)] p-2.5">
          <p className="font-medium">{t("sync.label.remote")}</p>
          <p className="text-[var(--color-text-muted)]">{formatBytes(conflict.remoteSizeBytes)}</p>
          <p className="text-[var(--color-text-muted)]">{formatRelative(conflict.remoteUpdatedAt)}</p>
        </div>
      </div>
      <div className="mt-3 flex gap-2">
        <button onClick={() => resolve("keep-local")} className="flex-1 rounded-lg border px-3 py-1.5 text-xs font-medium hover:bg-[var(--color-bg-secondary)]" style={{ borderColor: "var(--color-border)" }}>
          {t("sync.action.keepLocal")}
        </button>
        <button onClick={() => resolve("keep-remote")} className="flex-1 rounded-lg border px-3 py-1.5 text-xs font-medium hover:bg-[var(--color-bg-secondary)]" style={{ borderColor: "var(--color-border)" }}>
          {t("sync.action.keepRemote")}
        </button>
        <button onClick={() => resolve("keep-both")} className="flex-1 rounded-lg border px-3 py-1.5 text-xs font-medium hover:bg-[var(--color-bg-secondary)]" style={{ borderColor: "var(--color-border)" }}>
          {t("sync.action.keepBoth")}
        </button>
      </div>
    </div>
  );
}
