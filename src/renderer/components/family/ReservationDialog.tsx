// apps/desktop/src/renderer/components/family/ReservationDialog.tsx
import { useId, useState, useSyncExternalStore, type ReactNode } from "react";
import { Loader2, Minus, Plus } from "lucide-react";
import { Modal } from "@/components/files/Modal";
import { ApiError } from "@/lib/api-client";
import { autoDir } from "@/lib/bidi-ui";
import { GB, setFamilyReservation, type FamilyMemberView } from "@/lib/family-api";
import { richText } from "@/lib/rich-text";
import { useT } from "@/lib/i18n";
import { subscribeThemeChange } from "@/lib/theme";
import { isDarkTheme, tint, warnTone } from "./family-colors";
import { formatGigabytes, gbUnit, sizeGb } from "./family-format";

/** One person in the pool, for the preview bar: their colour, what they use and what is reserved for them. */
export type ReservationPerson = { key: string; name: string; color: string; used: number; reserved: number | null };

const STEP_GB = 10;

const BTN_OUTLINE = "rounded-lg border px-3 py-1.5 text-sm disabled:opacity-50";
const BTN_PRIMARY = "inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium text-[var(--color-primary-fg)] disabled:opacity-50";

/**
 * Reserve storage for a family member, or change or remove their reservation.
 * A reservation is held for that person (nobody else can use it) and is also
 * their limit. Whole GB only. The most that fits comes from the view's
 * `max_reservable_bytes`; the server re-checks atomically and, when it refuses
 * with a 409, its own `max_gb` replaces ours. Lowering is always allowed, even
 * when the pool is overbooked, so the limit is never below the current amount.
 * Mirrors apps/web/src/components/billing/family-reservation-dialog.tsx.
 */
