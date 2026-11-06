import { useEffect, useRef, useState, type FormEvent } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import { api } from "@/lib/api-client";
import { authErrorMessage } from "@/lib/auth-error";
import { Mail, ArrowLeft, CheckCircle2 } from "lucide-react";
import { Logo } from "@/components/Logo";
import { useAuthDirection } from "@/lib/auth-direction";
import { useT } from "@/lib/i18n";
import { richText } from "@/lib/rich-text";

export function VerifyPage() {
  const t = useT();
  const navigate = useNavigate();
  const location = useLocation();
  const routeState = location.state as { email?: unknown; fromSignIn?: unknown } | null;
  const emailFromState = typeof routeState?.email === "string" ? routeState.email : "";
  // Arrived from sign-in because the account was never verified: the code
  // from sign-up may be long gone, so a fresh one is sent on arrival.
  const fromSignIn = routeState?.fromSignIn === true;
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [loading, setLoading] = useState(false);
  const [resending, setResending] = useState(false);
  // Both endpoints accept the address in the body. Sending it means the
  // screen works without the pending-email cookie sign-up sets, which a
  // sign-in attempt does not.
  const emailBody = emailFromState ? { email: emailFromState } : {};

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError("");
    if (code.length !== 6) {
      setError(t("common.error.pleaseEnterThe6DigitCode"));
      return;
    }

    setLoading(true);
    try {
      await api.post("/api/auth/verify", { ...emailBody, code });
      navigate("/login", { state: { email: emailFromState, verified: true } });
    } catch (err) {
      setError(authErrorMessage(err, t("verify.error.couldNotVerifyYourEmail")));
    } finally {
      setLoading(false);
    }
  }

  // `announce` is false for the automatic send on arrival from sign-in: the
  // subtitle already says a new code is on its way.
  async function sendCode(announce: boolean) {
    setResending(true);
    setNotice("");
    try {
      await api.post("/api/auth/resend-verification", emailBody);
      setError("");
      if (announce) {
        setNotice(emailFromState
          ? t("verify.status.newCodeSentToEmail", { email: emailFromState })
          : t("verify.status.newCodeSent"));
      }
    } catch (err) {
      // Used to be swallowed, so a failed resend looked like a sent one.
      setError(authErrorMessage(err, t("verify.error.couldNotSendANewCode")));
    } finally {
      setResending(false);
    }
  }

  const autoSent = useRef(false);
  useEffect(() => {
    if (!fromSignIn || !emailFromState || autoSent.current) return;
    autoSent.current = true;
    void sendCode(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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

      <div className="auth-step w-full max-w-sm rounded-xl border bg-[var(--color-bg)] p-8 shadow-sm" style={{ borderColor: "var(--color-border)" }}>
        <div className="mb-6 text-center">
          <div className="mx-auto mb-3 flex h-10 w-10 items-center justify-center rounded-full bg-[var(--color-primary)]/10">
            <Mail size={20} className="text-[var(--color-primary)]" />
          </div>
          <h1 className="text-2xl font-semibold">{t("verify.heading.verifyYourEmail")}</h1>
          <p className="mt-1 text-sm text-[var(--color-text-secondary)]">
            {emailFromState && fromSignIn
              ? richText(t, "verify.description.notVerifiedYetNewCodeSent", {}, {
                  email: <span className="font-medium text-[var(--color-text)]">{emailFromState}</span>,
                })
              : emailFromState
              ? richText(t, "common.description.weSentA6DigitCodeToEmail", {}, {
                  email: <span className="font-medium text-[var(--color-text)]">{emailFromState}</span>,
                })
              : t("verify.label.weSentA6DigitCodeToYourEmail")}
          </p>
        </div>

        {error && (
          <div role="alert" className="mb-4 rounded-lg bg-red-50 px-4 py-3 text-sm text-red-600">{error}</div>
        )}
        {notice && !error && (
          <div role="status" className="mb-4 rounded-lg bg-green-50 px-4 py-3 text-sm text-green-700">{notice}</div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="mb-1 block text-sm font-medium">{t("common.label.verificationCode")}</label>
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
            className="w-full rounded-lg px-4 py-2.5 text-sm font-medium text-[var(--color-primary-fg)] transition-colors disabled:opacity-50"
            style={{ background: "var(--color-primary)" }}
          >
            {loading ? t("common.status.verifying") : t("verify.action.verifyEmail")}
          </button>
        </form>

        <div className="mt-4 text-center">
          <button
            onClick={() => void sendCode(true)}
            disabled={resending}
            className="text-xs text-[var(--color-text-muted)] hover:text-[var(--color-primary)]"
          >
            {resending ? t("common.status.sending") : t("verify.action.didnTReceiveTheCodeResend")}
          </button>
        </div>

        <button
          onClick={() => navigate("/login")}
          className="mt-4 flex w-full items-center justify-center gap-1.5 text-sm text-[var(--color-text-secondary)] hover:text-[var(--color-text)]"
        >
          <ArrowLeft size={14} className="rtl:-scale-x-100" /> {t("common.action.backToSignIn")}
        </button>
      </div>
    </div>
  );
}
