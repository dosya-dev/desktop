import {
  createContext,
  useContext,
  useState,
  useEffect,
  useCallback,
  type ReactNode,
} from "react";
import { useQuery } from "@tanstack/react-query";
import type { Workspace } from "@dosya-dev/shared";
import { api } from "./api-client";
import { useAuth } from "./auth-context";

interface WorkspaceState {
  workspaces: Workspace[];
  active: Workspace | null;
  setActive: (ws: Workspace) => void;
  isLoading: boolean;
  isError: boolean;
  refetch: () => void;
}

const WorkspaceContext = createContext<WorkspaceState | null>(null);

const STORAGE_KEY = "dosya_active_workspace";

export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const { isAuthenticated } = useAuth();
  const [activeId, setActiveId] = useState<string | null>(() => {
    try {
      return localStorage.getItem(STORAGE_KEY);
    } catch {
      return null;
    }
  });

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ["workspaces"],
    queryFn: () =>
      api.get<{ ok: boolean; workspaces: Workspace[] }>("/api/workspaces"),
    staleTime: 10_000,
    refetchOnWindowFocus: true,
    enabled: isAuthenticated,
    // Override global no-retry-on-401: the cookie may not be ready yet
    // right after login (SameSite fix is async).
    retry: 3,
    retryDelay: 500,
  });

  const workspaces = data?.workspaces ?? [];
  const active =
    workspaces.find((w) => w.id === activeId) ?? workspaces[0] ?? null;

  useEffect(() => {
    if (active) {
      localStorage.setItem(STORAGE_KEY, active.id);
    }
  }, [active]);

  const setActive = useCallback((ws: Workspace) => {
    setActiveId(ws.id);
  }, []);

  return (
    <WorkspaceContext.Provider
      value={{ workspaces, active, setActive, isLoading, isError, refetch }}
    >
      {children}
    </WorkspaceContext.Provider>
  );
}

export function useWorkspace() {
  const ctx = useContext(WorkspaceContext);
  if (!ctx)
    throw new Error("useWorkspace must be used within WorkspaceProvider");
  return ctx;
}
