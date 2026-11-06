import { create } from "zustand";

/**
 * /api/workspaces/:id/icon is a fixed path served with a one-hour cache, so a
 * replaced logo keeps painting the old image unless the URL changes. Every
 * workspace icon <img> builds its URL with workspaceIconUrl(); Settings bumps
 * the version after an upload or removal, which repaints the sidebar, the
 * switcher and the dashboard at once. Starts from the launch time rather than
 * 0 so a previous session's cached `?v=0` can never be reused.
 */
interface WorkspaceIconVersionState {
  version: number;
  bump: () => void;
}

export const useWorkspaceIconVersion = create<WorkspaceIconVersionState>((set) => ({
  version: Date.now(),
  bump: () => set((s) => ({ version: Math.max(s.version + 1, Date.now()) })),
}));

export function workspaceIconUrl(apiBase: string, workspaceId: string, version: number): string {
  return `${apiBase}/api/workspaces/${encodeURIComponent(workspaceId)}/icon?v=${version}`;
}
