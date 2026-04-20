import { useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api, ApiError } from "@/lib/api-client";
import { isValidEmail, validatePassword } from "@dosya-dev/shared";
import { ArrowLeft, Mail, CheckCircle2, KeyRound } from "lucide-react";
import logoSvg from "@/assets/logo.svg";

type Step = "email" | "code" | "done";

export function ForgotPasswordPage() {
  const navigate = useNavigate();
  const [step, setStep] = useState<Step>("email");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  // Step 1: Send code
  async function handleSendCode(e: FormEvent) {
    e.preventDefault();
    setError("");

    if (!isValidEmail(email)) {
      setError("Please enter a valid email address");
      return;
    }

    setLoading(true);
    try {
      await api.post("/api/auth/forgot-password-code", { email });
      setStep("code");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "An unexpected error occurred");
    } finally {
      setLoading(false);
    }
  }

  // Step 2: Verify code + set new password
  async function handleResetPassword(e: FormEvent) {
    e.preventDefault();
    setError("");

    if (code.length !== 6) {
      setError("Please enter the 6-digit code");
      return;
    }

    const pwError = validatePassword(newPassword);
    if (pwError) {
      setError(pwError);
      return;
    }

    if (newPassword !== confirmPassword) {
      setError("Passwords don't match");
      return;
    }

    setLoading(true);
    try {
      await api.post("/api/auth/reset-password-code", {
        email,
        code,
        new_password: newPassword,
      });
      setStep("done");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "An unexpected error occurred");
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
        {/* Step 1: Enter email */}
        {step === "email" && (
          <>
            <div className="mb-6 text-center">
              <h1 className="text-2xl font-semibold">Forgot password?</h1>
              <p className="mt-1 text-sm text-[var(--color-text-secondary)]">
                Enter your email and we'll send you a 6-digit reset code
              </p>
            </div>

            {error && (
              <div className="mb-4 rounded-lg bg-red-50 px-4 py-3 text-sm text-red-600">{error}</div>
            )}

            <form onSubmit={handleSendCode} className="space-y-4">
              <div>
                <label className="mb-1 block text-sm font-medium">Email</label>
                <div className="relative">
                  <Mail size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--color-text-muted)]" />
                  <input
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    required
                    autoFocus
                    className="w-full rounded-lg border py-2 pl-10 pr-3 text-sm outline-none focus:border-[var(--color-primary)] focus:ring-1 focus:ring-[var(--color-primary)]"
                    style={{ borderColor: "var(--color-border)" }}
                    placeholder="you@example.com"
                  />
                </div>
              </div>

              <button
                type="submit"
                disabled={loading}
                className="w-full rounded-lg px-4 py-2.5 text-sm font-medium text-white transition-colors disabled:opacity-50"
                style={{ background: loading ? "var(--color-primary-hover)" : "var(--color-primary)" }}
              >
                {loading ? "Sending code..." : "Send reset code"}
              </button>
            </form>

            <Link
              to="/login"
              className="mt-5 flex items-center justify-center gap-1.5 text-sm text-[var(--color-text-secondary)] hover:text-[var(--color-text)]"
            >
              <ArrowLeft size={14} />
              Back to sign in
            </Link>
          </>
        )}

        {/* Step 2: Enter code + new password */}
        {step === "code" && (
          <>
            <div className="mb-6 text-center">
              <div className="mx-auto mb-3 flex h-10 w-10 items-center justify-center rounded-full bg-[var(--color-primary)]/10">
                <KeyRound size={20} className="text-[var(--color-primary)]" />
              </div>
              <h1 className="text-2xl font-semibold">Enter reset code</h1>
              <p className="mt-1 text-sm text-[var(--color-text-secondary)]">
                We sent a 6-digit code to <span className="font-medium text-[var(--color-text)]">{email}</span>
              </p>
            </div>

            {error && (
              <div className="mb-4 rounded-lg bg-red-50 px-4 py-3 text-sm text-red-600">{error}</div>
            )}

            <form onSubmit={handleResetPassword} className="space-y-4">
              <div>
                <label className="mb-1 block text-sm font-medium">6-digit code</label>
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

              <div>
                <label className="mb-1 block text-sm font-medium">New password</label>
                <input
                  type="password"
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  required
                  placeholder="Min. 8 characters"
                  className="w-full rounded-lg border px-3 py-2 text-sm outline-none focus:border-[var(--color-primary)] focus:ring-1 focus:ring-[var(--color-primary)]"
                  style={{ borderColor: "var(--color-border)" }}
                />
              </div>

              <div>
                <label className="mb-1 block text-sm font-medium">Confirm password</label>
                <input
                  type="password"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  required
                  placeholder="Repeat your password"
                  className="w-full rounded-lg border px-3 py-2 text-sm outline-none focus:border-[var(--color-primary)] focus:ring-1 focus:ring-[var(--color-primary)]"
                  style={{ borderColor: "var(--color-border)" }}
                />
                <p className="mt-1 text-xs text-[var(--color-text-muted)]">
                  Must include uppercase, lowercase, number, and special character
                </p>
              </div>

              <button
                type="submit"
                disabled={loading || code.length !== 6}
                className="w-full rounded-lg px-4 py-2.5 text-sm font-medium text-white transition-colors disabled:opacity-50"
                style={{ background: loading ? "var(--color-primary-hover)" : "var(--color-primary)" }}
              >
                {loading ? "Resetting..." : "Reset password"}
              </button>
            </form>

            <button
              onClick={() => { setStep("email"); setCode(""); setError(""); }}
              className="mt-5 flex w-full items-center justify-center gap-1.5 text-sm text-[var(--color-text-secondary)] hover:text-[var(--color-text)]"
            >
              <ArrowLeft size={14} />
              Try a different email
            </button>
          </>
        )}

        {/* Step 3: Success */}
        {step === "done" && (
          <div className="text-center">
            <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-[var(--color-primary)]/10">
              <CheckCircle2 size={24} className="text-[var(--color-primary)]" />
            </div>
            <h1 className="text-xl font-semibold">Password reset!</h1>
            <p className="mt-2 text-sm text-[var(--color-text-secondary)]">
              Your password has been changed successfully. Please sign in with your new password.
            </p>
            <button
              onClick={() => navigate("/login")}
              className="mt-6 w-full rounded-lg px-4 py-2.5 text-sm font-medium text-white transition-colors"
              style={{ background: "var(--color-primary)" }}
            >
              Sign in
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
