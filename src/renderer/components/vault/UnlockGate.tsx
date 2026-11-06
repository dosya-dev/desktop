import { useEffect, useState } from "react";
import { Lock, ShieldCheck, KeyRound, TriangleAlert, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { useVault, vaultErrorDir } from "@/lib/vault/store";
import { useAuth } from "@/lib/auth-context";
import { api, ApiError } from "@/lib/api-client";
import { Modal } from "@/components/files/Modal";
import { useT } from "@/lib/i18n";
import { Notice, VaultButton, VaultCard, VaultInput, VaultLabel } from "./ui";

/**
 * Shown whenever the Vault is not unlocked. Binds the persisted Space list to
 * the signed-in account, asks the store whether an identity exists, then
 * renders Setup (none), Unlock (one) or Retry (could not tell). Never renders
 * or logs a passphrase or recovery key anywhere but its own fields.
 */
export function UnlockGate() {
  const t = useT();
  const { user } = useAuth();
  const hasIdentity = useVault((s) => s.hasIdentity);
  const error = useVault((s) => s.error);
  const bindOwner = useVault((s) => s.bindOwner);
  const checkIdentity = useVault((s) => s.checkIdentity);

  useEffect(() => {
    if (user) bindOwner(user.id);
    checkIdentity();
    // Once per mount; both are stable store actions.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="mx-auto flex w-full max-w-sm flex-col items-center px-4 py-12">
      <div className="mb-6 flex flex-col items-center gap-2 text-center">
        <div className="flex h-10 w-10 items-center justify-center rounded-full bg-[var(--color-primary)]/10 text-[var(--color-primary)]">
          <Lock size={20} />
        </div>
        <h1 className="text-lg font-semibold text-[var(--color-text)]">Vault</h1>
        <p className="text-xs text-[var(--color-text-secondary)]">
          {t("vault.description.yourFilesAreEncryptedOnThisComputerBeforeThey")}
        </p>
        <a
          href="https://dosya.dev/vault"
          target="_blank"
          rel="noopener noreferrer"
          className="text-xs font-medium text-[var(--color-primary)] underline underline-offset-2 hover:opacity-80"
        >
          {t("vault.action.whatIsVaultLearnMore")}
        </a>
      </div>

      {/* hasIdentity is null while checking OR when the check failed. Only
          the latter carries `error`. Never fall through to Setup here. */}
      {hasIdentity === null && error && (
        <VaultCard>
          <div data-testid="vault-retry">
            <h2 className="mb-3 text-sm font-semibold">{t("vault.error.couldnTCheckEncryptionStatus")}</h2>
            <Notice tone="warn" icon={<TriangleAlert size={14} />}>
              <p dir={vaultErrorDir(error)}>{error}</p>
              <button type="button" onClick={() => checkIdentity()} className="mt-1 font-medium underline underline-offset-2">{t("common.retry")}</button>
            </Notice>
          </div>
        </VaultCard>
      )}

      {hasIdentity === null && !error && (
        <VaultCard>
          <div className="space-y-3" data-testid="vault-checking">
            <div className="h-4 w-40 animate-pulse rounded bg-[var(--color-bg-secondary)]" />
            <div className="h-8 w-full animate-pulse rounded bg-[var(--color-bg-secondary)]" />
            <div className="h-8 w-full animate-pulse rounded bg-[var(--color-bg-secondary)]" />
          </div>
        </VaultCard>
      )}

      {hasIdentity === false && <SetupCard error={error} />}
      {hasIdentity === true && <UnlockCard error={error} />}
    </div>
  );
}

/** The Vault setup form (also on the Personas first run, components/personas/FirstRun). */
export function SetupCard({ error }: { error: string | null }) {
  const t = useT();
  const setup = useVault((s) => s.setup);
  const busy = useVault((s) => s.busy);
  const [pass, setPass] = useState("");
  const [confirm, setConfirm] = useState("");
  const [confirmTouched, setConfirmTouched] = useState(false);
  const mismatch = confirmTouched && confirm.length > 0 && pass !== confirm;
  const canSubmit = pass.length > 0 && pass === confirm && !busy;

  return (
    <VaultCard>
      <form
        data-testid="vault-setup"
        onSubmit={(e) => { e.preventDefault(); if (canSubmit) setup(pass); }}
        className="space-y-3"
      >
        <div>
          <h2 className="flex items-center gap-2 text-sm font-semibold"><ShieldCheck size={16} className="text-[var(--color-primary)]" /> {t("vault.heading.setUpEncryption")}</h2>
          <p className="mt-1 text-xs text-[var(--color-text-secondary)]">{t("vault.description.chooseAPassphraseToProtectYourVault")}</p>
        </div>
        {error && <p dir={vaultErrorDir(error)} className="text-xs text-[var(--color-danger)]">{error}</p>}
        <div>
          <VaultLabel htmlFor="vault-setup-pass">{t("vault.label.passphrase")}</VaultLabel>
          <VaultInput id="vault-setup-pass" type="password" autoComplete="new-password" value={pass}
            onChange={(e) => setPass(e.target.value)} placeholder={t("vault.placeholder.enterAStrongPassphrase")} disabled={busy} />
        </div>
        <div>
          <VaultLabel htmlFor="vault-setup-confirm">{t("vault.label.confirmPassphrase")}</VaultLabel>
          <VaultInput id="vault-setup-confirm" type="password" autoComplete="new-password" value={confirm}
            onChange={(e) => setConfirm(e.target.value)} onBlur={() => setConfirmTouched(true)}
            placeholder={t("vault.placeholder.reEnterYourPassphrase")} disabled={busy} />
          {mismatch && <p className="mt-1 text-xs text-[var(--color-danger)]">{t("vault.error.passphrasesDoNotMatch")}</p>}
        </div>
        <Notice tone="danger">
          {t("vault.description.ifYouLoseThisPassphraseAndYourRecoveryKey")}
        </Notice>
        <VaultButton type="submit" className="w-full justify-center" disabled={!canSubmit} data-testid="vault-setup-submit">
          {busy ? t("vault.status.settingUp") : t("vault.action.setUp")}
        </VaultButton>
      </form>
    </VaultCard>
  );
}

/** The Vault unlock form, passphrase or recovery key (also on the Personas first run). */
export function UnlockCard({ error }: { error: string | null }) {
  const t = useT();
  const status = useVault((s) => s.status);
  const unlock = useVault((s) => s.unlock);
  const unlockWithRecoveryKey = useVault((s) => s.unlockWithRecoveryKey);
  const [pass, setPass] = useState("");
  const [mode, setMode] = useState<"passphrase" | "recovery">("passphrase");
  const [recoveryKey, setRecoveryKey] = useState("");
  const [destroyOpen, setDestroyOpen] = useState(false);
  const unlocking = status === "unlocking";
  const canSubmit = mode === "recovery" ? recoveryKey.trim().length > 0 : pass.length > 0;

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (unlocking || !canSubmit) return;
    if (mode === "recovery") unlockWithRecoveryKey(recoveryKey.trim());
    else unlock(pass);
  };

  return (
    <>
      <VaultCard>
        <form data-testid="vault-unlock" onSubmit={submit} className="space-y-3">
          <div>
            <h2 className="flex items-center gap-2 text-sm font-semibold">
              {mode === "recovery"
                ? <><KeyRound size={16} className="text-[var(--color-primary)]" /> {t("vault.heading.unlockWithRecoveryKey")}</>
                : <><Lock size={16} className="text-[var(--color-primary)]" /> {t("vault.heading.unlockVault")}</>}
            </h2>
            <p className="mt-1 text-xs text-[var(--color-text-secondary)]">
              {mode === "recovery"
                ? t("vault.description.pasteTheRecoveryKeyYouSavedWhenYouSet")
                : t("vault.description.enterYourPassphraseToDecryptYourFilesOnThis")}
            </p>
          </div>
          {error && <p dir={vaultErrorDir(error)} className="text-xs text-[var(--color-danger)]">{error}</p>}
          {mode === "recovery" ? (
            <div>
              <VaultLabel htmlFor="vault-recovery-key">{t("vault.label.recoveryKey")}</VaultLabel>
              <VaultInput id="vault-recovery-key" type="text" dir="ltr" autoComplete="off" spellCheck={false} autoFocus
                value={recoveryKey} onChange={(e) => setRecoveryKey(e.target.value)} disabled={unlocking}
                placeholder={t("vault.placeholder.yourRecoveryKey")} className="ltr-value font-mono" />
            </div>
          ) : (
            <div>
              <VaultLabel htmlFor="vault-unlock-pass">{t("vault.label.passphrase")}</VaultLabel>
              <VaultInput id="vault-unlock-pass" type="password" autoComplete="current-password" autoFocus
                value={pass} onChange={(e) => setPass(e.target.value)} disabled={unlocking}
                placeholder={t("vault.placeholder.yourEncryptionPassphrase")} />
            </div>
          )}
          <VaultButton type="submit" className="w-full justify-center" disabled={unlocking || !canSubmit} data-testid="vault-unlock-submit">
            {unlocking ? t("vault.status.unlocking") : t("common.action.unlock")}
          </VaultButton>
          <div className="flex items-center justify-between text-xs">
            <button type="button" data-testid="vault-recovery-toggle" disabled={unlocking}
              className="text-[var(--color-text-secondary)] underline underline-offset-2 hover:text-[var(--color-text)]"
              onClick={() => setMode(mode === "recovery" ? "passphrase" : "recovery")}>
              {mode === "recovery" ? t("vault.action.usePassphrase") : t("vault.action.useRecoveryKey")}
            </button>
            <button type="button" data-testid="vault-destroy" disabled={unlocking}
              className="text-[var(--color-danger)]/80 underline underline-offset-2 hover:text-[var(--color-danger)]"
              onClick={() => setDestroyOpen(true)}>
              {t("vault.action.destroyVaultAndStartOver")}
            </button>
          </div>
        </form>
      </VaultCard>
      {destroyOpen && <DestroyVaultModal onClose={() => setDestroyOpen(false)} />}
    </>
  );
}

/**
 * Last resort for a Vault whose passphrase and recovery key are both lost:
 * delete the identity so setup can run again. Everything encrypted under it is
 * unrecoverable afterwards, said in plain words before the button. Confirmed
 * with the account password, or - for an Apple or Google sign-in account,
 * which has no password, and an email-code 2FA account, which the password
 * path refuses - a code mailed to the account address. An authenticator-app
 * account also gives its 2FA code either way.
 */
function DestroyVaultModal({ onClose }: { onClose: () => void }) {
  const t = useT();
  const { user } = useAuth();
  const destroyIdentity = useVault((s) => s.destroyIdentity);
  const busy = useVault((s) => s.busy);
  const [twoFaMethod, setTwoFaMethod] = useState<string | null>(null);
  const [password, setPassword] = useState("");
  const [emailCode, setEmailCode] = useState("");
  const [codeSent, setCodeSent] = useState(false);
  const [forceEmailCode, setForceEmailCode] = useState(false);
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [needsCode, setNeedsCode] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  // Whether this dialog's own attempt failed. The sentence is read from the
  // store, which says it again in the new language after a switch.
  const [failed, setFailed] = useState(false);
  const storeError = useVault((s) => s.error);
  const localError = sendError ?? (failed ? storeError : null);
  const useEmailCode = forceEmailCode || user?.has_password === false || twoFaMethod === "email";

  useEffect(() => {
    let cancelled = false;
    api.get<{ ok: boolean; method: string | null }>("/api/me/2fa/status")
      .then((r) => {
        if (cancelled) return;
        setTwoFaMethod(r.method);
        setNeedsCode(r.method === "totp");
      })
      .catch(() => { /* the server still refuses without a code; the field appears after the first refusal */ });
    return () => { cancelled = true; };
  }, []);

  const sendCode = async () => {
    if (sending || busy) return;
    setSending(true);
    setSendError(null);
    try {
      await api.post("/api/e2ee/destroy-request", {});
      if (codeSent) toast.success(t("verify.status.newCodeSent"));
      setCodeSent(true);
    } catch (e) {
      setSendError(e instanceof Error ? e.message : String(e));
      // 429 within the cooldown means a code from a moment ago is still live
      // (the dialog was closed and reopened): let them type that one.
      if (e instanceof ApiError && e.status === 429) setCodeSent(true);
    } finally {
      setSending(false);
    }
  };

  const proofReady = useEmailCode ? emailCode.length === 6 : password.length > 0;

  const submit = async () => {
    if (!proofReady || busy) return;
    setFailed(false);
    setSendError(null);
    const ok = await destroyIdentity(useEmailCode ? { code: emailCode } : password, needsCode && code ? code : undefined);
    if (ok) {
      toast.success(t("vault.label.vaultDestroyed"), { description: t("vault.description.setUpEncryptionAgainWheneverYouAreReady") });
      onClose();
      return;
    }
    const { destroyNeedsCode, destroyNeedsEmailCode } = useVault.getState();
    setFailed(true);
    // From the server's answer, not the sentence: that is in the chosen language.
    if (destroyNeedsEmailCode) setForceEmailCode(true);
    if (destroyNeedsCode) setNeedsCode(true);
  };

  return (
    <Modal onClose={() => { if (!busy) onClose(); }}>
      <div className="space-y-3" data-testid="vault-destroy-modal">
        <h2 className="flex items-center gap-2 text-base font-semibold text-[var(--color-danger)]"><Trash2 size={16} /> {t("vault.heading.destroyVaultAndStartOver")}</h2>
        <Notice tone="danger">
          {t("vault.description.thisDeletesYourVaultIdentityEveryFileInEvery")}
        </Notice>
        {localError && <p dir={vaultErrorDir(localError)} className="text-xs text-[var(--color-danger)]">{localError}</p>}
        {useEmailCode ? (
          codeSent ? (
            <div>
              <VaultLabel htmlFor="vault-destroy-email-code">
                {t("common.description.weSentA6DigitCodeToEmail", { email: user?.email ?? "" })}
              </VaultLabel>
              <VaultInput id="vault-destroy-email-code" inputMode="numeric" autoComplete="one-time-code" autoFocus value={emailCode}
                onChange={(e) => setEmailCode(e.target.value.replace(/\D/g, "").slice(0, 6))} disabled={busy} placeholder={t("common.label.sixDigitCode")} />
              <button type="button" onClick={sendCode} disabled={sending || busy}
                className="mt-1.5 text-xs text-[var(--color-text-secondary)] underline underline-offset-2 hover:text-[var(--color-text)]">
                {t("profile.action.resendCode")}
              </button>
            </div>
          ) : (
            <VaultButton variant="outline" className="w-full justify-center" onClick={sendCode} disabled={sending || busy} data-testid="vault-destroy-send-code">
              {t("profile.action.sendCode")}
            </VaultButton>
          )
        ) : (
          <div>
            <VaultLabel htmlFor="vault-destroy-password">{t("vault.label.accountPassword")}</VaultLabel>
            <VaultInput id="vault-destroy-password" type="password" autoComplete="current-password" value={password}
              onChange={(e) => setPassword(e.target.value)} disabled={busy} placeholder={t("vault.placeholder.yourDosyaPassword")} />
          </div>
        )}
        {needsCode && (
          <div>
            <VaultLabel htmlFor="vault-destroy-code">{t("vault.label.twoFactorCode")}</VaultLabel>
            <VaultInput id="vault-destroy-code" inputMode="numeric" autoComplete="one-time-code" value={code}
              onChange={(e) => setCode(e.target.value.replace(/\s/g, "").slice(0, 10))} disabled={busy} placeholder={t("common.label.sixDigitCode")} />
          </div>
        )}
        <label className="flex items-start gap-2 text-xs text-[var(--color-text)]">
          <input type="checkbox" className="mt-0.5" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} disabled={busy} />
          <span>{t("vault.description.iUnderstandMyEncryptedFilesCannotBeRecoveredAfter")}</span>
        </label>
        <div className="flex justify-end gap-2 pt-1">
          <VaultButton variant="outline" onClick={onClose} disabled={busy}>{t("common.cancel")}</VaultButton>
          <VaultButton variant="danger" onClick={submit} disabled={busy || !proofReady || !confirmed} data-testid="vault-destroy-confirm">
            {busy ? t("vault.status.destroying") : t("vault.action.destroyMyVault")}
          </VaultButton>
        </div>
      </div>
    </Modal>
  );
}
