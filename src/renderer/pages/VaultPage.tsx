import { useVault } from "@/lib/vault/store";
import { UnlockGate } from "@/components/vault/UnlockGate";
import { RecoveryKeyModal } from "@/components/vault/RecoveryKeyModal";
import { VaultBrowser } from "@/components/vault/VaultBrowser";
import { VaultMembers } from "@/components/vault/VaultMembers";

export function VaultPage() {
  const status = useVault((s) => s.status);
  return (
    // h-full like FileBrowserPage: unlocked, the browser owns a full-height
    // split (Space menu + scrolling content). Locked, the gate centers itself.
    <div className="relative flex h-full flex-col" data-testid="vault-page">
      {status === "unlocked" ? (
        <VaultBrowser renderMembers={(p) => <VaultMembers {...p} />} />
      ) : (
        <UnlockGate />
      )}
      {/* Outside the branch so it survives setup()'s status flip (see RecoveryKeyModal). */}
      <RecoveryKeyModal />
    </div>
  );
}
