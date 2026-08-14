import { api } from "@/lib/api-client";

/**
 * Ported from apps/web/src/lib/duplicates.ts - keep the two in step.
 *
 * The semantics deliberately match web exactly, including that selecting EVERY
 * copy in a group is allowed and merely called out in the confirm dialog. Making
 * desktop stricter than web would give the same product two rules and surprise
 * anyone who moves between them.
 */
export interface DuplicateFile {
  id: string;
  name: string;
  folder_id: string | null;
  folder_path: string | null;
  created_at: number;
  uploaded_by: string;
  uploader_name: string | null;
  mime_type: string;
  extension: string | null;
}

export interface DuplicateGroup {
  content_hash: string;
  size_bytes: number;
  count: number;
  /** (count - 1) * size_bytes - what deleting all but one copy reclaims. */
  wasted_bytes: number;
  /** Newest-first: the server sorts created_at DESC (lib/duplicates/group.ts). */
  files: DuplicateFile[];
}

export interface DuplicatesResponse {
  ok: boolean;
  groups: DuplicateGroup[];
  total_groups: number;
  total_wasted_bytes: number;
  scanning: { pending: number };
}

export const DUPLICATES_QUERY_ROOT = "duplicates";

export function duplicatesQueryKey(workspaceId: string): [string, string] {
  return [DUPLICATES_QUERY_ROOT, workspaceId];
}

export function fetchDuplicates(workspaceId: string): Promise<DuplicatesResponse> {
  return api.get<DuplicatesResponse>(`/api/duplicates?workspace_id=${encodeURIComponent(workspaceId)}`);
}

/** Ids of every copy except the newest in each group (files arrive newest-first). */
export function allButNewest(groups: DuplicateGroup[]): string[] {
  return groups.flatMap((g) => g.files.slice(1).map((f) => f.id));
}

/** How many groups have EVERY copy selected - the confirm dialog calls this out. */
export function fullySelectedGroups(groups: DuplicateGroup[], selected: Set<string>): number {
  return groups.filter((g) => g.files.length > 0 && g.files.every((f) => selected.has(f.id))).length;
}

/** Total bytes of the selected copies (each copy weighs the group's size). */
export function selectedBytes(groups: DuplicateGroup[], selected: Set<string>): number {
  return groups.reduce(
    (sum, g) => sum + g.files.reduce((s, f) => s + (selected.has(f.id) ? g.size_bytes : 0), 0),
    0,
  );
}

/** POST /api/files/batch-delete caps file_ids at 500 per request. */
export const DELETE_CHUNK = 500;

export function chunk<T>(items: T[], size: number = DELETE_CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}
