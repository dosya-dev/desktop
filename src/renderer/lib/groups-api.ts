import { api } from "@/lib/api-client";

/**
 * Groups are per-user, not per-workspace-member: /api/groups filters on user_id
 * too, so two members of the same workspace see different groups.
 *
 * Ported from apps/mobile/src/groups/api.ts - keep the two in step.
 */
export interface GroupFolderItem {
  item_id: string;
  folder_id: string;
  folder_name: string;
  parent_id: string | null;
}

export interface GroupFileItem {
  item_id: string;
  file_id: string;
  file_name: string;
  size_bytes: number;
  extension: string | null;
  folder_id: string | null;
}

export interface Group {
  id: string;
  name: string;
  color: string;
  sort_order: number;
  created_at: number;
  folders: GroupFolderItem[];
  files: GroupFileItem[];
}

/** The server's own default when a colour is omitted. */
export const DEFAULT_GROUP_COLOR = "#706E69";

/** The API caps the name at 100; enforced here so the dialog can say so first. */
export const MAX_GROUP_NAME = 100;

export async function getGroups(workspaceId: string): Promise<Group[]> {
  const res = await api.get<{ ok: boolean; groups?: Group[] }>(
    `/api/groups?workspace_id=${encodeURIComponent(workspaceId)}`,
  );
  return res.groups ?? [];
}

export async function createGroup(workspaceId: string, name: string, color?: string): Promise<void> {
  await api.post("/api/groups", color
    ? { workspace_id: workspaceId, name, color }
    : { workspace_id: workspaceId, name });
}

export async function updateGroup(id: string, patch: { name?: string; color?: string }): Promise<void> {
  await api.put(`/api/groups/${id}`, patch);
}

export async function deleteGroup(id: string): Promise<void> {
  await api.delete(`/api/groups/${id}`);
}

/** Adding is a POST to the group itself with the item in the body - not a nested route. */
export async function addFolderToGroup(groupId: string, folderId: string): Promise<void> {
  await api.post(`/api/groups/${groupId}`, { folder_id: folderId });
}

export async function addFileToGroup(groupId: string, fileId: string): Promise<void> {
  await api.post(`/api/groups/${groupId}`, { file_id: fileId });
}

export async function removeFolderFromGroup(groupId: string, folderId: string): Promise<void> {
  await api.delete(`/api/groups/${groupId}/folders/${folderId}`);
}

export async function removeFileFromGroup(groupId: string, fileId: string): Promise<void> {
  await api.delete(`/api/groups/${groupId}/files/${fileId}`);
}
