// apps/desktop/src/renderer/components/family/FamilySection.tsx
import { useState, useSyncExternalStore, type FormEvent, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { autoDir } from "@/lib/bidi-ui";
import { AlertTriangle, ExternalLink, HardDrive, Mail, Plus, UserMinus, Users } from "lucide-react";
import { Modal } from "@/components/files/Modal";
import { webAppUrl } from "@/lib/web-app-url";
import {
  FAMILY_KEY, getFamily, inviteFamilyMember, leaveFamily, removeFamilyMember, revokeFamilyInvite, showsFamilyEntry,
  type FamilyMemberView, type FamilyView,
} from "@/lib/family-api";
import { ApiError } from "@/lib/api-client";
import { formatBytes } from "@/lib/format";
import { FamilyUsage, poolSegments, type FamilyPerson } from "./FamilyUsage";
import { ReservationDialog, type ReservationPerson } from "./ReservationDialog";
import { greenTone, isDarkTheme, personColor, personInk, tint, warnTone, type PoolSegment } from "./family-colors";
import { formatGigabytes, gigabyteFigure } from "./family-format";
import { richText } from "@/lib/rich-text";
import { subscribeThemeChange } from "@/lib/theme";
import { formatters, useT } from "@/lib/i18n";
import type { T } from "../../../i18n/translator";

type Pending =
  | { kind: "remove" | "revoke" | "resend"; member: FamilyMemberView }
  | { kind: "leave" };

/** errText for a toast: the server's own sentence takes its own direction. */
const rawOrTranslated = (t: T, e: unknown) => {
  const text = errText(t, e);
  return e instanceof ApiError && text === e.message ? autoDir(text) : text;
};

const errText = (t: T, e: unknown) => {
  if (e instanceof ApiError && e.data?.code === "free_plan") return t("family.error.yourPlanHasEndedSoYouCannotInviteAnyonePeriodSentenceCaseWithEndedsoyoucannotinviteanyonenew");
  return e instanceof Error && e.message ? e.message : t("family.error.somethingWentWrongTryAgain");
};

/**
 * Everyone in the pool, ranked as the Usage list ranks them (payer first, then
 * by usage), and the colour of each active member row. A member row is matched
 * to its usage row by `user_id`; an older API without it falls back to the
 * name (each usage row used once). An unmatched row takes the next free colour.
 */
function buildPeople(data: FamilyView): { people: FamilyPerson[]; colorOf: Map<string, number>; personKeyOf: Map<string, string> } {
  const people: FamilyPerson[] = (data.usage ?? []).map((u, i) => ({
    key: u.id, name: u.name, isYou: u.is_you, isPayer: u.is_payer, colorIndex: i,
    used: u.used_bytes, usedLabel: u.used_label, reserved: u.reserved_bytes ?? null,
  }));
  const colorOf = new Map<string, number>();
  const personKeyOf = new Map<string, string>();
  const taken = new Set<string>();
  for (const m of data.members ?? []) {
    if (m.status !== "active") continue;
    const match = m.user_id !== undefined
      ? people.find((p) => !p.isPayer && m.user_id !== null && p.key === m.user_id)
      : people.find((p) => !p.isPayer && !taken.has(p.key) && p.name === m.name);
    if (match) {
      taken.add(match.key);
      colorOf.set(m.id, match.colorIndex);
      personKeyOf.set(m.id, match.key);
    } else {
      const extra: FamilyPerson = {
        key: `member:${m.id}`, name: m.name ?? m.email, isYou: false, isPayer: false, colorIndex: people.length,
        used: m.used_bytes ?? 0, usedLabel: formatBytes(m.used_bytes ?? 0), reserved: m.reserved_bytes ?? null,
      };
      people.push(extra);
      colorOf.set(m.id, extra.colorIndex);
      personKeyOf.set(m.id, extra.key);
    }
  }
  return { people, colorOf, personKeyOf };
}

/**
 * The Family tab of the Profile page, the same design as the web Family card
 * with Members and Usage always behind the toggle. Payer: people, pending
 * invitations, storage reservations, the places counter and an invite field.
 * Member: who pays, their own reservation if any, the pool, and Leave.
 * Nothing here sells anything; buying places lives on the web, linked only
 * where the distribution allows (`showWebLink`).
 */
export function FamilySection({ showWebLink }: { showWebLink: boolean }) {
  const t = useT();
  const qc = useQueryClient();
  const { data, isLoading, isError, refetch } = useQuery({ queryKey: FAMILY_KEY, queryFn: getFamily });
  const [email, setEmail] = useState("");
  const [tab, setTab] = useState<"members" | "usage">("members");
  const [pending, setPending] = useState<Pending | null>(null);
  // The dialog keeps the member as it was when opened, so a refetch cannot
  // change it under the user; seq gives each opening fresh state.
  const [reserve, setReserve] = useState<{ member: FamilyMemberView; seq: number } | null>(null);
  // Re-render on a theme switch (Settings, or the OS scheme on "system") so
  // the person colours and tones follow it without a reload.
  const dark = useSyncExternalStore(subscribeThemeChange, isDarkTheme);

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: FAMILY_KEY });
    void qc.invalidateQueries({ queryKey: ["dashboard-storage"] });
  };
  const action = useMutation({
    mutationFn: async (p: Pending) => {
      if (p.kind === "remove") return removeFamilyMember(p.member.id);
      if (p.kind === "revoke") return revokeFamilyInvite(p.member.id);
      if (p.kind === "resend") return inviteFamilyMember(p.member.email);
      return leaveFamily();
    },
    onSuccess: (_r, p) => {
      setPending(null);
      toast.success(t(p.kind === "remove" ? "family.label.removedFromYourFamilyPlan" : p.kind === "revoke" ? "family.label.invitationRevoked" : p.kind === "resend" ? "family.label.invitationSentAgain" : "family.label.youLeftTheFamilyPlan"));
      refresh();
    },
    onError: (e) => toast.error(rawOrTranslated(t, e)),
  });
  const invite = useMutation({
    mutationFn: (addr: string) => inviteFamilyMember(addr),
    onSuccess: () => { setEmail(""); toast.success(t("common.label.invitationSent")); refresh(); },
    onError: (e) => toast.error(rawOrTranslated(t, e)),
  });

  if (isLoading) return <div className="h-24 max-w-[640px] animate-pulse rounded-xl bg-[var(--color-bg-tertiary)]" />;
  if (isError || !data) {
    return (
      <div className="max-w-[640px] space-y-2">
        <p className="text-sm text-[var(--color-danger)]">{t("family.error.couldNotLoadYourFamilyPlan")}</p>
        <button className="text-sm text-[var(--color-primary)] hover:underline" onClick={() => void refetch()}>{t("common.retry")}</button>
      </div>
    );
  }

  const { people, colorOf, personKeyOf } = buildPeople(data);
  const members = data.members ?? [];
  const isMember = data.role === "member";
  const inFamily = data.role !== "none" || members.length > 0;
  const showTabs = Array.isArray(data.usage) && inFamily;
  const onInvite = (e: FormEvent) => { e.preventDefault(); const a = email.trim(); if (a) invite.mutate(a); };
  const openReserve = (m: FamilyMemberView) => setReserve((r) => ({ member: m, seq: (r?.seq ?? 0) + 1 }));

  const membersView = isMember ? (
    <MemberView data={data} people={people} dark={dark} onLeave={() => setPending({ kind: "leave" })} />
  ) : !showsFamilyEntry(data) ? (
    <p className="text-sm text-[var(--color-text-muted)]">{t("family.description.youAreNotInAFamilyPlan")}</p>
  ) : (
    <PayerView data={data} people={people} colorOf={colorOf} dark={dark} email={email} setEmail={setEmail} onInvite={onInvite} inviting={invite.isPending}
      onAsk={(kind, member) => setPending({ kind, member })} onReserve={openReserve} showWebLink={showWebLink} />
  );

  return (
    <div className="max-w-[640px] space-y-5">
      <Header data={data} people={people} dark={dark} inFamily={inFamily} />

      {showTabs && (
        <PillToggle dark={dark} value={tab} onChange={setTab} label={t("family.heading.familyPlan")}
          options={[["members", t("common.action.members")], ["usage", t("family.action.usage")]]} />
      )}

      {showTabs && tab === "usage" ? <FamilyUsage view={data} people={people} dark={dark} /> : membersView}

      {pending && (
        <ConfirmModal pending={pending} data={data} busy={action.isPending}
          onCancel={() => { if (!action.isPending) setPending(null); }} onConfirm={() => action.mutate(pending)} />
      )}
      {reserve && (
        <ReservationDialog
          key={`${reserve.member.id}:${reserve.seq}`}
          member={reserve.member}
          personKey={personKeyOf.get(reserve.member.id) ?? ""}
          people={people.map((p): ReservationPerson => ({ key: p.key, name: p.name, color: personColor(p.colorIndex, dark), used: p.used, reserved: p.reserved }))}
          poolLimit={data.pool.limit_bytes}
          onClose={() => setReserve(null)}
          onSaved={() => { setReserve(null); refresh(); }}
        />
      )}
    </div>
  );
}