export function ReservationDialog({ member, personKey, people, poolLimit, onClose, onSaved }: {
  member: FamilyMemberView;
  /** Which entry of `people` is this member. */
  personKey: string;
  people: ReservationPerson[];
  poolLimit: number;
  onClose: () => void;
  onSaved: () => void;
}) {
  const t = useT();
  const titleId = useId();
  // Follows a theme switch while the dialog is open.
  const dark = useSyncExternalStore(subscribeThemeChange, isDarkTheme);
  const name = member.name ?? member.email;
  const me = people.find((p) => p.key === personKey);
  const used = member.used_bytes ?? me?.used ?? 0;
  const currentGb = member.reserved_bytes ? Math.round(member.reserved_bytes / GB) : null;
  const [serverMaxGb, setServerMaxGb] = useState<number | null>(null);
  const maxGb = serverMaxGb ?? Math.floor((member.max_reservable_bytes ?? 0) / GB);
  const limitGb = Math.max(maxGb, currentGb ?? 0);
  const [raw, setRaw] = useState(() => String(currentGb ?? (limitGb >= 100 ? 100 : Math.max(1, limitGb))));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ReactNode>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);

  const v = /^\d+$/.test(raw.trim()) ? Number(raw.trim()) : NaN;
  const valid = Number.isSafeInteger(v) && v >= 1;
  const over = valid && v > limitGb;
  const below = valid && !over && v * GB < used;
  const unchanged = valid && v === currentGb;

  const picks = [...new Set((currentGb ? [currentGb, currentGb + 50, currentGb + 100] : [50, 100, 200]).filter((p) => p <= limitGb))];

  const save = async (gb: number | null) => {
    setBusy(true); setError(null);
    try {
      await setFamilyReservation(member.id, gb);
      onSaved();
    } catch (e) {
      if (e instanceof ApiError && e.data?.code === "reservation_too_large" && typeof e.data.max_gb === "number") {
        setServerMaxGb(e.data.max_gb);
        setConfirmRemove(false);
      } else {
        // The server's own sentence takes its own direction.
        setError(e instanceof Error && e.message ? autoDir(e.message) : t("family.error.somethingWentWrongTryAgain"));
      }
    } finally {
      setBusy(false);
    }
  };

  const close = () => { if (!busy) onClose(); };

  if (confirmRemove && currentGb) {
    return (
      <Modal onClose={close} maxWidth={420}>
        <div role="dialog" aria-modal="true" aria-labelledby={titleId} className="space-y-4">
          <h3 id={titleId} className="text-base font-semibold">{t("common.heading.areYouSure")}</h3>
          <p className="text-sm text-[var(--color-text-secondary)]">
            {richText(t, "family.description.youAreEndingNameSSizeReservation", {}, {
              name: <strong className="text-[var(--color-text)]">{name}</strong>,
              size: <strong className="text-[var(--color-text)]">{sizeGb(currentGb)}</strong>,
            })}
          </p>
          {error && <p className="text-sm text-[var(--color-danger)]">{error}</p>}
          <div className="flex justify-end gap-2">
            <button onClick={() => setConfirmRemove(false)} disabled={busy} className={BTN_OUTLINE} style={{ borderColor: "var(--color-border)" }}>{t("common.cancel")}</button>
            <button onClick={() => void save(null)} disabled={busy} className={`${BTN_PRIMARY} text-white`} style={{ background: "var(--color-danger)" }}>
              {busy && <Loader2 size={14} className="animate-spin" />}
              {t("family.action.removeReservation")}
            </button>
          </div>
        </div>
      </Modal>
    );
  }

  let note: ReactNode = null;
  if (over) {
    note = <Note tone="error" dark={dark}>{t("family.error.onlyMaxIsFreeToReserveForName", { max: sizeGb(limitGb), name })}</Note>;
  } else if (below) {
    note = <Note tone="warn" dark={dark}>{t("family.description.nameAlreadyUsesUsedWithSizeTheirUploadsStop", { name, used: formatGigabytes(used), size: sizeGb(v) })}</Note>;
  } else if (currentGb === null) {
    note = <Note tone="info" dark={dark}>{t("family.description.nameUsesUsedNowYouCanReserveUpToMax", { name, used: formatGigabytes(used), max: sizeGb(limitGb) })}</Note>;
  }

  const setGb = (gb: number) => { setRaw(String(Math.max(1, gb))); setError(null); };
  const shown = valid ? v : currentGb ?? 0;
  const stepper = "flex h-12 w-11 shrink-0 items-center justify-center rounded-xl bg-[var(--color-bg-secondary)] hover:bg-[var(--color-bg-tertiary)] disabled:opacity-40 disabled:hover:bg-[var(--color-bg-secondary)]";

  return (
    <Modal onClose={close} maxWidth={448}>
      <div role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <h3 id={titleId} className="text-lg font-semibold leading-tight">
          {currentGb ? t("family.heading.changeNameSReservation", { name }) : t("family.heading.reserveStorageForName", { name })}
        </h3>
        <p className="mt-1.5 text-sm text-[var(--color-text-secondary)]">
          {currentGb
            ? richText(t, "family.description.nameHasReservedReservedAndUsesUsed", { name }, {
              reserved: <strong className="text-[var(--color-text)]">{sizeGb(currentGb)}</strong>,
              used: <strong className="text-[var(--color-text)]">{formatGigabytes(used)}</strong>,
            })
            : t("family.description.thisSpaceIsHeldForNameAndIsAlsoTheirLimit", { name })}
        </p>

        <div className="mt-4 flex items-center gap-2">
          <button type="button" className={stepper} aria-label={t("family.accessibility.less")}
            disabled={busy || !valid || v <= 1} onClick={() => setGb((valid ? v : 1) - STEP_GB)}>
            <Minus size={16} />
          </button>
          <div className="relative min-w-0 flex-1">
            <input
              inputMode="numeric"
              autoComplete="off"
              aria-label={t("family.accessibility.reservationInGb")}
              aria-invalid={over || (!valid && raw !== "") || undefined}
              value={raw}
              onChange={(e) => { setRaw(e.target.value); setError(null); }}
              disabled={busy}
              className={`h-12 w-full rounded-xl border bg-transparent ps-4 pe-12 text-2xl font-semibold tabular-nums outline-none focus:border-[var(--color-text-secondary)] ${over ? "border-[var(--color-danger)]" : ""}`}
              style={over ? undefined : { borderColor: "var(--color-border)" }}
            />
            <span aria-hidden="true" className="pointer-events-none absolute inset-y-0 end-4 flex items-center text-sm font-medium text-[var(--color-text-secondary)]">{gbUnit()}</span>
          </div>
          <button type="button" className={stepper} aria-label={t("family.accessibility.more")}
            disabled={busy || limitGb < 1 || (valid && v >= limitGb)} onClick={() => setGb(Math.min((valid ? v : 0) + STEP_GB, limitGb))}>
            <Plus size={16} />
          </button>
        </div>

        {(picks.length > 0 || limitGb >= 1) && (
          <div className="mt-2.5 flex flex-wrap gap-2">
            {picks.map((p) => <Pick key={p} on={v === p} onClick={() => setGb(p)}>{String(p)}</Pick>)}
            {limitGb >= 1 && !picks.includes(limitGb) && (
              <Pick on={v === limitGb} onClick={() => setGb(limitGb)}>{t("family.action.maxGb", { gb: limitGb })}</Pick>
            )}
          </div>
        )}

        <PoolPreview people={people} personKey={personKey} name={name} gb={shown} limitGb={limitGb} over={over} poolLimit={poolLimit} />

        {note}
        {error && <p className="mt-3 text-sm text-[var(--color-danger)]">{error}</p>}

        <div className="mt-5 flex flex-wrap items-center justify-end gap-2">
          {currentGb !== null && (
            <button onClick={() => { setError(null); setConfirmRemove(true); }} disabled={busy}
              className="me-auto rounded-lg px-2 py-1.5 text-sm font-medium text-[var(--color-danger)] hover:bg-[var(--color-bg-secondary)] disabled:opacity-50">
              {t("family.action.removeReservation")}
            </button>
          )}
          <button onClick={close} disabled={busy} className={BTN_OUTLINE} style={{ borderColor: "var(--color-border)" }}>{t("common.cancel")}</button>
          <button onClick={() => void save(v)} disabled={busy || !valid || over || unchanged} className={BTN_PRIMARY} style={{ background: "var(--color-primary)" }}>
            {busy && <Loader2 size={14} className="animate-spin" />}
            {currentGb ? t("family.action.saveSize", { size: valid ? sizeGb(v) : "" }) : t("family.action.reserveSize", { size: valid ? sizeGb(v) : "" })}
          </button>
        </div>
      </div>
    </Modal>
  );
}

