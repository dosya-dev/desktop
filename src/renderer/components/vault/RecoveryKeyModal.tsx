import { useState } from "react";
import { KeyRound, Copy } from "lucide-react";
import { toast } from "sonner";
import { useVault } from "@/lib/vault/store";
import { Modal } from "@/components/files/Modal";
import { useT } from "@/lib/i18n";
import { VaultButton } from "./ui";

/**
 * The one-time recovery-key reveal. Mounted by VaultPage OUTSIDE the
 * locked/unlocked branch: `setup()` flips status to 'unlocked' in the same
 * state update that sets `recoveryKeyOnce`, so a modal inside the gate would
 * unmount before it ever showed. Here it survives the swap and blocks the
 * first view of the browser until the user confirms they saved the key.
 */
export function RecoveryKeyModal() {
  const t = useT();
  const recoveryKeyHex = useVault((s) => s.recoveryKeyOnce);
  const dismissRecoveryKey = useVault((s) => s.dismissRecoveryKey);
  const [copied, setCopied] = useState(false);
  if (!recoveryKeyHex) return null;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(recoveryKeyHex);
      setCopied(true);
      toast.success(t("common.status.copied"), { description: t("vault.description.recoveryKeyCopiedToClipboard") });
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error(t("common.error.copyFailed"), { description: t("vault.description.selectAndCopyTheKeyManually") });
    }
  };

  return (
    // No overlay-click dismissal: the only way out is the button, on purpose.
    <Modal onClose={() => {}}>
      <div className="space-y-3" data-testid="vault-recovery-key">
        <h2 className="flex items-center gap-2 text-base font-semibold"><KeyRound size={16} className="text-[var(--color-primary)]" /> {t("vault.heading.saveYourRecoveryKey")}</h2>
        <p className="text-xs text-[var(--color-text-secondary)]">
          {t("vault.description.thisIsTheOnlyTimeThisKeyWillEver")}
        </p>
        <div className="flex items-center gap-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-secondary)] px-3 py-2">
          <code dir="ltr" className="flex-1 break-all font-mono text-xs">{recoveryKeyHex}</code>
          <VaultButton variant="outline" size="icon" onClick={copy} title={t("vault.tooltip.copyRecoveryKey")}><Copy size={14} /></VaultButton>
        </div>
        {copied && <p className="text-[11px] text-[var(--color-primary)]">{t("common.description.copiedToClipboard")}</p>}
        <div className="flex justify-end">
          <VaultButton onClick={() => dismissRecoveryKey()} data-testid="vault-recovery-key-saved">{t("vault.action.iVeSavedIt")}</VaultButton>
        </div>
      </div>
    </Modal>
  );
}
