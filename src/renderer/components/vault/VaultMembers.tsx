import { useState } from "react";
import { Users, UserPlus, Trash2, ShieldAlert } from "lucide-react";
import { useVault, type WorkspaceMember } from "@/lib/vault/store";
import { useAuth } from "@/lib/auth-context";
import { Modal } from "@/components/files/Modal";
import { Notice, VaultButton, VaultInput } from "./ui";

/**
 * Members of the open Space: list, invite by email, revoke. Invite and revoke
 * are offered to every member; the server is the actual gate and that is not
 * re-implemented here. Both disclosures are mandatory: trust-on-first-use for
 * invites, and what revoke does and does not cut off.
 */
export function VaultMembers({ workspaceName, onClose }: { workspaceName: string; onClose: () => void }) {
  const { user } = useAuth();
  const members = useVault((s) => s.members);
  const busy = useVault((s) => s.busy);
  const inviteMember = useVault((s) => s.inviteMember);
  const revokeMember = useVault((s) => s.revokeMember);
  const [email, setEmail] = useState("");
  const [revokeTarget, setRevokeTarget] = useState<WorkspaceMember | null>(null);

  const invite = async () => {
    const trimmed = email.trim();
    if (!trimmed) return;
    await inviteMember(trimmed);
    if (!useVault.getState().error) setEmail("");
  };

  const revoke = async () => {
    if (!revokeTarget) return;
    await revokeMember(revokeTarget.userId, revokeTarget.ed25519Pub);
    setRevokeTarget(null);
  };

  return (
    <>
      <Modal onClose={onClose} maxWidth={448}>
        <div className="space-y-3" data-testid="vault-members-modal">
          <h2 className="flex items-center gap-2 text-base font-semibold"><Users size={16} /> Members: {workspaceName}</h2>

          <div className="max-h-64 space-y-1.5 overflow-y-auto">
            {members.length === 0 ? (
              <p className="py-4 text-center text-xs text-[var(--color-text-secondary)]">No members yet.</p>
            ) : members.map((m) => {
              const isYou = user != null && m.userId === user.id;
              return (
                <div key={m.userId} data-testid={`vault-member-${m.userId}`}
                  className="flex items-center justify-between gap-2 rounded-lg border border-[var(--color-border)] px-3 py-2">
                  <div className="flex min-w-0 items-center gap-1.5">
                    <span className="truncate text-sm">{m.email}</span>
                    {isYou && <span className="rounded-full bg-[var(--color-bg-secondary)] px-1.5 text-[9px] font-medium text-[var(--color-text-secondary)]">you</span>}
                  </div>
                  {!isYou && (
                    <VaultButton variant="ghost" size="icon" title="Revoke access" disabled={busy}
                      data-testid={`vault-revoke-${m.userId}`} onClick={() => setRevokeTarget(m)}
                      className="text-[var(--color-danger)] hover:text-[var(--color-danger)]">
                      <Trash2 size={14} />
                    </VaultButton>
                  )}
                </div>
              );
            })}
          </div>

          <Notice tone="muted" icon={<ShieldAlert size={14} />}>
            Access is granted by trust-on-first-use. Verify a contact out of band; automatic key-transparency protection is coming.
          </Notice>

          <div className="flex items-center gap-1.5">
            <VaultInput type="email" placeholder="teammate@example.com" value={email} disabled={busy} data-testid="vault-invite-email"
              onChange={(e) => setEmail(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") invite(); }} className="min-w-0" />
            <VaultButton size="sm" onClick={invite} disabled={busy || !email.trim()} className="shrink-0" data-testid="vault-invite">
              <UserPlus size={14} /> Invite
            </VaultButton>
          </div>
        </div>
      </Modal>

      {revokeTarget && (
        <Modal onClose={() => setRevokeTarget(null)} maxWidth={400}>
          <div className="space-y-3" data-testid="vault-revoke-modal">
            <h2 className="text-base font-semibold">Revoke access?</h2>
            <p className="text-sm text-[var(--color-text-secondary)]">
              Revoke <span className="font-semibold text-[var(--color-text)]">{revokeTarget.email}</span>'s access to “{workspaceName}”?
            </p>
            <Notice tone="muted" icon={<ShieldAlert size={14} />}>
              Revoking re-keys this Space so future content is unreadable to them. Anything they already downloaded stays with them. Re-keying a large Space can take a while.
            </Notice>
            <div className="flex justify-end gap-2">
              <VaultButton variant="outline" onClick={() => setRevokeTarget(null)}>Cancel</VaultButton>
              <VaultButton variant="danger" onClick={revoke} disabled={busy} data-testid="vault-revoke-confirm"><Trash2 size={14} /> Revoke</VaultButton>
            </div>
          </div>
        </Modal>
      )}
    </>
  );
}
