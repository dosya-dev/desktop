import { useEffect, useState } from "react";
import { Lock, ShieldCheck, KeyRound, TriangleAlert, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { useVault } from "@/lib/vault/store";
import { useAuth } from "@/lib/auth-context";
import { api } from "@/lib/api-client";
import { Modal } from "@/components/files/Modal";
import { Notice, VaultButton, VaultCard, VaultInput, VaultLabel } from "./ui";

/**
 * Shown whenever the Vault is not unlocked. Binds the persisted Space list to
 * the signed-in account, asks the store whether an identity exists, then
 * renders Setup (none), Unlock (one) or Retry (could not tell). Never renders
 * or logs a passphrase or recovery key anywhere but its own fields.
 */
export function UnlockGate() {
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
          Your files are encrypted on this computer before they ever leave it. dosya only ever stores ciphertext.
        </p>
        <a
          href="https://dosya.dev/vault"
          target="_blank"
          rel="noopener noreferrer"
          className="text-xs font-medium text-[var(--color-primary)] underline underline-offset-2 hover:opacity-80"
        >
          What is Vault? Learn more
        </a>
      </div>

      {/* hasIdentity is null while checking OR when the check failed. Only
          the latter carries `error`. Never fall through to Setup here. */}
      {hasIdentity === null && error && (
        <VaultCard>
          <div data-testid="vault-retry">
            <h2 className="mb-3 text-sm font-semibold">Couldn't check encryption status</h2>
            <Notice tone="warn" icon={<TriangleAlert size={14} />}>
              <p>{error}</p>
              <button type="button" onClick={() => checkIdentity()} className="mt-1 font-medium underline underline-offset-2">Retry</button>
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

function SetupCard({ error }: { error: string | null }) {
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
          <h2 className="flex items-center gap-2 text-sm font-semibold"><ShieldCheck size={16} className="text-[var(--color-primary)]" /> Set up encryption</h2>
          <p className="mt-1 text-xs text-[var(--color-text-secondary)]">Choose a passphrase to protect your Vault.</p>
        </div>
        {error && <p className="text-xs text-[var(--color-danger)]">{error}</p>}
        <div>
          <VaultLabel htmlFor="vault-setup-pass">Passphrase</VaultLabel>
          <VaultInput id="vault-setup-pass" type="password" autoComplete="new-password" value={pass}
            onChange={(e) => setPass(e.target.value)} placeholder="Enter a strong passphrase" disabled={busy} />
        </div>
        <div>
          <VaultLabel htmlFor="vault-setup-confirm">Confirm passphrase</VaultLabel>
          <VaultInput id="vault-setup-confirm" type="password" autoComplete="new-password" value={confirm}
            onChange={(e) => setConfirm(e.target.value)} onBlur={() => setConfirmTouched(true)}
            placeholder="Re-enter your passphrase" disabled={busy} />
          {mismatch && <p className="mt-1 text-xs text-[var(--color-danger)]">Passphrases do not match.</p>}
        </div>
        <Notice tone="danger">
          If you lose this passphrase <strong>and</strong> your recovery key, your encrypted files are unrecoverable. We cannot reset it.
        </Notice>
        <VaultButton type="submit" className="w-full justify-center" disabled={!canSubmit} data-testid="vault-setup-submit">
          {busy ? "Setting up…" : "Set up"}
        </VaultButton>
      </form>
    </VaultCard>
  );
}

function UnlockCard({ error }: { error: string | null }) {
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
                ? <><KeyRound size={16} className="text-[var(--color-primary)]" /> Unlock with recovery key</>
                : <><Lock size={16} className="text-[var(--color-primary)]" /> Unlock Vault</>}
            </h2>
            <p className="mt-1 text-xs text-[var(--color-text-secondary)]">
              {mode === "recovery"
                ? "Paste the recovery key you saved when you set up your Vault. Spaces and dashes are ignored."
                : "Enter your passphrase to decrypt your files on this computer."}
            </p>
          </div>
          {error && <p className="text-xs text-[var(--color-danger)]">{error}</p>}
          {mode === "recovery" ? (
            <div>
              <VaultLabel htmlFor="vault-recovery-key">Recovery key</VaultLabel>
              <VaultInput id="vault-recovery-key" type="text" autoComplete="off" spellCheck={false} autoFocus
                value={recoveryKey} onChange={(e) => setRecoveryKey(e.target.value)} disabled={unlocking}
                placeholder="Your recovery key" className="font-mono" />
            </div>
          ) : (
            <div>
              <VaultLabel htmlFor="vault-unlock-pass">Passphrase</VaultLabel>
              <VaultInput id="vault-unlock-pass" type="password" autoComplete="current-password" autoFocus
                value={pass} onChange={(e) => setPass(e.target.value)} disabled={unlocking}
                placeholder="Your encryption passphrase" />
            </div>
          )}
          <VaultButton type="submit" className="w-full justify-center" disabled={unlocking || !canSubmit} data-testid="vault-unlock-submit">
            {unlocking ? "Unlocking…" : "Unlock"}
          </VaultButton>
          <div className="flex items-center justify-between text-xs">
            <button type="button" data-testid="vault-recovery-toggle" disabled={unlocking}
              className="text-[var(--color-text-secondary)] underline underline-offset-2 hover:text-[var(--color-text)]"
              onClick={() => setMode(mode === "recovery" ? "passphrase" : "recovery")}>
              {mode === "recovery" ? "Use passphrase" : "Use recovery key"}
            </button>
            <button type="button" data-testid="vault-destroy" disabled={unlocking}
              className="text-[var(--color-danger)]/80 underline underline-offset-2 hover:text-[var(--color-danger)]"
              onClick={() => setDestroyOpen(true)}>
              Destroy vault and start over
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
 * with the account password, plus a 2FA code when the account has one.
 */
function DestroyVaultModal({ onClose }: { onClose: () => void }) {
  const destroyIdentity = useVault((s) => s.destroyIdentity);
  const busy = useVault((s) => s.busy);
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [needsCode, setNeedsCode] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api.get<{ ok: boolean; method: string | null }>("/api/me/2fa/status")
      .then((r) => { if (!cancelled) setNeedsCode(!!r.method); })
      .catch(() => { /* the server still refuses without a code; the field appears after the first refusal */ });
    return () => { cancelled = true; };
  }, []);

  const submit = async () => {
    if (!password || busy) return;
    setLocalError(null);
    const ok = await destroyIdentity(password, needsCode && code ? code : undefined);
    if (ok) {
      toast.success("Vault destroyed", { description: "Set up encryption again whenever you are ready." });
      onClose();
      return;
    }
    const err = useVault.getState().error;
    setLocalError(err);
    if (err && /two-factor|2fa/i.test(err)) setNeedsCode(true);
  };

  return (
    <Modal onClose={() => { if (!busy) onClose(); }}>
      <div className="space-y-3" data-testid="vault-destroy-modal">
        <h2 className="flex items-center gap-2 text-base font-semibold text-[var(--color-danger)]"><Trash2 size={16} /> Destroy vault and start over</h2>
        <Notice tone="danger">
          This deletes your Vault identity. Every file in every Space you encrypted with it becomes permanently unreadable, to you and to anyone you shared a Space with. There is no undo.
        </Notice>
        {localError && <p className="text-xs text-[var(--color-danger)]">{localError}</p>}
        <div>
          <VaultLabel htmlFor="vault-destroy-password">Account password</VaultLabel>
          <VaultInput id="vault-destroy-password" type="password" autoComplete="current-password" value={password}
            onChange={(e) => setPassword(e.target.value)} disabled={busy} placeholder="Your dosya password" />
        </div>
        {needsCode && (
          <div>
            <VaultLabel htmlFor="vault-destroy-code">Two-factor code</VaultLabel>
            <VaultInput id="vault-destroy-code" inputMode="numeric" autoComplete="one-time-code" value={code}
              onChange={(e) => setCode(e.target.value.replace(/\s/g, "").slice(0, 10))} disabled={busy} placeholder="6-digit code" />
          </div>
        )}
        <label className="flex items-start gap-2 text-xs text-[var(--color-text)]">
          <input type="checkbox" className="mt-0.5" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} disabled={busy} />
          <span>I understand my encrypted files cannot be recovered after this.</span>
        </label>
        <div className="flex justify-end gap-2 pt-1">
          <VaultButton variant="outline" onClick={onClose} disabled={busy}>Cancel</VaultButton>
          <VaultButton variant="danger" onClick={submit} disabled={busy || !password || !confirmed} data-testid="vault-destroy-confirm">
            {busy ? "Destroying…" : "Destroy my vault"}
          </VaultButton>
        </div>
      </div>
    </Modal>
  );
}
