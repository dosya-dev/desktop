import { create } from "zustand";

/**
 * Shell-level UI state that more than one surface drives. The sidebar's
 * collapse used to be local to Sidebar.tsx; the View menu's "Show Sidebar"
 * needs to flip it from outside, so it lives here.
 */
interface UiStore {
  sidebarCollapsed: boolean;
  setSidebarCollapsed: (collapsed: boolean) => void;
  toggleSidebar: () => void;
}

export const useUiStore = create<UiStore>((set) => ({
  sidebarCollapsed: false,
  setSidebarCollapsed: (sidebarCollapsed) => set({ sidebarCollapsed }),
  toggleSidebar: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),
}));
