import {
  createContext,
  useContext,
  useState,
  useEffect,
  useCallback,
  type ReactNode,
} from "react";
import { useNavigate } from "react-router-dom";
import { api, ApiError } from "./api-client";
import { queryClient } from "./query-client";
import type { User } from "@dosya-dev/shared";

interface AuthState {
  user: User | null;
  isLoading: boolean;
  isAuthenticated: boolean;
  login: (email: string, password: string) => Promise<LoginResult>;
  logout: () => Promise<void>;
  refreshUser: () => Promise<void>;
}

interface LoginResult {
  ok: boolean;
  requires_2fa?: boolean;
  twofa_method?: string;
  error?: string;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const navigate = useNavigate();

  const refreshUser = useCallback(async () => {
    try {
      const data = await api.get<{ user: User }>("/api/me");
      setUser(data.user);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        setUser(null);
      }
    }
  }, []);

  // Check session on mount
  useEffect(() => {
    refreshUser().finally(() => setIsLoading(false));
  }, [refreshUser]);

  const login = useCallback(
    async (email: string, password: string): Promise<LoginResult> => {
      try {
        const data = await api.post<{
          ok: boolean;
          requires_2fa?: boolean;
          method?: string;
          user?: User;
        }>("/api/auth/login", { email, password });

        if (data.requires_2fa) {
          return {
            ok: false,
            requires_2fa: true,
            twofa_method: data.method,
          };
        }

        // Wait for Electron to fix the session cookie (SameSite=Lax → None)
        // BEFORE setting user state. Setting user triggers workspace queries
        // via `enabled: isAuthenticated`, and those need the fixed cookie.
        await window.electronAPI.waitForSession();

        if (data.user) {
          setUser(data.user);
        } else {
          await refreshUser();
        }

        return { ok: true };
      } catch (err) {
        if (err instanceof ApiError) {
          return { ok: false, error: err.message };
        }
        const message =
          err instanceof Error ? err.message : "An unexpected error occurred";
        console.error("Login error:", err);
        return { ok: false, error: message };
      }
    },
    [refreshUser],
  );

  const logout = useCallback(async () => {
    // Server-side: invalidate session in DB + KV cache
    try {
      await api.post("/api/auth/logout");
    } catch {
      // ignore — best-effort
    }
    // Clear the Electron cookie. This triggers the cookies.on("changed")
    // listener in the main process which calls syncEngine.stop() —
    // stopping all watchers, pollers, and timers automatically.
    // Don't call pauseAllSync() here — that persists pausedGlobally=true
    // to disk, which would prevent sync from starting on the next login.
    await window.electronAPI.clearSession();
    setUser(null);
    queryClient.clear();
    navigate("/onboarding");
  }, [navigate]);

  return (
    <AuthContext.Provider
      value={{
        user,
        isLoading,
        isAuthenticated: !!user,
        login,
        logout,
        refreshUser,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
