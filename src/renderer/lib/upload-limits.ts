/**
 * The workspace's upload rules, fetched once and memoised briefly.
 *
 * Port of apps/web/src/lib/upload-limits.ts's transport half. The RULES are not
 * ported - checkUploadFile, checkBatchFitsQuota and summariseRejections all come
 * from @dosya-dev/shared, which desktop can import directly. Only the fetching
 * and caching differ between the two, and only because the api clients do.
 */
import { api } from "@/lib/api-client";
import type { UploadLimits } from "@dosya-dev/shared";

/**
 * Matches the server's own KV TTL for these figures. A shorter one here would
 * buy staleness we cannot act on; a longer one would outlive the source.
 */
const TTL_MS = 60_000;
const memo = new Map<string, { at: number; value: UploadLimits }>();
const inflight = new Map<string, Promise<UploadLimits>>();

export function clearUploadLimitsCache(): void {
  memo.clear();
  inflight.clear();
}

export async function fetchUploadLimits(workspaceId: string): Promise<UploadLimits> {
  const hit = memo.get(workspaceId);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value;

  const existing = inflight.get(workspaceId);
  if (existing) return existing;

  const req = api
    .get<UploadLimits & { ok: boolean }>(`/api/workspaces/${workspaceId}/upload-limits`)
    .then((res) => {
      const value: UploadLimits = {
        allowed_extensions: res.allowed_extensions ?? null,
        blocked_extensions: res.blocked_extensions ?? null,
        max_file_size_gb: res.max_file_size_gb ?? null,
        storage_remaining_bytes: res.storage_remaining_bytes ?? null,
      };
      memo.set(workspaceId, { at: Date.now(), value });
      return value;
    })
    // Fail OPEN. This check exists only to move a refusal earlier, so an
    // unreachable endpoint must restore the old behaviour - upload and let the
    // server decide - rather than block an upload that would have succeeded.
    .catch((): UploadLimits => ({}))
    .finally(() => { inflight.delete(workspaceId); });

  inflight.set(workspaceId, req);
  return req;
}
