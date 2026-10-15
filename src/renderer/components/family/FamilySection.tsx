// apps/desktop/src/renderer/components/family/FamilySection.tsx
import { useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { ExternalLink, Mail, UserMinus, Users } from "lucide-react";
import { Modal } from "@/components/files/Modal";
import { webAppUrl } from "@/lib/web-app-url";
import {
  FAMILY_KEY, getFamily, inviteFamilyMember, leaveFamily, removeFamilyMember, revokeFamilyInvite, showsFamilyEntry,
  type FamilyMemberView, type FamilyView,
} from "@/lib/family-api";
import { ApiError } from "@/lib/api-client";
import { FamilyUsage } from "./FamilyUsage";

type Pending =
  | { kind: "remove" | "revoke" | "resend"; member: FamilyMemberView }
  | { kind: "leave" };

const errText = (e: unknown) => {
  if (e instanceof ApiError && e.data?.code === "free_plan") return "Your plan has ended, so you cannot invite anyone new.";
  return e instanceof Error && e.message ? e.message : "Something went wrong. Try again.";
};

/**
 * The Family tab of the Profile page. Payer: people, pending invitations, the
 * places counter and an invite field. Member: who pays and Leave. Nothing here
 * sells anything; buying places lives on the web, linked only where the
 * distribution allows (`showWebLink`).
 */
export function FamilySection({ showWebLink }: { showWebLink: boolean }) {
  const qc = useQueryClient();
  const { data, isLoading, isError, refetch } = useQuery({ queryKey: FAMILY_KEY, queryFn: getFamily });
  const [email, setEmail] = useState("");
  const [tab, setTab] = useState<"members" | "usage">("members");
  const [pending, setPending] = useState<Pending | null>(null);

  const action = useMutation({
    mutationFn: async (p: Pending) => {
      if (p.kind === "remove") return removeFamilyMember(p.member.id);
      if (p.kind === "revoke") return revokeFamilyInvite(p.member.id);
      if (p.kind === "resend") return inviteFamilyMember(p.member.email);
      return leaveFamily();
    },
    onSuccess: (_r, p) => {
      setPending(null);
      toast.success(p.kind === "remove" ? "Removed from your family plan" : p.kind === "revoke" ? "Invitation revoked" : p.kind === "resend" ? "Invitation sent again" : "You left the family plan");
      void qc.invalidateQueries({ queryKey: FAMILY_KEY });
      void qc.invalidateQueries({ queryKey: ["dashboard-storage"] });
    },
    onError: (e) => toast.error(errText(e)),
  });
  const invite = useMutation({
    mutationFn: (addr: string) => inviteFamilyMember(addr),
    onSuccess: () => { setEmail(""); toast.success("Invitation sent"); void qc.invalidateQueries({ queryKey: FAMILY_KEY }); void qc.invalidateQueries({ queryKey: ["dashboard-storage"] }); },
    onError: (e) => toast.error(errText(e)),
  });

  if (isLoading) return <div className="h-24 max-w-lg animate-pulse rounded-xl bg-[var(--color-bg-tertiary)]" />;
  if (isError || !data) {
    return (
      <div className="max-w-lg space-y-2">
        <p className="text-sm text-[var(--color-danger)]">Could not load your family plan.</p>
        <button className="text-sm text-[var(--color-primary)] hover:underline" onClick={() => void refetch()}>Retry</button>
      </div>
    );
  }

  const members = data.members ?? [];
  const showTabs = Array.isArray(data.usage) && (data.role !== "none" || members.length > 0);
  const onInvite = (e: FormEvent) => { e.preventDefault(); const a = email.trim(); if (a) invite.mutate(a); };

  return (
    <div className="max-w-xl space-y-5">
      <div>
        <h2 className="flex items-center gap-2 text-lg font-semibold"><Users size={18} /> Family plan</h2>
        {(data.role !== "none" || members.length > 0) && (
          <p className="mt-1 text-sm text-[var(--color-text-secondary)]">{data.pool.used_label} of {data.pool.limit_label} used across the family.</p>
        )}
      </div>

      {showTabs && (
        <div role="tablist" aria-label="Family plan" className="flex gap-5 border-b" style={{ borderColor: "var(--color-border)" }}>
          {(["members", "usage"] as const).map((k) => (
            <button key={k} role="tab" aria-selected={tab === k} onClick={() => setTab(k)}
              className={`-mb-px border-b-2 pb-2 text-sm ${tab === k ? "border-[var(--color-text)] font-semibold" : "border-transparent text-[var(--color-text-secondary)]"}`}>
              {k === "members" ? "Members" : "Usage"}
            </button>
          ))}
        </div>
      )}

      {showTabs && tab === "usage" ? <FamilyUsage view={data} /> : data.role === "member" ? (
        <MemberView data={data} onLeave={() => setPending({ kind: "leave" })} />
      ) : !showsFamilyEntry(data) ? (
        <p className="text-sm text-[var(--color-text-muted)]">You are not in a family plan.</p>
      ) : (
        <PayerView data={data} email={email} setEmail={setEmail} onInvite={onInvite} inviting={invite.isPending}
          onAsk={(kind, member) => setPending({ kind, member })} showWebLink={showWebLink} />
      )}

      {pending && (
        <ConfirmModal pending={pending} data={data} busy={action.isPending}
          onCancel={() => { if (!action.isPending) setPending(null); }} onConfirm={() => action.mutate(pending)} />
      )}
    </div>
  );
}

function MemberView({ data, onLeave }: { data: FamilyView; onLeave: () => void }) {
  return (
    <div className="space-y-3">
      <p className="text-sm">You are on <strong>{data.payer?.name}</strong>'s {data.plan.name} plan. Your files stay private; only the storage pool and the bill are shared.</p>
      <p className="text-xs text-[var(--color-text-muted)]">If you leave, your account returns to the free plan with 5 GB. Nothing is deleted.</p>
      <button onClick={onLeave} className="rounded-lg border px-3 py-1.5 text-sm" style={{ borderColor: "var(--color-border)" }}>Leave family plan</button>
    </div>
  );
}

function PayerView({ data, email, setEmail, onInvite, inviting, onAsk, showWebLink }: {
  data: FamilyView; email: string; setEmail: (v: string) => void; onInvite: (e: FormEvent) => void; inviting: boolean;
  onAsk: (kind: "remove" | "revoke" | "resend", m: FamilyMemberView) => void; showWebLink: boolean;
}) {
  const members = data.members ?? [];
  const over = data.over_capacity === true;
  const full = members.length >= data.limit;
  const places = typeof data.included === "number" ? ` (${data.included} included, ${data.extra_places ?? 0} extra)` : "";
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm text-[var(--color-text-secondary)]">{members.length} of {data.limit} places used{places}. Members keep their own accounts and private files.</p>
        {showWebLink && data.can_buy_places === true && (
          <button onClick={() => window.open(webAppUrl("/billing"), "_blank")} className="inline-flex shrink-0 items-center gap-1.5 text-sm text-[var(--color-primary)] hover:underline">
            <ExternalLink size={14} /> Manage places on the web
          </button>
        )}
      </div>
      {over && <p className="text-xs text-[var(--color-text-muted)]">You have more people than places. Nobody has been removed; new invitations wait until someone leaves.</p>}
      {members.length > 0 && (
        <ul className="divide-y rounded-lg border px-3" style={{ borderColor: "var(--color-border)" }}>
          {members.map((m) => (
            <li key={m.id} className="flex items-center justify-between gap-3 py-2">
              <div className="min-w-0">
                <p className="truncate text-sm font-medium">{m.name ?? m.email}</p>
                <p className="truncate text-xs text-[var(--color-text-muted)]">
                  {m.status === "active" ? m.email : `Invited · expires ${m.expires_at ? new Date(m.expires_at * 1000).toLocaleDateString() : "soon"}`}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-1">
                {m.status === "invited" && data.eligible && (
                  <button aria-label={`Send invitation to ${m.email} again`} onClick={() => onAsk("resend", m)} className="rounded-md p-1.5 hover:bg-[var(--color-bg-secondary)]"><Mail size={16} /></button>
                )}
                <button aria-label={m.status === "active" ? `Remove ${m.name ?? m.email}` : `Revoke invitation to ${m.email}`}
                  onClick={() => onAsk(m.status === "active" ? "remove" : "revoke", m)} className="rounded-md p-1.5 hover:bg-[var(--color-bg-secondary)]"><UserMinus size={16} /></button>
              </div>
            </li>
          ))}
        </ul>
      )}
      {data.eligible ? (
        <form onSubmit={onInvite} className="flex gap-2">
          <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="family@example.com" disabled={full || over || inviting}
            className="flex-1 rounded-lg border bg-transparent px-3 py-2 text-sm" style={{ borderColor: "var(--color-border)" }} />
          <button type="submit" disabled={full || over || inviting} className="rounded-lg px-4 py-2 text-sm font-medium text-[var(--color-primary-fg)] disabled:opacity-50" style={{ background: "var(--color-primary)" }}>
            {inviting ? "Sending..." : "Invite"}
          </button>
        </form>
      ) : (
        <p className="text-sm text-[var(--color-text-muted)]">Your plan has ended, so you cannot invite anyone new. You can still remove people or revoke invitations here.</p>
      )}
      {data.eligible && full && !over && <p className="text-xs text-[var(--color-text-muted)]">All {data.limit} places are taken. Remove someone or revoke an invitation to free one.</p>}
    </div>
  );
}