function Chip({ children, green = false, dark }: { children: ReactNode; green?: boolean; dark: boolean }) {
  return (
    <span data-slot="family-chip" className="inline-flex h-7 items-center whitespace-nowrap rounded-full bg-[var(--color-bg-tertiary)] px-3 text-[13px] font-semibold"
      style={green ? greenTone(dark) : undefined}>
      {children}
    </span>
  );
}

/** Title, plan and places chips, the pool line and its stacked bar, and the overbooked warning. */
function Header({ data, people, dark, inFamily }: { data: FamilyView; people: FamilyPerson[]; dark: boolean; inFamily: boolean }) {
  const t = useT();
  const isMember = data.role === "member";
  const showChips = inFamily || data.eligible;
  const reservedTotal = data.pool.reserved_bytes ?? 0;
  const reservedCount = people.filter((p) => p.reserved).length;
  return (
    <div>
      <div className="flex flex-wrap items-center gap-2.5">
        <h2 className="me-auto flex items-center gap-2 text-lg font-semibold"><Users size={18} /> {t("family.heading.familyPlan")}</h2>
        {showChips && <Chip dark={dark}>{t("family.label.planChip", { planName: data.plan.name, limitLabel: data.pool.limit_label })}</Chip>}
        {isMember
          ? <Chip green dark={dark}>{t("family.status.sharedWithYou")}</Chip>
          : showChips && typeof data.included === "number" && <Chip green dark={dark}>{t("family.label.placesIncludedChip", { count: data.included })}</Chip>}
      </div>
      {inFamily && (
        <p className="mt-2 text-sm text-[var(--color-text-secondary)]">
          {reservedTotal > 0
            ? t("family.description.usedOfLimitReservedForPeople", { usedLabel: data.pool.used_label, limitLabel: data.pool.limit_label, reservedLabel: formatGigabytes(reservedTotal), count: reservedCount })
            : t("family.description.usedlabelOfLimitLabelUsedAcrossTheFamily", { usedLabel: data.pool.used_label, limitLabel: data.pool.limit_label })}
        </p>
      )}
      {inFamily && people.length > 0 && <PoolBar segments={poolSegments(people, dark, 30)} limitBytes={data.pool.limit_bytes} />}
      {!isMember && data.reservations_exceed_pool && (
        <p role="status" className="mt-3 flex items-start gap-2 rounded-lg px-3 py-2.5 text-sm" style={warnTone(dark)}>
          <AlertTriangle size={16} className="mt-0.5 shrink-0" aria-hidden="true" />
          {t("family.error.reservationsAddUpToMoreThanYourPlan")}
        </p>
      )}
    </div>
  );
}

