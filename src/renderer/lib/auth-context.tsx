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
import { SESSION_CHECK_INTERVAL_MS, SIGNED_OUT_NOTICE_KEY, sessionLoss } from "./session-loss";
import { toast } from "sonner";
import { setSentryUser } from "./sentry";
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

/** A platform switch has paused this surface (503 + `surface_disabled`). */
interface MaintenanceInfo {
  surface: string;
  message: string | null;
}

interface AuthState {
  user: User | null;
  isLoading: boolean;
  isAuthenticated: boolean;
  login: (email: string, password: string) => Promise<LoginResult>;
  logout: () => Promise<void>;
  /** Resolves true only when /api/me actually succeeded and `user` was set -
   *  false on 401, on 503/surface_disabled, and on any other error. Callers
   *  that need to know whether the surface is back (MaintenanceGate's
   *  onRetry) MUST branch on this instead of assuming success from the
   *  absence of a throw: this never throws, it swallows every error case. */
  refreshUser: () => Promise<boolean>;
  maintenance: MaintenanceInfo | null;
  clearMaintenance: () => void;
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
  const [maintenance, setMaintenance] = useState<MaintenanceInfo | null>(null);
  const clearMaintenance = useCallback(() => setMaintenance(null), []);

  const refreshUser = useCallback(async (): Promise<boolean> => {
    try {
      const data = await api.get<{ user: User }>("/api/me");
      setUser(data.user);
      // A successful round trip proves the surface is back - the same signal
      // the sync engine's clearOffline uses to clear its own maintenance flag.
      setMaintenance(null);
      reconcileAppearance(data.user);
      return true;
    } catch (err) {
      // Only a confirmed 401 means "logged out". A transient error (network
      // blip, 5xx) must NOT force a logout - keep the current user as-is.
      if (err instanceof ApiError && err.status === 401) {
        setUser(null);
      } else if (err instanceof ApiError && err.status === 503 && err.data.code === "surface_disabled") {
        setMaintenance({
          surface: String(err.data.surface ?? "desktop"),
          message: typeof err.data.message === "string" ? err.data.message : null,
        });
      }
      // Every branch above (401, still-in-maintenance, or a plain transient
      // error) means "did not succeed" - the caller must not treat this as
      // "the surface is back". This never throws: MaintenanceGate's onRetry
      // relies on the boolean, not on catching a rejection.
      return false;
    }
  }, []);

  // Tag crash reports with the opaque account id (never the email or name)
  // so an issue can be tied back to a support thread; cleared on logout.
  const userId = user?.id ?? null;
  useEffect(() => {
    setSentryUser(userId);
  }, [userId]);

  // Check session on mount. Retry transient failures a few times before
  // concluding - otherwise a single network blip / 5xx at startup strands a
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
            break; // definitively unauthenticated - no point retrying
          }
          if (err instanceof ApiError && err.status === 503 && err.data.code === "surface_disabled") {
            setMaintenance({
              surface: String(err.data.surface ?? "desktop"),
              message: typeof err.data.message === "string" ? err.data.message : null,
            });
            if (!cancelled) setIsLoading(false);
            break; // the maintenance screen takes over - no point retrying
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
      // ignore - best-effort
    }
    // Clear the Electron cookie. This triggers the cookies.on("changed")
    // listener in the main process which calls syncEngine.stop() -
    // stopping all watchers, pollers, and timers automatically.
    // Don't call pauseAllSync() here - that persists pausedGlobally=true
    // to disk, which would prevent sync from starting on the next login.
    await window.electronAPI.clearSession();
    setUser(null);
    resetSessionState();
    // Hard guarantee: reload the renderer so NOTHING from this session survives
    // in memory - Chromium's in-process image cache (the stale-avatar culprit),
    // module-level state, and any stray promise chains all die here. The app
    // boots onto onboarding because the session cookie is already cleared.
    window.location.hash = "#/onboarding";
    window.location.reload();
  }, []);

  // A session can end without this app doing anything: an admin revokes it
  // from the portal, the user ends it from another device, or it expires.
  // Before this, the renderer checked /api/me once at boot and never again,
  // so a revoked session kept a fully usable, signed-in UI on screen. Three
  // signals now converge here (see session-loss.ts): any API 401, the sync
  // engine's own 401 over IPC, and a periodic + on-focus re-check for an idle
  // window. Each is confirmed against /api/me before tearing down, so one
  // flaky response cannot sign anyone out.
  const userRef = useRef<User | null>(null);
  userRef.current = user;
  const checkingRef = useRef(false);
  const lastCheckRef = useRef(0);

  const endSession = useCallback(async (notice: string) => {
    try { sessionStorage.setItem(SIGNED_OUT_NOTICE_KEY, notice); } catch { /* storage unavailable */ }
    // Same teardown as logout(): drop the stale cookie (which also stops the
    // sync engine), wipe caches, and reload so nothing of this account
    // survives in memory. The server side is already gone.
    try { await window.electronAPI.clearSession(); } catch { /* best effort */ }
    setUser(null);
    resetSessionState();
    window.location.hash = "#/onboarding";
    window.location.reload();
  }, []);

  const confirmSession = useCallback(async (opts: { throttle: boolean }) => {
    if (!userRef.current || checkingRef.current) return;
    // Focus and the timer are throttled; a reported 401 always re-checks.
    if (opts.throttle && Date.now() - lastCheckRef.current < 30_000) return;
    checkingRef.current = true;
    lastCheckRef.current = Date.now();
    try {
      await api.get("/api/me");
    } catch (err) {
      // Only a confirmed 401 ends the session. Network blips and 5xx keep
      // the user signed in, exactly like refreshUser above.
      if (err instanceof ApiError && err.status === 401) {
        await endSession("Your session was ended. Please sign in again.");
      }
    } finally {
      checkingRef.current = false;
    }
  }, [endSession]);

  useEffect(() => {
    const offSignal = sessionLoss.subscribe(() => { void confirmSession({ throttle: false }); });
    // Optional: component tests render this provider without a preload bridge.
    const offIpc = window.electronAPI?.onSessionExpired?.(() => { void confirmSession({ throttle: false }); });
    const onFocus = () => { void confirmSession({ throttle: true }); };
    window.addEventListener("focus", onFocus);
    const timer = setInterval(() => { void confirmSession({ throttle: true }); }, SESSION_CHECK_INTERVAL_MS);
    return () => {
      offSignal();
      offIpc?.();
      window.removeEventListener("focus", onFocus);
      clearInterval(timer);
    };
  }, [confirmSession]);

  // After the teardown reload, say why the user is looking at the sign-in
  // screen. The Toaster is a child of this provider, so it is mounted by the
  // time this effect runs.
  useEffect(() => {
    let notice: string | null = null;
    try {
      notice = sessionStorage.getItem(SIGNED_OUT_NOTICE_KEY);
      if (notice) sessionStorage.removeItem(SIGNED_OUT_NOTICE_KEY);
    } catch { /* storage unavailable */ }
    if (notice) toast.info("Signed out", { description: notice });
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
        maintenance,
        clearMaintenance,
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
