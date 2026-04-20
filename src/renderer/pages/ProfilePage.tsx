import { useState, useRef, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  User,
  Lock,
  Key,
  Monitor,
  Bell,
  Trash2,
  Pencil,
  Copy,
  Download,
  CreditCard,
  ExternalLink,
  HelpCircle,
  Shield,
  Smartphone,
  Laptop,
  Globe,
  AlertTriangle,
  Save,
  Eye,
  EyeOff,
  Info,
  RefreshCw,
  CheckCircle,
  Loader2,
  ArrowDownCircle,
  XCircle,
} from "lucide-react";
import { api, ApiError, apiRequest } from "@/lib/api-client";
import { useAuth } from "@/lib/auth-context";
import { formatDate } from "@/lib/format";
import { validatePassword } from "@dosya-dev/shared";
import { toast } from "sonner";

type Tab = "identity" | "password" | "api-keys" | "sessions" | "notifications" | "billing" | "about" | "help" | "delete";

const TABS: { id: Tab; label: string; icon: React.ReactNode; danger?: boolean }[] = [
  { id: "identity", label: "Identity", icon: <User size={16} /> },
  { id: "password", label: "Password & 2FA", icon: <Lock size={16} /> },
  { id: "api-keys", label: "API keys", icon: <Key size={16} /> },
  { id: "sessions", label: "Sessions", icon: <Monitor size={16} /> },
  { id: "notifications", label: "Notifications", icon: <Bell size={16} /> },
  { id: "billing", label: "Billing", icon: <CreditCard size={16} /> },
  { id: "about", label: "About", icon: <Info size={16} /> },
  { id: "help", label: "Help & Contact", icon: <HelpCircle size={16} /> },
  { id: "delete", label: "Delete account", icon: <AlertTriangle size={16} />, danger: true },
];