/** The pool as one stacked bar under the header: used and held space per person. */
function PoolBar({ segments, limitBytes }: { segments: PoolSegment[]; limitBytes: number }) {
  const limit = Math.max(limitBytes, 1);
  return (
    <div aria-hidden="true" className="mt-2.5 flex h-2 gap-0.5 overflow-hidden rounded-full bg-[var(--color-bg-tertiary)]">
      {segments.filter((s) => s.bytes > 0).map((s) => (
        <span key={s.key} className="h-full" style={{ width: `${Math.min(100, (s.bytes / limit) * 100)}%`, background: s.color }} />
      ))}
    </div>
  );
}

// rtl-ok: mirrored, the rtl: variant slides the other way
const PILL_SLIDE = "data-[index=1]:translate-x-full rtl:data-[index=1]:-translate-x-full";

/**
 * Members | Usage as a pill toggle. The highlight slides under the picked
 * option, easing out with no overshoot (and not at all with reduced motion).
 */
function PillToggle<V extends string>({ value, onChange, options, label, dark }: {
  dark: boolean; value: V; onChange: (v: V) => void; options: [V, string][]; label: string;
}) {
  const index = Math.max(0, options.findIndex(([v]) => v === value));
  return (
    <div role="tablist" aria-label={label} className="relative grid h-11 grid-cols-2 rounded-full bg-[var(--color-bg-tertiary)] p-1">
      <span
        aria-hidden="true"
        data-index={index}
        className={`absolute inset-y-1 start-1 w-[calc(50%-4px)] rounded-full transition-transform duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none ${dark ? "" : "shadow-sm"} ${PILL_SLIDE}`}
        style={{ background: dark ? "color-mix(in oklab, var(--color-bg-secondary), var(--color-text) 22%)" : "var(--color-bg)" }}
      />
      {options.map(([v, text]) => (
        <button
          key={v}
          type="button"
          role="tab"
          aria-selected={v === value}
          onClick={() => onChange(v)}
          className={`relative rounded-full text-sm font-semibold transition-colors ${v === value ? "text-[var(--color-text)]" : "text-[var(--color-text-secondary)] hover:text-[var(--color-text)]"}`}
        >
          {text}
        </button>
      ))}
    </div>
  );
}

