import {
  createContext,
  useContext,
  useState,
  useEffect,
  useCallback,
  useRef,
  type ReactNode,
} from "react";
import { api, ApiError } from "./api-client";
import { resetSessionState } from "./session-reset";
import { applyTheme, writeCache, readCache, initSystemListener } from "./theme";
import { isThemeId, isMode, DEFAULT_THEME, DEFAULT_MODE } from "./themes";
import type { User } from "@dosya-dev/shared";

// The API returns the account's saved appearance on /api/me, but it isn't part
// of the shared User type. Read it loosely and reconcile it onto <html> so the
// desktop app follows the same theme the user picked on any device.
function reconcileAppearance(user: unknown): void {
  const u = user as { ui_theme?: unknown; ui_mode?: unknown } | null;
  if (!u) return;
  const pref = {
    theme: isThemeId(u.ui_theme) ? u.ui_theme : DEFAULT_THEME,
    mode: isMode(u.ui_mode) ? u.ui_mode : DEFAULT_MODE,
  };
  applyTheme(pref);
  writeCache(pref);
}

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

  const refreshUser = useCallback(async () => {
    try {
      const data = await api.get<{ user: User }>("/api/me");
      setUser(data.user);
      reconcileAppearance(data.user);
    } catch (err) {
      // Only a confirmed 401 means "logged out". A transient error (network
      // blip, 5xx) must NOT force a logout — keep the current user as-is.
      if (err instanceof ApiError && err.status === 401) {
        setUser(null);
      }
    }
  }, []);

  // Check session on mount. Retry transient failures a few times before
  // concluding — otherwise a single network blip / 5xx at startup strands a
  // logged-in user on the onboarding screen with no way to recover but reload.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const data = await api.get<{ user: User }>("/api/me");
          if (cancelled) return;
          setUser(data.user);
          reconcileAppearance(data.user);
          break;
        } catch (err) {
          if (err instanceof ApiError && err.status === 401) {
            if (!cancelled) setUser(null);
            break; // definitively unauthenticated — no point retrying
          }
          // Transient: back off and retry (1s, 2s) before giving up.
          if (attempt < 2) await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
        }
      }
      if (!cancelled) setIsLoading(false);
    })();
    return () => { cancelled = true; };
  }, []);

  // Re-apply the theme when the OS light/dark preference changes while the
  // user is on "system" mode.
  useEffect(() => initSystemListener(readCache), []);

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

  // If the session ends WITHOUT an explicit logout (401 during refreshUser or
  // the boot check), run the same teardown so the next account never sees this
  // account's caches. prevUserRef distinguishes "was signed in, now isn't"
  // from the initial user=null state.
  const prevUserRef = useRef<User | null>(null);
  useEffect(() => {
    if (prevUserRef.current && !user) {
      resetSessionState();
    }
    prevUserRef.current = user;
  }, [user]);

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
    resetSessionState();
    // Hard guarantee: reload the renderer so NOTHING from this session survives
    // in memory — Chromium's in-process image cache (the stale-avatar culprit),
    // module-level state, and any stray promise chains all die here. The app
    // boots onto onboarding because the session cookie is already cleared.
    window.location.hash = "#/onboarding";
    window.location.reload();
  }, []);

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