function Pick({ on, onClick, children }: { on: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={onClick}
      className={`h-8 rounded-full px-3 text-sm font-semibold tabular-nums transition-colors ${on ? "text-[var(--color-primary-fg)]" : "bg-[var(--color-bg-secondary)] hover:bg-[var(--color-bg-tertiary)]"}`}
      style={on ? { background: "var(--color-primary)" } : undefined}
    >
      {children}
    </button>
  );
}

const NOTE_TONE: Record<"info" | "warn" | "error", string> = {
  info: "bg-[var(--color-bg-secondary)] text-[var(--color-text-secondary)]",
  warn: "",
  error: "text-[var(--color-danger)]",
};

function Note({ tone, dark, children }: { tone: "info" | "warn" | "error"; dark: boolean; children: ReactNode }) {
  return (
    <p
      data-tone={tone}
      role={tone === "error" ? "alert" : undefined}
      className={`mt-3.5 rounded-lg px-3 py-2.5 text-sm leading-snug ${NOTE_TONE[tone]}`}
      style={tone === "error" ? { background: "color-mix(in oklab, var(--color-danger), transparent 90%)" } : tone === "warn" ? warnTone(dark) : undefined}
    >
      {children}
    </p>
  );
}

/**
 * The pool after this change: everyone else's share (a reservation counts in
 * full, or what they use when that is more), then this person's amount, then
 * what is left. The amount turns red when it does not fit.
 */
function PoolPreview({ people, personKey, name, gb, limitGb, over, poolLimit }: {
  people: ReservationPerson[]; personKey: string; name: string; gb: number; limitGb: number; over: boolean; poolLimit: number;
}) {
  const t = useT();
  const limit = Math.max(poolLimit, 1);
  const me = people.find((p) => p.key === personKey);
  const others = people.filter((p) => p.key !== personKey);
  const pct = (bytes: number) => `${Math.min(100, (Math.max(0, bytes) / limit) * 100)}%`;
  const reservedOther = others.find((p) => p.reserved);
  const sharingOther = others.find((p) => !p.reserved && p.used > 0);
  const mine = me?.color ?? "var(--color-text)";
  const legend: { key: string; color: string; label: string }[] = [
    { key: "me", color: over ? "var(--color-danger)" : mine, label: t("family.label.nameSize", { name, size: sizeGb(gb) }) },
    ...(reservedOther ? [{ key: "res", color: tint(reservedOther.color, 45), label: t("family.label.otherReservations") }] : []),
    ...(sharingOther ? [{ key: "share", color: sharingOther.color, label: t("family.label.usedByPeopleWhoShare") }] : []),
    { key: "free", color: "var(--color-bg-tertiary)", label: t("family.label.stillFreeSize", { size: sizeGb(Math.max(0, limitGb - gb)) }) },
  ];
  return (
    <div className="mt-4">
      <div className="flex h-3 gap-0.5 overflow-hidden rounded-full bg-[var(--color-bg-tertiary)]" aria-hidden="true">
        {others.map((p) => {
          const bytes = p.reserved ? Math.max(p.reserved, p.used) : p.used;
          return bytes > 0 ? <span key={p.key} className="h-full" style={{ width: pct(bytes), background: p.reserved ? tint(p.color, 45) : p.color }} /> : null;
        })}
        {gb > 0 && <span className="h-full" style={{ width: pct(Math.min(gb, limitGb) * GB), background: over ? "var(--color-danger)" : mine }} />}
      </div>
      <ul className="mt-2 flex flex-wrap gap-x-3.5 gap-y-1 text-xs text-[var(--color-text-secondary)]">
        {legend.map((l) => (
          <li key={l.key} className="flex items-center gap-1.5">
            <span aria-hidden="true" className={`inline-block h-2 w-2 shrink-0 rounded-full ${l.key === "free" ? "ring-1 ring-[var(--color-border)]" : ""}`} style={{ background: l.color }} />
            {l.label}
          </li>
        ))}
      </ul>
    </div>
  );
}