function ConfirmModal({ pending, data, busy, onCancel, onConfirm }: { pending: Pending; data: FamilyView; busy: boolean; onCancel: () => void; onConfirm: () => void }) {
  let title = ""; let body = ""; let verb = ""; let destructive = true;
  if (pending.kind === "remove") {
    const who = pending.member.name ?? pending.member.email;
    title = `Remove ${who} from your family plan?`;
    body = "Their account returns to the free plan with 5 GB. Nothing is deleted, and you can invite them again later."
      + (pending.member.over_free ? " They currently store more than 5 GB, so their uploads will pause until they free space." : "");
    verb = "Remove";
  } else if (pending.kind === "revoke") {
    title = `Revoke the invitation to ${pending.member.email}?`;
    body = "The link in their email stops working. You can invite them again at any time.";
    verb = "Revoke";
  } else if (pending.kind === "resend") {
    title = `Send the invitation to ${pending.member.email} again?`;
    body = "They get a fresh email with a new link, and the link in the earlier email stops working. You can resend once a minute.";
    verb = "Send again"; destructive = false;
  } else {
    title = `Leave ${data.payer?.name ?? "this"}'s family plan?`;
    body = "Your account goes back to the free plan with 5 GB. Nothing is deleted, but if you store more than 5 GB, uploads pause until you free space."
      + (data.own_used_label ? ` You currently store ${data.own_used_label}.` : "");
    verb = "Leave";
  }
  return (
    <Modal onClose={onCancel} maxWidth={420}>
      <div role="dialog" aria-modal="true" aria-labelledby="family-confirm-title" className="space-y-4">
        <h3 id="family-confirm-title" className="text-base font-semibold">{title}</h3>
        <p className="text-sm text-[var(--color-text-secondary)]">{body}</p>
        <div className="flex justify-end gap-2">
          <button onClick={onCancel} disabled={busy} className="rounded-lg border px-3 py-1.5 text-sm" style={{ borderColor: "var(--color-border)" }}>{pending.kind === "resend" ? "Cancel" : "Keep"}</button>
          <button onClick={onConfirm} disabled={busy} className={`rounded-lg px-3 py-1.5 text-sm font-medium disabled:opacity-50 ${destructive ? "text-white" : "text-[var(--color-primary-fg)]"}`}
            style={{ background: destructive ? "var(--color-danger)" : "var(--color-primary)" }}>
            {busy ? "Working..." : verb}
          </button>
        </div>
      </div>
    </Modal>
  );
}
