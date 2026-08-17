import { useState, useRef, useEffect, type FormEvent } from "react";
import { Link, Navigate, useNavigate } from "react-router-dom";
import { useAuth } from "@/lib/auth-context";
import { ipc } from "@/lib/ipc";
import logoSvg from "@/assets/logo.svg";
import { LegalNotice } from "@/components/LegalNotice";

export function LoginPage() {
  const { login, refreshUser, isAuthenticated, isLoading: authLoading } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [showPassword, setShowPassword] = useState(false);

  // Pending OAuth teardown (IPC listener + 2-min timeout). Held in a ref so we
  // can tear it down when the flow completes AND if the page unmounts first -
  // otherwise the timer would fire on an unmounted component.
  const oauthCleanup = useRef<(() => void) | null>(null);
  useEffect(() => () => oauthCleanup.current?.(), []);

  // Already logged in - skip login page and go straight to dashboard
  if (!authLoading && isAuthenticated) {
    return <Navigate to="/dashboard" replace />;
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError("");
    setLoading(true);

    const result = await login(email, password);
    setLoading(false);

    if (result.ok) {
      navigate("/dashboard");
    } else if (result.requires_2fa) {
      navigate("/2fa", { state: { email, method: result.twofa_method } });
    } else {
      setError(result.error || "Login failed");
    }
  }

  async function handleOAuth(provider: string) {
    setError("");
    setLoading(true);

    // Open the system browser for OAuth - user is already logged into Google/GitHub there.
    // beginOAuth mints a single-use nonce in the main process and returns the
    // provider URL carrying it; the dosya://auth/callback is only accepted if it
    // echoes that nonce back. The server redirects to dosya://auth/callback?token=…&state=…
    //
    // Both calls can fail (an unknown provider throws in the main process; the
    // window-open handler can refuse). Unguarded, the failure escaped as an
    // unhandled rejection and left `loading` stuck true, so the button just span
    // forever with nothing on screen to explain it.
    try {
      const oauthUrl = await window.electronAPI.beginOAuth(provider);
      // Open in system browser (Chrome, Firefox, etc.)
      window.open(oauthUrl, "_blank");
    } catch (err: any) {
      setLoading(false);
      setError(err?.message || `Could not start ${provider} sign-in. Please try again.`);
      return;
    }

    // Tear down any previous in-flight attempt before starting a new one.
    oauthCleanup.current?.();

    // Listen for the callback from the main process
    const unsub = window.electronAPI.onOAuthComplete(async () => {
      oauthCleanup.current?.();
      oauthCleanup.current = null;
      try {
        await window.electronAPI.waitForSession();
        await refreshUser();
        navigate("/dashboard");
      } catch (err: any) {
        setError(err.message || "Login failed");
      } finally {
        setLoading(false);
      }
    });

    // Timeout after 2 minutes if the user doesn't complete OAuth
    const timer = setTimeout(() => {
      oauthCleanup.current?.();
      oauthCleanup.current = null;
      setLoading(false);
      setError("Login timed out. Please try again.");
    }, 120_000);

    // One combined teardown for both the listener and the timer.
    oauthCleanup.current = () => {
      unsub();
      clearTimeout(timer);
    };
  }

  return (
    <div className="bg-grid flex h-screen flex-col items-center overflow-y-auto py-8 [justify-content:safe_center] bg-[var(--color-bg-secondary)]">
      <div className="mb-6 flex items-center gap-2.5">
        <img src={logoSvg} alt="dosya.dev" className="h-9 w-9" />
        <span className="text-xl font-semibold">dosya.dev</span>
      </div>
      <div className="w-full max-w-sm rounded-xl bg-[var(--color-bg)] p-8 shadow-sm border" style={{ borderColor: "var(--color-border)" }}>
        <div className="mb-6 text-center">
          <h1 className="text-2xl font-semibold">Welcome back</h1>
          <p className="mt-1 text-sm text-[var(--color-text-secondary)]">
            Sign in to your dosya account
          </p>
        </div>

        {error && (
          <div className="mb-4 rounded-lg bg-red-50 px-4 py-3 text-sm text-red-600">
            {error}
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="mb-1 block text-sm font-medium">Email</label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              className="w-full rounded-lg border px-3 py-2 text-sm outline-none focus:border-[var(--color-primary)] focus:ring-1 focus:ring-[var(--color-primary)]"
              style={{ borderColor: "var(--color-border)" }}
              placeholder="you@example.com"
            />
          </div>

          <div>
            <div className="mb-1 flex items-center justify-between">
              <label className="text-sm font-medium">Password</label>
              <Link
                to="/forgot-password"
                className="text-xs text-[var(--color-primary)] hover:underline"
              >
                Forgot password?
              </Link>
            </div>
            <div className="relative">
              <input
                type={showPassword ? "text" : "password"}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                className="w-full rounded-lg border px-3 py-2 pr-10 text-sm outline-none focus:border-[var(--color-primary)] focus:ring-1 focus:ring-[var(--color-primary)]"
                style={{ borderColor: "var(--color-border)" }}
                placeholder="Enter your password"
              />
              <button
                type="button"
                onClick={() => setShowPassword(!showPassword)}
                className="absolute right-2.5 top-1/2 -translate-y-1/2 text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)]"
                tabIndex={-1}
              >
                {showPassword ? (
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M17.94 17.94A10.07 10.07 0 0112 20c-7 0-11-8-11-8a18.45 18.45 0 015.06-5.94" />
                    <path d="M9.9 4.24A9.12 9.12 0 0112 4c7 0 11 8 11 8a18.5 18.5 0 01-2.16 3.19" />
                    <line x1="1" y1="1" x2="23" y2="23" />
                  </svg>
                ) : (
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                    <circle cx="12" cy="12" r="3" />
                  </svg>
                )}
              </button>
            </div>
          </div>

          <button
            type="submit"
            disabled={loading}
            className="w-full rounded-lg px-4 py-2.5 text-sm font-medium text-white transition-colors disabled:opacity-50"
            style={{
              background: loading
                ? "var(--color-primary-hover)"
                : "var(--color-primary)",
            }}
          >
            {loading ? "Signing in..." : "Sign in"}
          </button>
        </form>

        <div className="my-5 flex items-center gap-3">
          <div className="h-px flex-1 bg-[var(--color-border)]" />
          <span className="text-xs text-[var(--color-text-muted)]">or</span>
          <div className="h-px flex-1 bg-[var(--color-border)]" />
        </div>

        <div className="space-y-2">
          <button
            onClick={() => handleOAuth("google")}
            className="flex w-full items-center justify-center gap-2 rounded-lg border px-4 py-2.5 text-sm font-medium hover:bg-[var(--color-bg-secondary)] transition-colors"
            style={{ borderColor: "var(--color-border)" }}
          >
            <svg width="18" height="18" viewBox="0 0 18 18">
              <path
                d="M17.64 9.2c0-.637-.057-1.251-.164-1.84H9v3.481h4.844a4.14 4.14 0 01-1.796 2.716v2.259h2.908c1.702-1.567 2.684-3.875 2.684-6.615z"
                fill="#4285F4"
              />
              <path
                d="M9 18c2.43 0 4.467-.806 5.956-2.18l-2.908-2.259c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.584-5.036-3.711H.957v2.332A8.997 8.997 0 009 18z"
                fill="#34A853"
              />
              <path
                d="M3.964 10.71A5.41 5.41 0 013.682 9c0-.593.102-1.17.282-1.71V4.958H.957A8.997 8.997 0 000 9c0 1.452.348 2.827.957 4.042l3.007-2.332z"
                fill="#FBBC05"
              />
              <path
                d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0A8.997 8.997 0 00.957 4.958L3.964 7.29C4.672 5.163 6.656 3.58 9 3.58z"
                fill="#EA4335"
              />
            </svg>
            Continue with Google
          </button>
          <button
            onClick={() => handleOAuth("github")}
            className="flex w-full items-center justify-center gap-2 rounded-lg border px-4 py-2.5 text-sm font-medium hover:bg-[var(--color-bg-secondary)] transition-colors"
            style={{ borderColor: "var(--color-border)" }}
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
              <path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z" />
            </svg>
            Continue with GitHub
          </button>
          <button
            onClick={() => handleOAuth("apple")}
            className="flex w-full items-center justify-center gap-2 rounded-lg border px-4 py-2.5 text-sm font-medium hover:bg-[var(--color-bg-secondary)] transition-colors"
            style={{ borderColor: "var(--color-border)" }}
          >
            {/* currentColor so the mark inverts with the active theme, the way
                the GitHub mark above does. Apple's button guidelines allow this
                white-outline variant with "Continue with Apple". */}
            <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
              <path d="M17.05 12.536c-.02-2.29 1.87-3.39 1.955-3.443-1.065-1.558-2.72-1.771-3.31-1.795-1.41-.142-2.75.83-3.465.83-.714 0-1.816-.81-2.986-.788-1.536.023-2.953.893-3.743 2.267-1.596 2.766-.408 6.86 1.146 9.105.76 1.099 1.667 2.334 2.856 2.29 1.145-.046 1.577-.741 2.962-.741 1.385 0 1.774.741 2.986.718 1.233-.02 2.014-1.12 2.768-2.223.873-1.275 1.232-2.51 1.253-2.573-.027-.012-2.404-.922-2.428-3.657zM14.79 5.518c.632-.766 1.058-1.832.942-2.894-.91.037-2.013.606-2.665 1.371-.586.679-1.099 1.764-.96 2.805 1.015.079 2.05-.516 2.683-1.282z" />
            </svg>
            Continue with Apple
          </button>
        </div>

        <LegalNotice className="mt-6" />

        <p className="mt-4 text-center text-sm text-[var(--color-text-secondary)]">
          Don't have an account?{" "}
          <Link
            to="/signup"
            className="font-medium text-[var(--color-primary)] hover:underline"
          >
            Sign up
          </Link>
        </p>
      </div>
    </div>
  );
}