export function ProfilePage() {
  const { user, refreshUser } = useAuth();
  const queryClient = useQueryClient();
  const [tab, setTab] = useState<Tab>("identity");
  const [apiBase, setApiBase] = useState("");

  useEffect(() => {
    window.electronAPI.getApiBase().then(setApiBase);
  }, []);

  return (
    <div className="flex h-full gap-6">
      {/* Sidebar */}
      <div className="w-48 space-y-1">
        {TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-sm transition-colors ${
              tab === t.id
                ? t.danger
                  ? "bg-red-50 font-medium text-[var(--color-danger)]"
                  : "bg-[var(--color-primary)]/10 font-medium text-[var(--color-primary)]"
                : t.danger
                  ? "text-[var(--color-danger)] hover:bg-red-50"
                  : "text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-secondary)]"
            }`}
          >
            {t.icon}
            {t.label}
          </button>
        ))}
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto">
        {tab === "identity" && <IdentitySection apiBase={apiBase} />}
        {tab === "password" && <PasswordSection />}
        {tab === "api-keys" && <ApiKeysSection />}
        {tab === "sessions" && <SessionsSection />}
        {tab === "notifications" && <NotificationsSection />}
        {tab === "billing" && <BillingSection />}
        {tab === "about" && <AboutSection />}
        {tab === "help" && <HelpSection />}
        {tab === "delete" && <DeleteSection />}
      </div>
    </div>
  );
}

// ── Identity Section ────────────────────────────────────────────────

function IdentitySection({ apiBase }: { apiBase: string }) {
  const { user, refreshUser } = useAuth();
  const [name, setName] = useState(user?.name ?? "");
  const fileRef = useRef<HTMLInputElement>(null);

  // Email change state
  const [showEmailModal, setShowEmailModal] = useState(false);
  const [newEmail, setNewEmail] = useState("");
  const [emailPassword, setEmailPassword] = useState("");
  const [emailStep, setEmailStep] = useState<"request" | "verify">("request");
  const [verifyCode, setVerifyCode] = useState("");

  const nameMut = useMutation({
    mutationFn: () => api.put("/api/me/name", { name }),
    onSuccess: () => { refreshUser(); toast.success("Name updated"); },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : "Failed"),
  });

  const avatarMut = useMutation({
    mutationFn: (file: File) => {
      const fd = new FormData();
      fd.append("avatar", file);
      return apiRequest("/api/me/avatar", { method: "POST", body: fd });
    },
    onSuccess: () => { refreshUser(); toast.success("Avatar updated"); },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : "Failed"),
  });

  const deleteAvatarMut = useMutation({
    mutationFn: () => api.delete("/api/me/avatar"),
    onSuccess: () => { refreshUser(); toast.success("Avatar removed"); },
  });

  // Phase 1: request email change → sends code to new email
  const requestEmailMut = useMutation({
    mutationFn: () => api.put("/api/me/email", { email: newEmail, current_password: emailPassword }),
    onSuccess: () => {
      setEmailStep("verify");
      toast.success("Verification code sent to your new email");
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : "Failed"),
  });

  // Phase 2: verify 6-digit code → swaps email
  const confirmEmailMut = useMutation({
    mutationFn: () => api.post("/api/me/email/confirm", { code: verifyCode }),
    onSuccess: () => {
      refreshUser();
      setShowEmailModal(false);
      resetEmailModal();
      toast.success("Email address updated");
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : "Failed"),
  });

  function resetEmailModal() {
    setNewEmail("");
    setEmailPassword("");
    setVerifyCode("");
    setEmailStep("request");
  }

  return (
    <div className="max-w-lg space-y-6">
      <h2 className="text-lg font-semibold">Identity</h2>

      {/* Avatar */}
      <div className="flex items-center gap-5">
        <div className="relative group">
          {user?.avatar_url ? (
            <img
              src={`${apiBase}/api/me/avatar`}
              alt={user.name}
              className="h-20 w-20 rounded-full object-cover"
            />
          ) : (
            <div
              className="flex h-20 w-20 items-center justify-center rounded-full text-2xl font-semibold text-white"
              style={{ background: "var(--color-primary)" }}
            >
              {user?.name?.charAt(0).toUpperCase() || "?"}
            </div>
          )}
          <button
            onClick={() => fileRef.current?.click()}
            className="absolute inset-0 flex items-center justify-center rounded-full bg-black/40 text-white opacity-0 group-hover:opacity-100 transition-opacity"
          >
            <Pencil size={16} />
          </button>
          <input
            ref={fileRef}
            type="file"
            accept="image/png,image/jpeg,image/webp,image/gif"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) avatarMut.mutate(file);
              e.target.value = "";
            }}
          />
        </div>
        <div>
          <p className="text-sm font-medium">{user?.name}</p>
          <p className="text-xs text-[var(--color-text-muted)]">
            PNG, JPEG, WebP or GIF — max 2 MB
          </p>
          {user?.avatar_url && (
            <button
              onClick={() => deleteAvatarMut.mutate()}
              className="mt-1 text-xs text-[var(--color-danger)] hover:underline"
            >
              Remove avatar
            </button>
          )}
        </div>
      </div>

      {/* Name */}
      <div>
        <label className="mb-1 block text-sm font-medium">Full name</label>
        <div className="flex gap-2">
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={80}
            className="flex-1 rounded-lg border px-3 py-2 text-sm outline-none focus:border-[var(--color-primary)]"
            style={{ borderColor: "var(--color-border)" }}
          />
          <button
            onClick={() => nameMut.mutate()}
            disabled={!name.trim() || name === user?.name || nameMut.isPending}
            className="rounded-lg px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
            style={{ background: "var(--color-primary)" }}
          >
            {nameMut.isPending ? "Saving..." : "Save"}
          </button>
        </div>
      </div>

      {/* Email */}
      <div>
        <label className="mb-1 block text-sm font-medium">Email</label>
        <div className="flex gap-2">
          <input
            type="email"
            value={user?.email ?? ""}
            disabled
            className="flex-1 rounded-lg border bg-[var(--color-bg-secondary)] px-3 py-2 text-sm text-[var(--color-text-secondary)]"
            style={{ borderColor: "var(--color-border)" }}
          />
          <button
            onClick={() => setShowEmailModal(true)}
            className="rounded-lg border px-4 py-2 text-sm font-medium hover:bg-[var(--color-bg-secondary)]"
            style={{ borderColor: "var(--color-border)" }}
          >
            Change
          </button>
        </div>
      </div>

      {/* Member since */}
      <div className="rounded-lg bg-[var(--color-bg-secondary)] px-4 py-3 text-sm text-[var(--color-text-secondary)]">
        Member since {user?.created_at ? formatDate(user.created_at as unknown as number) : "—"}
      </div>

      {/* Change Email Modal */}
      {showEmailModal && (
        <Modal onClose={() => { setShowEmailModal(false); resetEmailModal(); }}>
          {emailStep === "request" ? (
            <>
              <h3 className="mb-2 text-lg font-semibold">Change email</h3>
              <p className="mb-4 text-sm text-[var(--color-text-secondary)]">
                A 6-digit verification code will be sent to your new email address.
              </p>
              <div className="space-y-3">
                <div>
                  <label className="mb-1 block text-sm font-medium">New email</label>
                  <input
                    type="email"
                    value={newEmail}
                    onChange={(e) => setNewEmail(e.target.value)}
                    autoFocus
                    placeholder="you@example.com"
                    className="w-full rounded-lg border px-3 py-2 text-sm outline-none focus:border-[var(--color-primary)]"
                    style={{ borderColor: "var(--color-border)" }}
                  />
                </div>
                <PasswordInput label="Current password" value={emailPassword} onChange={setEmailPassword} autoComplete="current-password" />
              </div>
              <div className="mt-5 flex justify-end gap-2">
                <button onClick={() => { setShowEmailModal(false); resetEmailModal(); }} className="rounded-lg border px-4 py-2 text-sm" style={{ borderColor: "var(--color-border)" }}>Cancel</button>
                <button
                  onClick={() => requestEmailMut.mutate()}
                  disabled={!newEmail.trim() || !emailPassword || requestEmailMut.isPending}
                  className="rounded-lg px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
                  style={{ background: "var(--color-primary)" }}
                >
                  {requestEmailMut.isPending ? "Sending..." : "Send code"}
                </button>
              </div>
            </>
          ) : (
            <>
              <h3 className="mb-2 text-lg font-semibold">Verify new email</h3>
              <p className="mb-4 text-sm text-[var(--color-text-secondary)]">
                Enter the 6-digit code sent to <span className="font-medium">{newEmail}</span>
              </p>
              <div>
                <label className="mb-1 block text-sm font-medium">Verification code</label>
                <input
                  type="text"
                  value={verifyCode}
                  onChange={(e) => setVerifyCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
                  maxLength={6}
                  autoFocus
                  placeholder="000000"
                  className="w-full rounded-lg border px-3 py-2 text-center text-lg font-mono tracking-[0.3em] outline-none focus:border-[var(--color-primary)]"
                  style={{ borderColor: "var(--color-border)" }}
                />
              </div>
              <div className="mt-5 flex justify-end gap-2">
                <button onClick={() => setEmailStep("request")} className="rounded-lg border px-4 py-2 text-sm" style={{ borderColor: "var(--color-border)" }}>Back</button>
                <button
                  onClick={() => confirmEmailMut.mutate()}
                  disabled={verifyCode.length !== 6 || confirmEmailMut.isPending}
                  className="rounded-lg px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
                  style={{ background: "var(--color-primary)" }}
                >
                  {confirmEmailMut.isPending ? "Verifying..." : "Verify & update"}
                </button>
              </div>
            </>
          )}
        </Modal>
      )}
    </div>
  );
}

// ── Password & 2FA Section ──────────────────────────────────────────

function PasswordSection() {
  const queryClient = useQueryClient();
  const [showPwModal, setShowPwModal] = useState(false);
  const [currentPw, setCurrentPw] = useState("");
  const [newPw, setNewPw] = useState("");
  const [confirmPw, setConfirmPw] = useState("");

  // 2FA state
  const [tfaModal, setTfaModal] = useState<"setup-totp" | "verify-totp" | "recovery" | "disable" | "regen" | null>(null);
  const [totpSecret, setTotpSecret] = useState("");
  const [totpUri, setTotpUri] = useState("");
  const [totpCode, setTotpCode] = useState("");
  const [recoveryCodes, setRecoveryCodes] = useState<string[]>([]);
  const [disablePw, setDisablePw] = useState("");
  const [regenPw, setRegenPw] = useState("");

  const { data: tfaStatus, refetch: refetchTfa } = useQuery({
    queryKey: ["2fa-status"],
    queryFn: () => api.get<{ ok: boolean; method: string | null; totp_enabled: boolean; recovery_codes_remaining: number }>("/api/me/2fa/status"),
  });

  const changePwMut = useMutation({
    mutationFn: () => api.put("/api/me/password", { current_password: currentPw, new_password: newPw }),
    onSuccess: () => {
      setShowPwModal(false); setCurrentPw(""); setNewPw(""); setConfirmPw("");
      toast.success("Password changed. Other sessions have been revoked.");
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : "Failed"),
  });

  const setupTotpMut = useMutation({
    mutationFn: () => api.post<{ ok: boolean; secret: string; uri: string }>("/api/me/2fa/setup-totp"),
    onSuccess: (data) => { setTotpSecret(data.secret); setTotpUri(data.uri); setTfaModal("verify-totp"); },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : "Failed"),
  });

  const verifyTotpMut = useMutation({
    mutationFn: () => api.post<{ ok: boolean; recovery_codes: string[] }>("/api/me/2fa/verify-totp", { code: totpCode }),
    onSuccess: (data) => { setRecoveryCodes(data.recovery_codes); setTotpCode(""); setTfaModal("recovery"); refetchTfa(); },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : "Invalid code"),
  });

  const enableEmailMut = useMutation({
    mutationFn: () => api.post("/api/me/2fa/enable-email"),
    onSuccess: () => { toast.success("Email-based 2FA enabled"); refetchTfa(); },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : "Failed"),
  });

  const disableMut = useMutation({
    mutationFn: () => api.post("/api/me/2fa/disable", { password: disablePw }),
    onSuccess: () => { setTfaModal(null); setDisablePw(""); toast.success("2FA disabled"); refetchTfa(); },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : "Failed"),
  });

  const regenMut = useMutation({
    mutationFn: () => api.post<{ ok: boolean; recovery_codes: string[] }>("/api/me/2fa/recovery-codes", { password: regenPw }),
    onSuccess: (data) => { setRecoveryCodes(data.recovery_codes); setRegenPw(""); setTfaModal("recovery"); },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : "Failed"),
  });

  const pwError = newPw ? validatePassword(newPw) : null;
  const mismatch = confirmPw && newPw !== confirmPw;

  return (
    <div className="max-w-lg space-y-6">
      <h2 className="text-lg font-semibold">Password & 2FA</h2>

      {/* Change password */}
      <div className="rounded-xl border p-5" style={{ borderColor: "var(--color-border)" }}>
        <h3 className="mb-1 text-sm font-semibold">Password</h3>
        <p className="mb-3 text-xs text-[var(--color-text-muted)]">Change your password. This will revoke all other sessions.</p>
        <button onClick={() => setShowPwModal(true)} className="rounded-lg border px-4 py-2 text-sm font-medium hover:bg-[var(--color-bg-secondary)]" style={{ borderColor: "var(--color-border)" }}>Change password</button>
      </div>

      {/* 2FA */}
      <div className="rounded-xl border p-5" style={{ borderColor: "var(--color-border)" }}>
        <h3 className="mb-3 text-sm font-semibold">Two-factor authentication</h3>

        {tfaStatus?.method ? (
          <div className="space-y-3">
            <div className="flex items-center gap-2 text-sm">
              <Shield size={16} className="text-[var(--color-primary)]" />
              <span className="font-medium">
                {tfaStatus.totp_enabled ? "Authenticator app enabled" : "Email-based 2FA enabled"}
              </span>
            </div>
            {tfaStatus.totp_enabled && (
              <p className="text-xs text-[var(--color-text-muted)]">
                {tfaStatus.recovery_codes_remaining} recovery codes remaining
              </p>
            )}
            <div className="flex gap-2">
              {tfaStatus.totp_enabled && (
                <button onClick={() => setTfaModal("regen")} className="rounded-lg border px-3 py-1.5 text-xs font-medium hover:bg-[var(--color-bg-secondary)]" style={{ borderColor: "var(--color-border)" }}>
                  Regenerate recovery codes
                </button>
              )}
              <button onClick={() => setTfaModal("disable")} className="rounded-lg border px-3 py-1.5 text-xs font-medium text-[var(--color-danger)] hover:bg-red-50" style={{ borderColor: "var(--color-border)" }}>
                Disable 2FA
              </button>
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            <p className="text-sm text-[var(--color-text-muted)]">2FA is not enabled. Enable it for extra security.</p>
            <div className="flex gap-2">
              <button onClick={() => setupTotpMut.mutate()} disabled={setupTotpMut.isPending} className="rounded-lg px-4 py-2 text-sm font-medium text-white disabled:opacity-50" style={{ background: "var(--color-primary)" }}>
                {setupTotpMut.isPending ? "Setting up..." : "Set up authenticator app"}
              </button>
              <button onClick={() => enableEmailMut.mutate()} disabled={enableEmailMut.isPending} className="rounded-lg border px-4 py-2 text-sm font-medium hover:bg-[var(--color-bg-secondary)]" style={{ borderColor: "var(--color-border)" }}>
                {enableEmailMut.isPending ? "Enabling..." : "Use email instead"}
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Change Password Modal */}
      {showPwModal && (
        <Modal onClose={() => setShowPwModal(false)}>
          <h3 className="mb-4 text-lg font-semibold">Change password</h3>
          <div className="space-y-3">
            <PasswordInput label="Current password" value={currentPw} onChange={setCurrentPw} autoComplete="current-password" />
            <div>
              <PasswordInput label="New password" value={newPw} onChange={setNewPw} autoComplete="new-password" />
              {pwError && <p className="mt-1 text-xs text-[var(--color-danger)]">{pwError}</p>}
            </div>
            <div>
              <PasswordInput label="Confirm new password" value={confirmPw} onChange={setConfirmPw} autoComplete="new-password" />
              {mismatch && <p className="mt-1 text-xs text-[var(--color-danger)]">Passwords don't match</p>}
            </div>
          </div>
          <div className="mt-5 flex justify-end gap-2">
            <button onClick={() => setShowPwModal(false)} className="rounded-lg border px-4 py-2 text-sm" style={{ borderColor: "var(--color-border)" }}>Cancel</button>
            <button onClick={() => changePwMut.mutate()} disabled={!currentPw || !newPw || !!pwError || mismatch || changePwMut.isPending} className="rounded-lg px-4 py-2 text-sm font-medium text-white disabled:opacity-50" style={{ background: "var(--color-primary)" }}>
              {changePwMut.isPending ? "Changing..." : "Change password"}
            </button>
          </div>
        </Modal>
      )}

      {/* TOTP Verify Modal */}
      {tfaModal === "verify-totp" && (
        <Modal onClose={() => setTfaModal(null)}>
          <h3 className="mb-2 text-lg font-semibold">Set up authenticator</h3>
          <p className="mb-4 text-sm text-[var(--color-text-secondary)]">
            Scan this QR code with your authenticator app (Google Authenticator, Authy, etc.), then enter the 6-digit code.
          </p>
          <div className="mb-4 flex justify-center rounded-lg bg-[var(--color-bg-tertiary)] p-4">
            <img src={`https://api.qrserver.com/v1/create-qr-code/?size=180x180&data=${encodeURIComponent(totpUri)}`} alt="QR Code" className="h-44 w-44" />
          </div>
          <details className="mb-4">
            <summary className="cursor-pointer text-xs text-[var(--color-text-muted)] hover:text-[var(--color-text)]">Can't scan? Enter key manually</summary>
            <div className="mt-2 flex items-center gap-2 rounded-lg bg-[var(--color-bg-tertiary)] px-3 py-2">
              <code className="flex-1 break-all text-xs font-mono">{totpSecret}</code>
              <button onClick={() => { navigator.clipboard.writeText(totpSecret); toast.success("Copied"); }} className="rounded p-1 hover:bg-black/5"><Copy size={12} /></button>
            </div>
          </details>
          <div className="mb-4">
            <label className="mb-1 block text-sm font-medium">6-digit code</label>
            <input type="text" value={totpCode} onChange={(e) => setTotpCode(e.target.value.replace(/\D/g, "").slice(0, 6))} maxLength={6} autoFocus placeholder="000000" className="w-full rounded-lg border px-3 py-2 text-center text-lg font-mono tracking-[0.3em] outline-none focus:border-[var(--color-primary)]" style={{ borderColor: "var(--color-border)" }} />
          </div>
          <div className="flex justify-end gap-2">
            <button onClick={() => setTfaModal(null)} className="rounded-lg border px-4 py-2 text-sm" style={{ borderColor: "var(--color-border)" }}>Cancel</button>
            <button onClick={() => verifyTotpMut.mutate()} disabled={totpCode.length !== 6 || verifyTotpMut.isPending} className="rounded-lg px-4 py-2 text-sm font-medium text-white disabled:opacity-50" style={{ background: "var(--color-primary)" }}>
              {verifyTotpMut.isPending ? "Verifying..." : "Verify & enable"}
            </button>
          </div>
        </Modal>
      )}

      {/* Recovery Codes Modal */}
      {tfaModal === "recovery" && (
        <Modal onClose={() => setTfaModal(null)}>
          <h3 className="mb-2 text-lg font-semibold">Recovery codes</h3>
          <p className="mb-4 text-sm text-[var(--color-text-secondary)]">
            Save these codes in a safe place. Each code can only be used once.
          </p>
          <div className="mb-4 grid grid-cols-2 gap-2 rounded-lg bg-[var(--color-bg-tertiary)] p-4">
            {recoveryCodes.map((code, i) => (
              <code key={i} className="text-sm font-mono">{code}</code>
            ))}
          </div>
          <div className="mb-4 flex gap-2">
            <button onClick={() => { navigator.clipboard.writeText(recoveryCodes.join("\n")); toast.success("Copied all"); }} className="flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-medium hover:bg-[var(--color-bg-secondary)]" style={{ borderColor: "var(--color-border)" }}>
              <Copy size={12} /> Copy all
            </button>
            <button onClick={() => {
              const blob = new Blob([recoveryCodes.join("\n")], { type: "text/plain" });
              const url = URL.createObjectURL(blob);
              const a = document.createElement("a"); a.href = url; a.download = "dosya-recovery-codes.txt"; a.click();
              URL.revokeObjectURL(url);
            }} className="flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-medium hover:bg-[var(--color-bg-secondary)]" style={{ borderColor: "var(--color-border)" }}>
              <Download size={12} /> Download
            </button>
          </div>
          <button onClick={() => setTfaModal(null)} className="w-full rounded-lg px-4 py-2 text-sm font-medium text-white" style={{ background: "var(--color-primary)" }}>
            I've saved these codes
          </button>
        </Modal>
      )}

      {/* Disable 2FA Modal */}
      {tfaModal === "disable" && (
        <Modal onClose={() => { setTfaModal(null); setDisablePw(""); }}>
          <h3 className="mb-2 text-lg font-semibold">Disable 2FA</h3>
          <p className="mb-4 text-sm text-[var(--color-text-secondary)]">Enter your password to disable two-factor authentication.</p>
          <PasswordInput label="Password" value={disablePw} onChange={setDisablePw} autoComplete="current-password" />
          <div className="mt-4 flex justify-end gap-2">
            <button onClick={() => { setTfaModal(null); setDisablePw(""); }} className="rounded-lg border px-4 py-2 text-sm" style={{ borderColor: "var(--color-border)" }}>Cancel</button>
            <button onClick={() => disableMut.mutate()} disabled={!disablePw || disableMut.isPending} className="rounded-lg bg-[var(--color-danger)] px-4 py-2 text-sm font-medium text-white disabled:opacity-50">
              {disableMut.isPending ? "Disabling..." : "Disable 2FA"}
            </button>
          </div>
        </Modal>
      )}

      {/* Regenerate Recovery Codes Modal */}
      {tfaModal === "regen" && (
        <Modal onClose={() => { setTfaModal(null); setRegenPw(""); }}>
          <h3 className="mb-2 text-lg font-semibold">Regenerate recovery codes</h3>
          <p className="mb-4 text-sm text-[var(--color-text-secondary)]">This will invalidate your existing codes. Enter your password to continue.</p>
          <PasswordInput label="Password" value={regenPw} onChange={setRegenPw} autoComplete="current-password" />
          <div className="mt-4 flex justify-end gap-2">
            <button onClick={() => { setTfaModal(null); setRegenPw(""); }} className="rounded-lg border px-4 py-2 text-sm" style={{ borderColor: "var(--color-border)" }}>Cancel</button>
            <button onClick={() => regenMut.mutate()} disabled={!regenPw || regenMut.isPending} className="rounded-lg px-4 py-2 text-sm font-medium text-white disabled:opacity-50" style={{ background: "var(--color-primary)" }}>
              {regenMut.isPending ? "Regenerating..." : "Regenerate codes"}
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}

// ── API Keys Section ────────────────────────────────────────────────

function ApiKeysSection() {
  return (
    <div className="max-w-lg space-y-6">
      <h2 className="text-lg font-semibold">API keys</h2>
      <div className="rounded-xl border p-6 text-center" style={{ borderColor: "var(--color-border)" }}>
        <Key size={32} className="mx-auto mb-3 text-[var(--color-text-muted)]" />
        <h3 className="text-sm font-semibold">Manage API keys</h3>
        <p className="mt-1 text-sm text-[var(--color-text-secondary)]">
          Generate and manage API keys on the web app.
        </p>
        <button
          onClick={() => window.open("https://dosya.dev/profile", "_blank")}
          className="mt-4 inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-medium text-white"
          style={{ background: "var(--color-primary)" }}
        >
          <ExternalLink size={14} />
          Open on web
        </button>
      </div>
    </div>
  );
}

// ── Sessions Section ────────────────────────────────────────────────

function SessionsSection() {
  const queryClient = useQueryClient();

  const { data, isLoading } = useQuery({
    queryKey: ["sessions"],
    queryFn: () => api.get<{ ok: boolean; sessions: { id: string; device: string; kind: string; browser: string; meta: string; is_current: boolean; created_at: number }[] }>("/api/me/sessions"),
  });

  const revokeMut = useMutation({
    mutationFn: (id: string) => api.delete(`/api/me/sessions/${id}`),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ["sessions"] }); toast.success("Session revoked"); },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : "Failed"),
  });

  const revokeAllMut = useMutation({
    mutationFn: () => api.delete("/api/me/sessions"),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ["sessions"] }); toast.success("All other sessions revoked"); },
  });

  const sessions = data?.sessions ?? [];
  const DeviceIcon = ({ kind }: { kind: string }) => {
    if (kind === "mobile") return <Smartphone size={18} className="text-[var(--color-text-muted)]" />;
    if (kind === "desktop") return <Laptop size={18} className="text-[var(--color-text-muted)]" />;
    return <Globe size={18} className="text-[var(--color-text-muted)]" />;
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">Sessions</h2>
        {sessions.length > 1 && (
          <button onClick={() => revokeAllMut.mutate()} className="text-xs text-[var(--color-danger)] hover:underline">
            Revoke all other sessions
          </button>
        )}
      </div>

      {isLoading ? (
        <div className="space-y-2">{[1,2,3].map(i => <div key={i} className="h-16 animate-pulse rounded-lg bg-[var(--color-bg-tertiary)]" />)}</div>
      ) : (
        <div className="space-y-2">
          {sessions.map((s) => (
            <div key={s.id} className="flex items-center gap-4 rounded-xl border px-4 py-3" style={{ borderColor: "var(--color-border)" }}>
              <DeviceIcon kind={s.kind} />
              <div className="flex-1">
                <div className="flex items-center gap-2">
                  <p className="text-sm font-medium">{s.device} — {s.browser}</p>
                  {s.is_current && (
                    <span className="rounded-full bg-[var(--color-primary)]/10 px-2 py-0.5 text-xs font-medium text-[var(--color-primary)]">Current</span>
                  )}
                </div>
                <p className="text-xs text-[var(--color-text-muted)]">{s.meta}</p>
              </div>
              {!s.is_current && (
                <button onClick={() => revokeMut.mutate(s.id)} className="rounded p-1.5 text-[var(--color-text-muted)] hover:text-[var(--color-danger)]"><Trash2 size={14} /></button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Notifications Section ───────────────────────────────────────────

const NOTIFICATION_GROUPS = [
  {
    label: "Security & Account",
    prefs: [
      { key: "security_new_login", label: "New login from unknown device" },
      { key: "security_failed_attempts", label: "Failed login attempts" },
      { key: "security_password_changed", label: "Password changed" },
    ],
  },
  {
    label: "Files & Sharing",
    prefs: [
      { key: "files_uploaded", label: "File uploaded to workspace" },
      { key: "files_downloaded", label: "Shared file downloaded" },
      { key: "files_share_expiring", label: "Share link expiring soon" },
    ],
  },
  {
    label: "File Requests",
    prefs: [
      { key: "requests_new_upload", label: "New upload to your request" },
      { key: "requests_expiring", label: "File request expiring" },
    ],
  },
  {
    label: "Collaboration",
    prefs: [
      { key: "collab_new_comment", label: "New comment on your file" },
      { key: "collab_comment_reply", label: "Reply to your comment" },
      { key: "collab_member_joined", label: "New member joined workspace" },
    ],
  },
  {
    label: "Billing & Storage",
    prefs: [
      { key: "billing_payment_failed", label: "Payment failed" },
      { key: "billing_storage_warning", label: "Storage limit warning" },
      { key: "billing_renewal", label: "Subscription renewal reminder" },
    ],
  },
];

function NotificationsSection() {
  const [prefs, setPrefs] = useState<Record<string, boolean>>({});
  const loaded = useRef(false);

  const { data } = useQuery({
    queryKey: ["notification-prefs"],
    queryFn: () => api.get<{ ok: boolean; preferences: Record<string, boolean> }>("/api/me/notifications"),
  });

  if (data?.preferences && !loaded.current) {
    setPrefs(data.preferences);
    loaded.current = true;
  }

  const saveMut = useMutation({
    mutationFn: (updated: Record<string, boolean>) => api.put("/api/me/notifications", { preferences: updated }),
    onSuccess: () => toast.success("Preferences saved"),
  });

  const toggle = (key: string) => {
    const updated = { ...prefs, [key]: !prefs[key] };
    setPrefs(updated);
    saveMut.mutate(updated);
  };

  return (
    <div className="max-w-lg space-y-6">
      <h2 className="text-lg font-semibold">Notifications</h2>
      {NOTIFICATION_GROUPS.map((group) => (
        <div key={group.label}>
          <h3 className="mb-3 text-sm font-semibold text-[var(--color-text-secondary)]">{group.label}</h3>
          <div className="space-y-2">
            {group.prefs.map((p) => (
              <div key={p.key} className="flex items-center justify-between rounded-lg px-1 py-1.5">
                <span className="text-sm">{p.label}</span>
                <button
                  onClick={() => toggle(p.key)}
                  className={`relative h-6 w-11 shrink-0 rounded-full transition-colors ${prefs[p.key] ? "bg-[var(--color-primary)]" : "bg-[var(--color-border)]"}`}
                >
                  <div className={`absolute top-0.5 h-5 w-5 rounded-full bg-[var(--color-bg)] shadow transition-transform ${prefs[p.key] ? "translate-x-5" : "translate-x-0.5"}`} />
                </button>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

// ── Delete Account Section ──────────────────────────────────────────

// ── Billing Section ──────────────────────────────────────────────────

function BillingSection() {
  const openBilling = () => {
    window.open("https://dosya.dev/billing", "_blank");
  };

  return (
    <div className="max-w-lg space-y-6">
      <h2 className="text-lg font-semibold">Billing</h2>
      <div className="rounded-xl border p-6 text-center" style={{ borderColor: "var(--color-border)" }}>
        <CreditCard size={32} className="mx-auto mb-3 text-[var(--color-text-muted)]" />
        <h3 className="text-sm font-semibold">Manage your subscription</h3>
        <p className="mt-1 text-sm text-[var(--color-text-secondary)]">
          Billing, invoices, and plan management are available on the web.
        </p>
        <button
          onClick={openBilling}
          className="mt-4 inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-medium text-white"
          style={{ background: "var(--color-primary)" }}
        >
          <ExternalLink size={14} />
          Open billing on web
        </button>
      </div>
    </div>
  );
}

// ── Help Section ─────────────────────────────────────────────────────

function HelpSection() {
  return (
    <div className="max-w-lg space-y-4">
      <h2 className="text-lg font-semibold">Help & Contact</h2>
      {[
        { label: "Help Center", desc: "Browse guides and FAQs", url: "https://dosya.dev/help" },
        { label: "Contact Support", desc: "Get in touch with our team", url: "https://dosya.dev/contact" },
        { label: "API Documentation", desc: "Developer docs and API reference", url: "https://dosya.dev/developer/api" },
        { label: "Privacy Policy", desc: "How we handle your data", url: "https://dosya.dev/privacy-policy" },
        { label: "Terms of Service", desc: "Our terms and conditions", url: "https://dosya.dev/terms-of-service" },
      ].map((item) => (
        <button
          key={item.url}
          onClick={() => window.open(item.url, "_blank")}
          className="flex w-full items-center justify-between rounded-xl border p-4 text-left hover:bg-[var(--color-bg-secondary)] transition-colors"
          style={{ borderColor: "var(--color-border)" }}
        >
          <div>
            <p className="text-sm font-medium">{item.label}</p>
            <p className="text-xs text-[var(--color-text-muted)]">{item.desc}</p>
          </div>
          <ExternalLink size={14} className="text-[var(--color-text-muted)]" />
        </button>
      ))}
    </div>
  );
}

// ── Delete Account Section ──────────────────────────────────────────

function DeleteSection() {
  return (
    <div className="max-w-lg space-y-6">
      <h2 className="text-lg font-semibold">Danger zone</h2>

      <div className="rounded-xl border-2 border-dashed p-6" style={{ borderColor: "var(--color-danger)" }}>
        <h3 className="mb-2 font-semibold text-[var(--color-danger)]">Delete account</h3>
        <p className="mb-4 text-sm text-[var(--color-text-secondary)]">
          Permanently delete your account and all owned workspaces. This action cannot be undone.
        </p>
        <button className="rounded-lg bg-[var(--color-danger)] px-4 py-2 text-sm font-medium text-white">
          Delete my account
        </button>
      </div>
    </div>
  );
}

// ── About Section ───────────────────────────────────────────────────

type UpdateStatus =
  | { state: "idle" }
  | { state: "checking" }
  | { state: "available"; version: string }
  | { state: "downloading"; percent: number }
  | { state: "ready"; version: string }
  | { state: "error"; message: string }
  | { state: "not-available" };

function AboutSection() {
  const [version, setVersion] = useState("");
  const [platform, setPlatform] = useState<string>("");
  const [status, setStatus] = useState<UpdateStatus>({ state: "idle" });

  useEffect(() => {
    window.electronAPI.getAppVersion().then(setVersion);
    window.electronAPI.getPlatform().then((p) => setPlatform(p));
    window.electronAPI.getUpdateStatus().then(setStatus);
    return window.electronAPI.onUpdateStatusChanged(setStatus);
  }, []);

  const isLinux = platform === "linux";

  return (
    <div className="max-w-lg space-y-6">
      <h2 className="text-lg font-semibold">About</h2>

      {/* Version & Update */}
      <div className="rounded-xl border p-5" style={{ borderColor: "var(--color-border)" }}>
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-sm font-semibold">dosya desktop</h3>
            <p className="mt-0.5 text-xs text-[var(--color-text-muted)]">
              Version {version || "—"}
            </p>
          </div>

          {status.state === "ready" ? (
            isLinux ? (
              <button
                onClick={() => window.electronAPI.showUpdateFile()}
                className="flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-medium text-white"
                style={{ background: "var(--color-primary)" }}
              >
                <ExternalLink size={14} />
                Show downloaded file
              </button>
            ) : (
              <button
                onClick={() => window.electronAPI.installUpdate()}
                className="flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-medium text-white"
                style={{ background: "var(--color-primary)" }}
              >
                <ArrowDownCircle size={14} />
                Install & Restart
              </button>
            )
          ) : status.state === "checking" ? (
            <button disabled className="flex items-center gap-2 rounded-lg border px-4 py-2 text-sm text-[var(--color-text-muted)]" style={{ borderColor: "var(--color-border)" }}>
              <Loader2 size={14} className="animate-spin" />
              Checking...
            </button>
          ) : status.state === "downloading" ? (
            <button disabled className="flex items-center gap-2 rounded-lg border px-4 py-2 text-sm text-[var(--color-text-muted)]" style={{ borderColor: "var(--color-border)" }}>
              <Loader2 size={14} className="animate-spin" />
              Downloading {status.percent}%
            </button>
          ) : (
            <button
              onClick={() => window.electronAPI.checkForUpdates()}
              className="flex items-center gap-2 rounded-lg border px-4 py-2 text-sm font-medium hover:bg-[var(--color-bg-secondary)]"
              style={{ borderColor: "var(--color-border)" }}
            >
              <RefreshCw size={14} />
              Check for updates
            </button>
          )}
        </div>

        {/* Status message */}
        {status.state === "ready" && (
          <div className="mt-3 flex items-center gap-2 rounded-lg bg-[var(--color-primary)]/10 px-3 py-2 text-sm text-[var(--color-primary)]">
            <ArrowDownCircle size={14} />
            {isLinux
              ? `Version ${status.version} downloaded — open the file to install manually`
              : `Version ${status.version} is ready to install`}
          </div>
        )}
        {status.state === "not-available" && (
          <div className="mt-3 flex items-center gap-2 rounded-lg bg-green-50 px-3 py-2 text-sm text-green-700">
            <CheckCircle size={14} />
            You're on the latest version
          </div>
        )}
        {status.state === "error" && (
          <div className="mt-3 flex items-center gap-2 rounded-lg bg-red-50 px-3 py-2 text-sm text-[var(--color-danger)]">
            <XCircle size={14} />
            Update failed: {status.message}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Shared Components ───────────────────────────────────────────────

function Modal({ children, onClose }: { children: React.ReactNode; onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30">
      <div className="w-full max-w-md rounded-xl bg-[var(--color-bg)] p-6 shadow-xl" onClick={(e) => e.stopPropagation()}>
        {children}
      </div>
      <div className="fixed inset-0 -z-10" onClick={onClose} />
    </div>
  );
}

function PasswordInput({ label, value, onChange, autoComplete }: { label: string; value: string; onChange: (v: string) => void; autoComplete?: string }) {
  const [show, setShow] = useState(false);
  return (
    <div>
      <label className="mb-1 block text-sm font-medium">{label}</label>
      <div className="relative">
        <input
          type={show ? "text" : "password"}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          autoComplete={autoComplete}
          className="w-full rounded-lg border px-3 py-2 pr-10 text-sm outline-none focus:border-[var(--color-primary)]"
          style={{ borderColor: "var(--color-border)" }}
        />
        <button type="button" onClick={() => setShow(!show)} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-[var(--color-text-muted)]">
          {show ? <EyeOff size={16} /> : <Eye size={16} />}
        </button>
      </div>
    </div>
  );
}
