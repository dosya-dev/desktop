import { useState, type FormEvent } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import { api, ApiError } from "@/lib/api-client";
import { useAuth } from "@/lib/auth-context";
import { Shield, ArrowLeft, KeyRound, Mail } from "lucide-react";
import logoSvg from "@/assets/logo.svg";

export function TwoFactorPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const { refreshUser } = useAuth();

  const state = location.state as { email?: string; method?: string } | null;
  const method = state?.method ?? "totp";
  const email = state?.email ?? "";

  const [code, setCode] = useState("");
  const [isRecovery, setIsRecovery] = useState(false);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError("");

    if (!code.trim()) {
      setError("Please enter a code");
      return;
    }

    setLoading(true);
    try {
      const data = await api.post<{ ok: boolean; user?: any }>("/api/auth/2fa/verify", {
        code: code.trim(),
        is_recovery: isRecovery,
      });

      // Wait for cookie SameSite fix, then refresh user context
      await window.electronAPI.waitForSession();
      await refreshUser();
      navigate("/dashboard");
    } catch (err) {
      if (err instanceof ApiError) {
        setError(err.message);
      } else {
        setError("Verification failed. Please try again.");
      }
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="bg-grid flex h-screen flex-col items-center justify-center bg-[var(--color-bg-secondary)]">
      <div className="mb-6 flex items-center gap-2.5">
        <img src={logoSvg} alt="dosya.dev" className="h-9 w-9" />
        <span className="text-xl font-semibold">dosya.dev</span>
      </div>

      <div
        className="w-full max-w-sm rounded-xl border bg-[var(--color-bg)] p-8 shadow-sm"
        style={{ borderColor: "var(--color-border)" }}
      >
        <div className="mb-6 text-center">
          <div className="mx-auto mb-3 flex h-10 w-10 items-center justify-center rounded-full bg-[var(--color-primary)]/10">
            {method === "email" ? (
              <Mail size={20} className="text-[var(--color-primary)]" />
            ) : (
              <Shield size={20} className="text-[var(--color-primary)]" />
            )}
          </div>
          <h1 className="text-2xl font-semibold">Two-factor authentication</h1>
          <p className="mt-1 text-sm text-[var(--color-text-secondary)]">
            {isRecovery
              ? "Enter one of your recovery codes"
              : method === "email"
                ? <>We sent a 6-digit code to <span className="font-medium text-[var(--color-text)]">{email}</span></>
                : "Enter the code from your authenticator app"}
          </p>
        </div>

        {error && (
          <div className="mb-4 rounded-lg bg-red-50 px-4 py-3 text-sm text-red-600">
            {error}
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="mb-1 block text-sm font-medium">
              {isRecovery ? "Recovery code" : "Verification code"}
            </label>
            {isRecovery ? (
              <input
                type="text"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                autoFocus
                placeholder="xxxx-xxxx-xxxx"
                className="w-full rounded-lg border px-3 py-2 text-sm font-mono outline-none focus:border-[var(--color-primary)] focus:ring-1 focus:ring-[var(--color-primary)]"
                style={{ borderColor: "var(--color-border)" }}
              />
            ) : (
              <input
                type="text"
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
                maxLength={6}
                autoFocus
                placeholder="000000"
                className="w-full rounded-lg border px-3 py-2 text-center text-lg font-mono tracking-[0.3em] outline-none focus:border-[var(--color-primary)] focus:ring-1 focus:ring-[var(--color-primary)]"
                style={{ borderColor: "var(--color-border)" }}
              />
            )}
          </div>

          <button
            type="submit"
            disabled={loading || !code.trim()}
            className="w-full rounded-lg px-4 py-2.5 text-sm font-medium text-white transition-colors disabled:opacity-50"
            style={{
              background: loading ? "var(--color-primary-hover)" : "var(--color-primary)",
            }}
          >
            {loading ? "Verifying..." : "Verify"}
          </button>
        </form>

        <div className="mt-4 text-center">
          {!isRecovery ? (
            <button
              onClick={() => { setIsRecovery(true); setCode(""); setError(""); }}
              className="text-xs text-[var(--color-text-muted)] hover:text-[var(--color-primary)]"
            >
              <KeyRound size={11} className="mr-1 inline" />
              Use a recovery code instead
            </button>
          ) : (
            <button
              onClick={() => { setIsRecovery(false); setCode(""); setError(""); }}
              className="text-xs text-[var(--color-text-muted)] hover:text-[var(--color-primary)]"
            >
              Back to {method === "email" ? "email" : "authenticator"} code
            </button>
          )}
        </div>

        <button
          onClick={() => navigate("/login")}
          className="mt-4 flex w-full items-center justify-center gap-1.5 text-sm text-[var(--color-text-secondary)] hover:text-[var(--color-text)]"
        >
          <ArrowLeft size={14} />
          Back to sign in
        </button>
      </div>
    </div>
  );
}
