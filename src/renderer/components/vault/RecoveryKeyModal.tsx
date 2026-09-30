import { useState } from "react";
import { KeyRound, Copy } from "lucide-react";
import { toast } from "sonner";
import { useVault } from "@/lib/vault/store";
import { Modal } from "@/components/files/Modal";
import { VaultButton } from "./ui";

/**
 * The one-time recovery-key reveal. Mounted by VaultPage OUTSIDE the
 * locked/unlocked branch: `setup()` flips status to 'unlocked' in the same
 * state update that sets `recoveryKeyOnce`, so a modal inside the gate would
 * unmount before it ever showed. Here it survives the swap and blocks the
 * first view of the browser until the user confirms they saved the key.
 */
export function RecoveryKeyModal() {
  const recoveryKeyHex = useVault((s) => s.recoveryKeyOnce);
  const dismissRecoveryKey = useVault((s) => s.dismissRecoveryKey);
  const [copied, setCopied] = useState(false);
  if (!recoveryKeyHex) return null;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(recoveryKeyHex);
      setCopied(true);
      toast.success("Copied", { description: "Recovery key copied to clipboard." });
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error("Copy failed", { description: "Select and copy the key manually." });
    }
  };

  return (
    // No overlay-click dismissal: the only way out is the button, on purpose.
    <Modal onClose={() => {}}>
      <div className="space-y-3" data-testid="vault-recovery-key">
        <h2 className="flex items-center gap-2 text-base font-semibold"><KeyRound size={16} className="text-[var(--color-primary)]" /> Save your recovery key</h2>
        <p className="text-xs text-[var(--color-text-secondary)]">
          This is the only time this key will ever be shown. Store it somewhere safe, in a password manager or an offline note. If you forget your passphrase, this key is the only way to recover your encrypted files.
        </p>
        <div className="flex items-center gap-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-secondary)] px-3 py-2">
          <code className="flex-1 break-all font-mono text-xs">{recoveryKeyHex}</code>
          <VaultButton variant="outline" size="icon" onClick={copy} title="Copy recovery key"><Copy size={14} /></VaultButton>
        </div>
        {copied && <p className="text-[11px] text-[var(--color-primary)]">Copied to clipboard.</p>}
        <div className="flex justify-end">
          <VaultButton onClick={() => dismissRecoveryKey()} data-testid="vault-recovery-key-saved">I've saved it</VaultButton>
        </div>
      </div>
    </Modal>
  );
}
