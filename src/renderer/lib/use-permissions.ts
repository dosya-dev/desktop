/**
 * The signed-in user's own permissions in the active workspace.
 *
 * The desktop app knew a member's role_id only well enough to print a coloured
 * badge next to their name. Nothing was gated on it: every role was shown
 * Upload, Lock, Hide, Rename, Share and Remove-member, and the first honest
 * feedback was a 403 toast. /api/files even returns `can_lock` and `can_hide`,
 * and FileBrowserPage declared both in its response type without ever reading
 * them.
 *
 * The API remains the authority. This is for hiding doors known to be locked.
 *
 * FAILURE MODE, ON PURPOSE: while loading or on error, `can()` answers TRUE.
 * A UI-side permission map that fails closed hides the whole app behind a
 * network blip and reads as a broken account; one that fails open shows a
 * button that may 403. The server is what says no.
 */
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api-client";
import { useWorkspace } from "@/lib/workspace-context";

export interface MyPermissions {
  ok: boolean;
  user_id: string;
  role_id: string;
  role_name: string | null;
  is_builtin: boolean;
  root_folder_id: string | null;
  root_folder_name: string | null;
  permissions: Record<string, boolean>;
}

export function usePermissions() {
  const { active } = useWorkspace();

  const { data } = useQuery({
    queryKey: ["me-permissions", active?.id],
    queryFn: () => api.get<MyPermissions>(`/api/me/permissions?workspace_id=${active!.id}`),
    enabled: !!active?.id,
    staleTime: 60_000,
  });

  const permissions = data?.permissions;

  const can = (perm: string): boolean => {
    if (!permissions) return true;
    return permissions[perm] ?? false;
  };

  return {
    can,
    permissions,
    userId: data?.user_id ?? null,
    roleId: data?.role_id ?? null,
    roleName: data?.role_name ?? null,
    rootFolderId: data?.root_folder_id ?? null,
    rootFolderName: data?.root_folder_name ?? null,
  };
}