function Avatar({ name, colorIndex, dark }: { name: string; colorIndex: number | null; dark: boolean }) {
  return (
    <span
      data-slot="avatar"
      aria-hidden="true"
      className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-base font-semibold ${colorIndex === null ? "border-2 border-dashed text-[var(--color-text-secondary)]" : ""}`}
      style={colorIndex === null ? { borderColor: "var(--color-text-muted)" } : { background: personColor(colorIndex, dark), color: personInk(colorIndex, dark) }}
    >
      {([...name.trim()][0] ?? "?").toLocaleUpperCase()}
    </span>
  );
}

function Badge({ children, colorIndex, dark }: { children: ReactNode; colorIndex: number | null; dark: boolean }) {
  return (
    <span
      className="inline-flex h-6 shrink-0 items-center whitespace-nowrap rounded-full bg-[var(--color-bg-tertiary)] px-2.5 text-xs font-semibold text-[var(--color-text-secondary)]"
      style={colorIndex === null ? undefined : { background: tint(personColor(colorIndex, dark), 16), color: personColor(colorIndex, dark) }}
    >{children}</span>
  );
}

function PersonRow({ name, colorIndex, dark, sub, end, title }: { name: string; colorIndex: number | null; dark: boolean; sub: ReactNode; end: ReactNode; title?: string }) {
  return (
    <li className="flex items-center gap-3 py-2.5">
      <Avatar name={name} colorIndex={colorIndex} dark={dark} />
      <div className="min-w-0 flex-1" title={title}>
        <p data-slot="person-name" className="truncate text-sm font-semibold">{name}</p>
        <p className="line-clamp-2 break-words text-xs text-[var(--color-text-muted)]">{sub}</p>
      </div>
      {end}
    </li>
  );
}

/** "184 of 200 GB reserved" or "72 GB · shares the pool". */
function UsageLine({ used, reserved }: { used: number; reserved: number | null }) {
  const t = useT();
  return reserved
    ? <span className="font-medium text-[var(--color-text)]">{t("family.label.usedOfReservedReserved", { used: gigabyteFigure(used), reserved: formatGigabytes(reserved) })}</span>
    : <>{t("family.label.usedSharesThePool", { used: formatGigabytes(used) })}</>;
}

function MemberView({ data, people, dark, onLeave }: { data: FamilyView; people: FamilyPerson[]; dark: boolean; onLeave: () => void }) {
  const t = useT();
  const me = people.find((p) => p.isYou);
  const ownReserved = data.own_reserved_bytes ?? null;
  const ownUsed = data.own_used_bytes ?? me?.used ?? 0;
  return (
    <div className="space-y-4">
      {ownReserved !== null && ownReserved > 0 && (
        <div className="rounded-xl bg-[var(--color-bg-secondary)] p-4">
          <p className="text-sm text-[var(--color-text-secondary)]">{t("family.label.reservedForYouByPayerName", { payerName: data.payer?.name ?? "" })}</p>
          <p className="mt-0.5 text-2xl font-semibold tracking-tight">{t("family.label.usedOfReserved", { used: gigabyteFigure(ownUsed), reserved: formatGigabytes(ownReserved) })}</p>
          <div className="mt-2.5 h-2.5 overflow-hidden rounded-full bg-[var(--color-bg-tertiary)]">
            <div className="h-full rounded-full" style={{ width: `${Math.min(100, (ownUsed / ownReserved) * 100)}%`, background: personColor(me?.colorIndex ?? 0, dark) }} />
          </div>
          <p className="mt-2 text-xs text-[var(--color-text-muted)]">{t("family.description.thisSpaceIsYoursAloneUploadsStopAtSize", { size: formatGigabytes(ownReserved) })}</p>
        </div>
      )}
      <p className="text-sm">{richText(t, "family.description.youAreOnPayerNameSPlanNamePlanYourFiles", { planName: data.plan.name }, { payerName: <strong>{data.payer?.name}</strong> })}</p>
      {people.length > 0 && (
        <ul className="divide-y divide-[var(--color-border)]">
          {people.map((p) => (
            <PersonRow key={p.key} name={p.isYou ? t("family.label.nameYou", { name: p.name }) : p.name} colorIndex={p.colorIndex} dark={dark}
              sub={<UsageLine used={p.used} reserved={p.reserved} />}
              end={p.isPayer
                ? <Badge colorIndex={null} dark={dark}>{t("family.status.paysThePlan")}</Badge>
                : <Badge colorIndex={p.colorIndex} dark={dark}>{t("family.status.joined")}</Badge>} />
          ))}
        </ul>
      )}
      <div className="space-y-2">
        <button onClick={onLeave} className="w-full rounded-lg border px-3 py-2 text-sm font-medium text-[var(--color-danger)] hover:bg-[var(--color-bg-secondary)]" style={{ borderColor: "var(--color-border)" }}>{t("family.action.leaveFamilyPlan")}</button>
        <p className="text-xs text-[var(--color-text-muted)]">{t("family.description.ifYouLeaveYourAccountReturnsToTheFree")}</p>
      </div>
    </div>
  );
}

function PayerView({ data, people, colorOf, dark, email, setEmail, onInvite, inviting, onAsk, onReserve, showWebLink }: {
  data: FamilyView; people: FamilyPerson[]; colorOf: Map<string, number>; dark: boolean;
  email: string; setEmail: (v: string) => void; onInvite: (e: FormEvent) => void; inviting: boolean;
  onAsk: (kind: "remove" | "revoke" | "resend", m: FamilyMemberView) => void; onReserve: (m: FamilyMemberView) => void; showWebLink: boolean;
}) {
  const t = useT();
  const members = data.members ?? [];
  const over = data.over_capacity === true;
  const full = members.length >= data.limit;
  const payer = people.find((p) => p.isPayer);
  const places = typeof data.included === "number"
    ? ` ${t("family.label.includedIncludedExtraPlacesExtra", { included: data.included, extraPlaces: data.extra_places ?? 0 })}`
    : "";
  const iconButton = "rounded-md p-1.5 text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-secondary)] hover:text-[var(--color-text)]";

  const memberRow = (m: FamilyMemberView) => {
    const invited = m.status === "invited";
    const colorIndex = invited ? null : colorOf.get(m.id) ?? null;
    const name = m.name ?? m.email;
    const sub = invited
      ? (m.expires_at ? t("family.description.invitedExpiresDate", { date: formatters().formatDate(m.expires_at, "short") }) : t("family.description.invitedExpiresSoon"))
      : m.used_bytes !== undefined ? <UsageLine used={m.used_bytes} reserved={m.reserved_bytes ?? null} /> : m.email;
    const canReserve = data.eligible && !invited && m.max_reservable_bytes !== undefined;
    const reservedBytes = m.reserved_bytes ?? null;
    const end = (
      <div className="flex shrink-0 items-center gap-1">
        {canReserve ? (
          <button
            type="button"
            onClick={() => onReserve(m)}
            title={reservedBytes ? t("family.heading.changeNameSReservation", { name }) : t("family.heading.reserveStorageForName", { name })}
            className={`me-1 inline-flex h-7 items-center gap-1.5 whitespace-nowrap rounded-full border-[1.5px] px-2.5 text-xs font-semibold transition-colors hover:bg-[var(--color-bg-secondary)] ${reservedBytes ? "" : "border-dashed text-[var(--color-text-secondary)] hover:text-[var(--color-text)]"}`}
            style={{ borderColor: "var(--color-border)" }}
          >
            {reservedBytes ? <HardDrive size={14} aria-hidden="true" /> : <Plus size={14} aria-hidden="true" />}
            {reservedBytes ? formatGigabytes(reservedBytes) : t("family.action.reserve")}
          </button>
        ) : (
          <span className="me-1">{invited
            ? <Badge colorIndex={null} dark={dark}>{t("common.status.invited")}</Badge>
            : <Badge colorIndex={colorIndex} dark={dark}>{t("family.status.joined")}</Badge>}</span>
        )}
        {invited && data.eligible && (
          <button aria-label={t("family.accessibility.sendInvitationToEmailAgain", { email: m.email })} onClick={() => onAsk("resend", m)} className={iconButton}><Mail size={16} /></button>
        )}
        <button aria-label={!invited ? t("family.accessibility.removeMName", { mName: name }) : t("family.accessibility.revokeInvitationToEmail", { email: m.email })}
          onClick={() => onAsk(!invited ? "remove" : "revoke", m)} className={iconButton}><UserMinus size={16} /></button>
      </div>
    );
    return <PersonRow key={m.id} name={name} colorIndex={colorIndex} dark={dark} sub={sub} end={end} title={m.email} />;
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm text-[var(--color-text-secondary)]">{t("family.description.membercountOfLimitPlacesUsedPlacesMembersKeepTheir", { memberCount: members.length, limit: data.limit, places })}</p>
        {showWebLink && data.can_buy_places === true && (
          <button onClick={() => window.open(webAppUrl("/billing"), "_blank")} className="inline-flex shrink-0 items-center gap-1.5 text-sm text-[var(--color-primary)] hover:underline">
            <ExternalLink size={14} /> {t("family.action.managePlacesOnTheWeb")}
          </button>
        )}
      </div>
      {over && <p className="text-xs text-[var(--color-text-muted)]">{t("family.description.youHaveMorePeopleThanPlacesNobodyHasBeen")}</p>}
      {(payer || members.length > 0) && (
        <ul className="divide-y divide-[var(--color-border)]">
          {payer && (
            <PersonRow key={payer.key} name={payer.isYou ? t("family.label.nameYou", { name: payer.name }) : payer.name} colorIndex={payer.colorIndex} dark={dark}
              sub={<UsageLine used={payer.used} reserved={null} />} end={<Badge colorIndex={null} dark={dark}>{t("family.status.paysThePlan")}</Badge>} />
          )}
          {members.map(memberRow)}
        </ul>
      )}
      {data.eligible ? (
        <form onSubmit={onInvite} className="flex gap-2 pt-1">
          <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder={t("family.placeholder.familyExampleCom")} disabled={full || over || inviting}
            className="flex-1 rounded-lg border bg-transparent px-3 py-2 text-sm" style={{ borderColor: "var(--color-border)" }} />
          <button type="submit" disabled={full || over || inviting} className="rounded-lg px-4 py-2 text-sm font-medium text-[var(--color-primary-fg)] disabled:opacity-50" style={{ background: "var(--color-primary)" }}>
            {inviting ? t("common.status.sending") : t("common.action.invite")}
          </button>
        </form>
      ) : (
        <p className="text-sm text-[var(--color-text-muted)]">{t("family.error.yourPlanHasEndedSoYouCannotInviteAnyonePeriodSentenceCaseWithStillremovepeopleorrevokeinvitationshere")}</p>
      )}
      {data.eligible && full && !over && <p className="text-xs text-[var(--color-text-muted)]">{t("family.description.allLimitPlacesAreTakenRemoveSomeoneOrRevoke", { limit: data.limit })}</p>}
    </div>
  );
}

function ConfirmModal({ pending, data, busy, onCancel, onConfirm }: { pending: Pending; data: FamilyView; busy: boolean; onCancel: () => void; onConfirm: () => void }) {
  const t = useT();
  let title = ""; let body = ""; let verb = ""; let destructive = true;
  if (pending.kind === "remove") {
    title = t("family.label.removeWhoFromYourFamilyPlan", { who: pending.member.name ?? pending.member.email });
    body = pending.member.over_free
      ? t("family.description.theirAccountReturnsToTheFreePlanWith5PeriodSentenceCaseWithUploadswillpauseuntiltheyfreespace")
      : t("family.description.theirAccountReturnsToTheFreePlanWith5PeriodSentenceCaseWithAndyoucaninvitethemagainlater");
    verb = t("common.remove");
  } else if (pending.kind === "revoke") {
    title = t("family.label.revokeTheInvitationToEmail", { email: pending.member.email });
    body = t("family.label.theLinkInTheirEmailStopsWorkingYouCan");
    verb = t("common.action.revoke");
  } else if (pending.kind === "resend") {
    title = t("family.label.sendTheInvitationToEmailAgain", { email: pending.member.email });
    body = t("family.description.theyGetAFreshEmailWithANewLink");
    verb = t("family.action.sendAgain"); destructive = false;
  } else {
    title = data.payer?.name ? t("family.label.leavePayerNameSFamilyPlan", { payerName: data.payer.name }) : t("family.label.leaveThisFamilyPlan");
    body = data.own_used_label
      ? t("family.description.yourAccountGoesBackToTheFreePlanWithPeriodSentenceCaseWithYoufreespaceyoucurrentlystoreownusedlabel", { ownUsedLabel: data.own_used_label })
      : t("family.description.yourAccountGoesBackToTheFreePlanWithPeriodSentenceCaseWithGbuploadspauseuntilyoufreespace");
    verb = t("family.action.leave");
  }
  return (
    <Modal onClose={onCancel} maxWidth={420}>
      <div role="dialog" aria-modal="true" aria-labelledby="family-confirm-title" className="space-y-4">
        <h3 id="family-confirm-title" className="text-base font-semibold">{title}</h3>
        <p className="text-sm text-[var(--color-text-secondary)]">{body}</p>
        <div className="flex justify-end gap-2">
          <button onClick={onCancel} disabled={busy} className="rounded-lg border px-3 py-1.5 text-sm" style={{ borderColor: "var(--color-border)" }}>{pending.kind === "resend" ? t("common.cancel") : t("family.action.keep")}</button>
          <button onClick={onConfirm} disabled={busy} className={`rounded-lg px-3 py-1.5 text-sm font-medium disabled:opacity-50 ${destructive ? "text-white" : "text-[var(--color-primary-fg)]"}`}
            style={{ background: destructive ? "var(--color-danger)" : "var(--color-primary)" }}>
            {busy ? t("common.status.working") : verb}
          </button>
        </div>
      </div>
    </Modal>
  );
}
