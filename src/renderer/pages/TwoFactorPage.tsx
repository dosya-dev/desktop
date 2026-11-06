import { useState, type FormEvent } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import { api } from "@/lib/api-client";
import { authErrorMessage } from "@/lib/auth-error";
import { useAuth } from "@/lib/auth-context";
import { Shield, ArrowLeft, KeyRound, Mail } from "lucide-react";
import { Logo } from "@/components/Logo";
import { useAuthDirection } from "@/lib/auth-direction";
import { useT } from "@/lib/i18n";
import { richText } from "@/lib/rich-text";

export function TwoFactorPage() {
  const t = useT();
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
      setError(t("two-factor.error.enterTheCodeToContinue"));
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
      await refreshUser(true);
      navigate("/dashboard");
    } catch (err) {
      setError(authErrorMessage(err, t("two-factor.error.couldNotCheckTheCode")));
    } finally {
      setLoading(false);
    }
  }

  const authDir = useAuthDirection();

  return (
    <div
      data-auth-dir={authDir}
      className="bg-grid flex h-screen flex-col items-center overflow-y-auto py-8 [justify-content:safe_center] bg-[var(--color-bg-secondary)]"
    >
      <div className="auth-step mb-6 flex items-center gap-2.5">
        <Logo className="h-9 w-9" />
        <span className="text-xl font-semibold">dosya.dev</span>
      </div>

      <div
        className="auth-step w-full max-w-sm rounded-xl border bg-[var(--color-bg)] p-8 shadow-sm"
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
          <h1 className="text-2xl font-semibold">{t("common.heading.twoFactorAuthentication")}</h1>
          <p className="mt-1 text-sm text-[var(--color-text-secondary)]">
            {isRecovery
              ? t("two-factor.label.enterOneOfYourRecoveryCodes")
              : method === "email"
                ? richText(t, "common.description.weSentA6DigitCodeToEmail", {}, {
                    email: <span className="font-medium text-[var(--color-text)]">{email}</span>,
                  })
                : t("two-factor.description.enterTheCodeFromYourAuthenticatorApp")}
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
              {isRecovery ? t("two-factor.label.recoveryCode") : t("common.label.verificationCode")}
            </label>
            {isRecovery ? (
              <input
                type="text"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                autoFocus
                placeholder={t("two-factor.placeholder.recoveryCodeFormat")}
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
            className="w-full rounded-lg px-4 py-2.5 text-sm font-medium text-[var(--color-primary-fg)] transition-colors disabled:opacity-50"
            style={{
              background: loading ? "var(--color-primary-hover)" : "var(--color-primary)",
            }}
          >
            {loading ? t("common.status.verifying") : t("two-factor.action.verify")}
          </button>
        </form>

        <div className="mt-4 text-center">
          {!isRecovery ? (
            <button
              onClick={() => { setIsRecovery(true); setCode(""); setError(""); }}
              className="text-xs text-[var(--color-text-muted)] hover:text-[var(--color-primary)]"
            >
              <KeyRound size={11} className="me-1 inline" />
              {t("two-factor.label.useARecoveryCodeInstead")}
            </button>
          ) : (
            <button
              onClick={() => { setIsRecovery(false); setCode(""); setError(""); }}
              className="text-xs text-[var(--color-text-muted)] hover:text-[var(--color-primary)]"
            >
              {method === "email" ? t("two-factor.label.backToEmailCode") : t("two-factor.label.backToAuthenticatorCode")}
            </button>
          )}
        </div>

        <button
          onClick={() => navigate("/login")}
          className="mt-4 flex w-full items-center justify-center gap-1.5 text-sm text-[var(--color-text-secondary)] hover:text-[var(--color-text)]"
        >
          <ArrowLeft size={14} className="rtl:-scale-x-100" />
          {t("common.action.backToSignIn")}
        </button>
      </div>
    </div>
  );
}
