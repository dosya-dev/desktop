import { useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api } from "@/lib/api-client";
import { authErrorMessage } from "@/lib/auth-error";
import { useOnClosedToTray } from "@/lib/use-closed-to-tray";
import { isValidEmail } from "@dosya-dev/shared";
import { ArrowLeft, Mail, CheckCircle2, KeyRound } from "lucide-react";
import { Logo } from "@/components/Logo";
import { useAuthDirection } from "@/lib/auth-direction";
import { useT } from "@/lib/i18n";
import { richText } from "@/lib/rich-text";
import { passwordError } from "@/lib/password-error";

type Step = "email" | "code" | "done";

export function ForgotPasswordPage() {
  const t = useT();
  const navigate = useNavigate();
  const [step, setStep] = useState<Step>("email");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  // Closing to the tray keeps this page alive: never leave a typed new
  // password, or a stale error, for whoever reopens the app (QA TC-004).
  useOnClosedToTray(() => {
    setNewPassword("");
    setConfirmPassword("");
    setError("");
  });

  // Step 1: Send code
  async function handleSendCode(e: FormEvent) {
    e.preventDefault();
    setError("");

    if (!isValidEmail(email)) {
      setError(t("common.error.pleaseEnterAValidEmailAddress"));
      return;
    }

    setLoading(true);
    try {
      await api.post("/api/auth/forgot-password-code", { email });
      setStep("code");
    } catch (err) {
      setError(authErrorMessage(err, t("common.error.anUnexpectedErrorOccurred")));
    } finally {
      setLoading(false);
    }
  }

  // Step 2: Verify code + set new password
  async function handleResetPassword(e: FormEvent) {
    e.preventDefault();
    setError("");

    if (code.length !== 6) {
      setError(t("common.error.pleaseEnterThe6DigitCode"));
      return;
    }

    const pwError = passwordError(newPassword);
    if (pwError) {
      setError(pwError);
      return;
    }

    if (newPassword !== confirmPassword) {
      setError(t("common.error.passwordsDonTMatch"));
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
      setError(authErrorMessage(err, t("common.error.anUnexpectedErrorOccurred")));
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
        {/* Step 1: Enter email */}
        {step === "email" && (
          <>
            <div className="mb-6 text-center">
              <h1 className="text-2xl font-semibold">{t("forgot-password.heading.forgotPassword")}</h1>
              <p className="mt-1 text-sm text-[var(--color-text-secondary)]">
                {t("forgot-password.description.enterYourEmailAndWeLlSendYouA")}
              </p>
            </div>

            {error && (
              <div className="mb-4 rounded-lg bg-red-50 px-4 py-3 text-sm text-red-600">{error}</div>
            )}

            <form onSubmit={handleSendCode} className="space-y-4">
              <div>
                <label className="mb-1 block text-sm font-medium">{t("common.label.email")}</label>
                <div className="relative">
                  <Mail size={16} className="absolute inset-s-3 top-1/2 -translate-y-1/2 text-[var(--color-text-muted)]" />
                  <input
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    required
                    autoFocus
                    className="w-full rounded-lg border py-2 ps-10 pe-3 text-sm outline-none focus:border-[var(--color-primary)] focus:ring-1 focus:ring-[var(--color-primary)]"
                    style={{ borderColor: "var(--color-border)" }}
                    placeholder={t("common.placeholder.youExampleCom")}
                  />
                </div>
              </div>

              <button
                type="submit"
                disabled={loading}
                className="w-full rounded-lg px-4 py-2.5 text-sm font-medium text-[var(--color-primary-fg)] transition-colors disabled:opacity-50"
                style={{ background: loading ? "var(--color-primary-hover)" : "var(--color-primary)" }}
              >
                {loading ? t("forgot-password.status.sendingCode") : t("forgot-password.action.sendResetCode")}
              </button>
            </form>

            <Link
              to="/login"
              className="mt-5 flex items-center justify-center gap-1.5 text-sm text-[var(--color-text-secondary)] hover:text-[var(--color-text)]"
            >
              <ArrowLeft size={14} className="rtl:-scale-x-100" />
              {t("common.action.backToSignIn")}
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
              <h1 className="text-2xl font-semibold">{t("forgot-password.heading.enterResetCode")}</h1>
              <p className="mt-1 text-sm text-[var(--color-text-secondary)]">
                {richText(t, "common.description.weSentA6DigitCodeToEmail", {}, {
                  email: <span className="font-medium text-[var(--color-text)]">{email}</span>,
                })}
              </p>
            </div>

            {error && (
              <div className="mb-4 rounded-lg bg-red-50 px-4 py-3 text-sm text-red-600">{error}</div>
            )}

            <form onSubmit={handleResetPassword} className="space-y-4">
              <div>
                <label className="mb-1 block text-sm font-medium">{t("common.label.sixDigitCode")}</label>
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
                <label className="mb-1 block text-sm font-medium">{t("common.label.newPassword")}</label>
                <input
                  type="password"
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  required
                  placeholder={t("common.placeholder.min8Characters")}
                  className="w-full rounded-lg border px-3 py-2 text-sm outline-none focus:border-[var(--color-primary)] focus:ring-1 focus:ring-[var(--color-primary)]"
                  style={{ borderColor: "var(--color-border)" }}
                />
              </div>

              <div>
                <label className="mb-1 block text-sm font-medium">{t("forgot-password.label.confirmPassword")}</label>
                <input
                  type="password"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  required
                  placeholder={t("forgot-password.placeholder.repeatYourPassword")}
                  className="w-full rounded-lg border px-3 py-2 text-sm outline-none focus:border-[var(--color-primary)] focus:ring-1 focus:ring-[var(--color-primary)]"
                  style={{ borderColor: "var(--color-border)" }}
                />
                <p className="mt-1 text-xs text-[var(--color-text-muted)]">
                  {t("common.description.atLeast8CharactersAMemorablePassphraseWorksWell")}
                </p>
              </div>

              <button
                type="submit"
                disabled={loading || code.length !== 6}
                className="w-full rounded-lg px-4 py-2.5 text-sm font-medium text-[var(--color-primary-fg)] transition-colors disabled:opacity-50"
                style={{ background: loading ? "var(--color-primary-hover)" : "var(--color-primary)" }}
              >
                {loading ? t("common.status.resetting") : t("forgot-password.action.resetPassword")}
              </button>
            </form>

            <button
              onClick={() => { setStep("email"); setCode(""); setError(""); }}
              className="mt-5 flex w-full items-center justify-center gap-1.5 text-sm text-[var(--color-text-secondary)] hover:text-[var(--color-text)]"
            >
              <ArrowLeft size={14} className="rtl:-scale-x-100" />
              {t("forgot-password.action.tryADifferentEmail")}
            </button>
          </>
        )}

        {/* Step 3: Success */}
        {step === "done" && (
          <div className="text-center">
            <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-[var(--color-primary)]/10">
              <CheckCircle2 size={24} className="text-[var(--color-primary)]" />
            </div>
            <h1 className="text-xl font-semibold">{t("forgot-password.heading.passwordReset")}</h1>
            <p className="mt-2 text-sm text-[var(--color-text-secondary)]">
              {t("forgot-password.description.yourPasswordHasBeenChangedSuccessfullyPleaseSignIn")}
            </p>
            <button
              onClick={() => navigate("/login")}
              className="mt-6 w-full rounded-lg px-4 py-2.5 text-sm font-medium text-[var(--color-primary-fg)] transition-colors"
              style={{ background: "var(--color-primary)" }}
            >
              {t("common.action.signIn")}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
