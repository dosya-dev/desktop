import { useState, type FormEvent } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import { api, ApiError } from "@/lib/api-client";
import { Mail, ArrowLeft, CheckCircle2 } from "lucide-react";
import logoSvg from "@/assets/logo.svg";

export function VerifyPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const emailFromState = (location.state as any)?.email ?? "";
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [resending, setResending] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError("");
    if (code.length !== 6) {
      setError("Please enter the 6-digit code");
      return;
    }

    setLoading(true);
    try {
      await api.post("/api/auth/verify", { code });
      navigate("/login");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Verification failed");
    } finally {
      setLoading(false);
    }
  }

  async function handleResend() {
    setResending(true);
    try {
      await api.post("/api/auth/resend-verification");
      setError("");
    } catch {
      // ignore
    } finally {
      setResending(false);
    }
  }

  return (
    <div className="bg-grid flex h-screen flex-col items-center justify-center bg-[var(--color-bg-secondary)]">
      <div className="mb-6 flex items-center gap-2.5">
        <img src={logoSvg} alt="dosya.dev" className="h-9 w-9" />
        <span className="text-xl font-semibold">dosya.dev</span>
      </div>

      <div className="w-full max-w-sm rounded-xl border bg-[var(--color-bg)] p-8 shadow-sm" style={{ borderColor: "var(--color-border)" }}>
        <div className="mb-6 text-center">
          <div className="mx-auto mb-3 flex h-10 w-10 items-center justify-center rounded-full bg-[var(--color-primary)]/10">
            <Mail size={20} className="text-[var(--color-primary)]" />
          </div>
          <h1 className="text-2xl font-semibold">Verify your email</h1>
          <p className="mt-1 text-sm text-[var(--color-text-secondary)]">
            We sent a 6-digit code to{" "}
            {emailFromState ? (
              <span className="font-medium text-[var(--color-text)]">{emailFromState}</span>
            ) : (
              "your email"
            )}
          </p>
        </div>

        {error && (
          <div className="mb-4 rounded-lg bg-red-50 px-4 py-3 text-sm text-red-600">{error}</div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="mb-1 block text-sm font-medium">Verification code</label>
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
          </div>

          <button
            type="submit"
            disabled={loading || code.length !== 6}
            className="w-full rounded-lg px-4 py-2.5 text-sm font-medium text-white transition-colors disabled:opacity-50"
            style={{ background: "var(--color-primary)" }}
          >
            {loading ? "Verifying..." : "Verify email"}
          </button>
        </form>

        <div className="mt-4 text-center">
          <button
            onClick={handleResend}
            disabled={resending}
            className="text-xs text-[var(--color-text-muted)] hover:text-[var(--color-primary)]"
          >
            {resending ? "Sending..." : "Didn't receive the code? Resend"}
          </button>
        </div>

        <button
          onClick={() => navigate("/login")}
          className="mt-4 flex w-full items-center justify-center gap-1.5 text-sm text-[var(--color-text-secondary)] hover:text-[var(--color-text)]"
        >
          <ArrowLeft size={14} /> Back to sign in
        </button>
      </div>
    </div>
  );
}
