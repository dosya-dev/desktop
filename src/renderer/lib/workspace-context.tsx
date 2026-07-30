import {
  createContext,
  useContext,
  useState,
  useEffect,
  useCallback,
  useMemo,
  type ReactNode,
} from "react";
import { useQuery } from "@tanstack/react-query";
import type { Workspace } from "@dosya-dev/shared";
import { api } from "./api-client";
import { useAuth } from "./auth-context";
import { SESSION_RESET_EVENT } from "./session-reset";

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

// Stable reference while workspaces are loading, so the memoized context value
// below doesn't churn (and re-render every consumer) on each render.
const EMPTY_WORKSPACES: Workspace[] = [];

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

  const workspaces = data?.workspaces ?? EMPTY_WORKSPACES;
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

  // The in-memory activeId outlives logout (only the localStorage copy is
  // wiped by the main process). Reset it so the next account starts from its
  // own first workspace instead of a dangling previous-account id.
  useEffect(() => {
    const onReset = () => setActiveId(null);
    window.addEventListener(SESSION_RESET_EVENT, onReset);
    return () => window.removeEventListener(SESSION_RESET_EVENT, onReset);
  }, []);

  // Memoize so consumers only re-render when a real input changes - not on every
  // provider render (e.g. the window-focus refetch would otherwise churn a fresh
  // value object and re-render the whole tree). `setActive` is stable and
  // react-query's `refetch` is referentially stable across renders.
  const value = useMemo<WorkspaceState>(
    () => ({ workspaces, active, setActive, isLoading, isError, refetch }),
    [workspaces, active, setActive, isLoading, isError, refetch],
  );

  return (
    <WorkspaceContext.Provider value={value}>
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
