// Ported from apps/web/src/components/lock-modal.tsx - keep in sync with the web copy.
import { useEffect, useRef, useState } from "react";
import { Eye, EyeOff, FileText, Folder, KeyRound, Loader2, Lock, LockOpen } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/api-client";
import { Modal } from "@/components/files/Modal";
import { formatBytes, formatRelative } from "@/lib/format";
import {
  LOCK_MODE_OPTIONS, MIN_LOCK_PASSWORD_LENGTH,
  canApplyLock, describeLockMode, describeLockStatus, describeLockTarget,
  lockActionLabel, passwordFieldLabel, passwordHint, type LockMode,
} from "@/lib/lock-mode";

export interface LockTarget {
  id: string;
  name: string;
  type: "file" | "folder";
  /** Files: shown in the chip as "PDF · 2.4 MB". */
  size_bytes?: number;
  extension?: string | null;
  /** Folders: shown as "Folder · 128 files · 1.9 GB". */
  file_count?: number;
  total_size_bytes?: number;
  /**
   * The row's own lock_mode. Seeds the dialog so it is right before the GET
   * answers and stays right if the GET fails; the GET adds who and when.
   */
  lock_mode?: string;
}

interface LockModalProps {
  open: boolean;
  target: LockTarget | null;
  onClose: () => void;
  onDone: () => void;
}

const MODE_ICONS: Record<LockMode, typeof Lock> = { none: LockOpen, view_only: Eye, full_lock: KeyRound };

function asLockMode(value: string | undefined): LockMode {
  return value === "view_only" || value === "full_lock" ? value : "none";
}

const IS_MAC = typeof navigator !== "undefined" && /mac/i.test(navigator.platform);

function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <kbd
      className="inline-block min-w-[18px] rounded border px-1 text-center text-[10.5px] leading-4"
      style={{ borderColor: "var(--color-border)", background: "var(--color-bg-secondary)", fontFamily: "inherit" }}
    >
      {children}
    </kbd>
  );
}

export function LockModal({ open, target, onClose, onDone }: LockModalProps) {
  if (!open || !target) return null;
  return (
    <Modal onClose={onClose} maxWidth={400}>
      {/* Keyed so a different item gets fresh state, not the last one's password. */}
      <LockModalBody key={target.id} target={target} onClose={onClose} onDone={onDone} />
    </Modal>
  );
}

/**
 * Reads the current lock on mount (GET /lock also says who set it and when)
 * and writes it on apply. The copy and the button rules live in lib/lock-mode
 * so web and mobile say the same things about the same lock_mode.
 *
 * Desktop extras over web: Escape closes and Cmd/Ctrl+Enter applies, with the
 * shortcuts shown in the footer, because the Modal shell has no key handling
 * of its own.
 */
function LockModalBody({ target, onClose, onDone }: { target: LockTarget; onClose: () => void; onDone: () => void }) {
  const seed = asLockMode(target.lock_mode);
  const [loading, setLoading] = useState(true);
  const [current, setCurrent] = useState<LockMode>(seed);
  const [lockedBy, setLockedBy] = useState<string | null>(null);
  const [lockedAt, setLockedAt] = useState<number | null>(null);
  const [selected, setSelected] = useState<LockMode>(seed);
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [tooShort, setTooShort] = useState(false);
  const [saving, setSaving] = useState(false);
  // Synchronous re-entrancy guard: Cmd+Enter in the field reaches both the
  // input's handler and the window listener before React re-renders with
  // `saving` set, so state alone would let the second call post again.
  const savingRef = useRef(false);

  const endpoint = target.type === "file" ? `/api/files/${target.id}/lock` : `/api/folders/${target.id}/lock`;
  const isFolder = target.type === "folder";

  useEffect(() => {
    let cancelled = false;
    api.get<{ ok: boolean; lock_mode?: string; locked_by_name?: string | null; locked_at?: number | null }>(endpoint)
      .then((data) => {
        if (cancelled || !data.ok) return;
        const mode = asLockMode(data.lock_mode);
        setCurrent(mode);
        setSelected(mode);
        setLockedBy(data.locked_by_name ?? null);
        setLockedAt(data.locked_at ?? null);
      })
      // On a failed read the row's own lock_mode (the seed) stands; only who
      // and when are missing, and the server still validates what is applied.
      .catch(() => {})
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [endpoint]);

  const meta = describeLockTarget({
    kind: target.type,
    extension: target.extension,
    file_count: target.file_count,
    size: isFolder
      ? (typeof target.total_size_bytes === "number" ? formatBytes(target.total_size_bytes) : null)
      : (typeof target.size_bytes === "number" ? formatBytes(target.size_bytes) : null),
  });
  const statusLine = loading ? null : describeLockStatus({
    lock_mode: current,
    locked_by_name: lockedBy,
    lockedWhen: lockedAt ? formatRelative(lockedAt) : null,
  });
  const label = lockActionLabel({ selected, current, loading });
  const enabled = canApplyLock({ selected, current, password, loading }) && !saving;

  const pick = (mode: LockMode) => {
    setSelected(mode);
    setTooShort(false);
  };

  const submit = async () => {
    if (savingRef.current || loading) return;
    if (selected === "full_lock" && password.trim().length < MIN_LOCK_PASSWORD_LENGTH) {
      setTooShort(true);
      return;
    }
    if (!canApplyLock({ selected, current, password })) return;
    savingRef.current = true;
    setSaving(true);
    try {
      const body: Record<string, unknown> = { lock_mode: selected };
      if (selected === "full_lock") body.password = password;
      const res = await api.post<{ ok: boolean; error?: string }>(endpoint, body);
      if (!res.ok) {
        toast.error("Couldn't update the lock", { description: res.error ?? "Try again." });
        return;
      }
      if (selected === "none") toast.success("Lock removed", { description: `${target.name} is open to everyone in the workspace.` });
      else if (selected === "view_only") toast.success("View only", { description: `${target.name} can be previewed but not downloaded.` });
      else if (current === "full_lock") toast.success("Password updated", { description: `${target.name} now needs the new password.` });
      else toast.success("Locked with a password", { description: `${target.name} now needs a password to open.` });
      onDone();
      onClose();
    } catch (err) {
      toast.error("Couldn't update the lock", {
        description: err instanceof Error && err.message ? err.message : "Can't reach the server. Check your connection and try again.",
      });
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  // Escape closes, Cmd/Ctrl+Enter applies. Registered on the window because
  // focus may sit on a radio, the field, or nothing at all. The listener is
  // attached once and reads the latest handlers through a ref, so it neither
  // re-subscribes every render nor closes over stale state.
  const latest = useRef({ submit, onClose });
  useEffect(() => { latest.current = { submit, onClose }; });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); latest.current.onClose(); }
      else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void latest.current.submit(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const TargetIcon = isFolder ? Folder : FileText;
  const passwordId = `lock-password-${target.id}`;
  const hintId = `${passwordId}-hint`;

  return (
    <div>
      <h3 className="text-lg font-semibold">{isFolder ? "Lock folder" : "Lock file"}</h3>

      <div className="mt-3 flex min-w-0 items-center gap-2.5">
        <span
          className="flex size-[34px] shrink-0 items-center justify-center rounded-lg"
          style={isFolder
            ? { background: "color-mix(in oklab, var(--color-primary) 14%, var(--color-bg))", color: "var(--color-primary)" }
            : { background: "var(--color-bg-secondary)", color: "var(--color-text-muted)" }}
        >
          <TargetIcon size={17} />
        </span>
        <div className="min-w-0">
          <div className="truncate text-sm font-medium">{target.name}</div>
          <div className="text-xs text-[var(--color-text-muted)]">{meta}</div>
        </div>
      </div>

      {statusLine && (
        <div className="mt-3 flex items-center gap-1.5 rounded-lg bg-[var(--color-bg-secondary)] px-2.5 py-1.5 text-xs text-[var(--color-text-muted)]">
          {current === "full_lock" ? <Lock size={13} className="shrink-0" /> : <Eye size={13} className="shrink-0" />}
          <span>{statusLine}</span>
        </div>
      )}

      {loading ? (
        <div aria-busy="true" className="mt-3 overflow-hidden rounded-[10px] border" style={{ borderColor: "var(--color-border)" }}>
          {[0, 1, 2].map((i) => (
            <div key={i} className="grid grid-cols-[16px_1fr] gap-2.5 px-3 py-3" style={i > 0 ? { borderTop: "1px solid var(--color-border)" } : undefined}>
              <span className="size-4 animate-pulse rounded-full bg-[var(--color-bg-secondary)] motion-reduce:animate-none" />
              <div>
                <div className="mb-2 h-3 w-1/3 animate-pulse rounded-md bg-[var(--color-bg-secondary)] motion-reduce:animate-none" />
                <div className="h-2.5 w-4/5 animate-pulse rounded-md bg-[var(--color-bg-secondary)] motion-reduce:animate-none" />
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div role="radiogroup" aria-label="Access level" className="mt-3 overflow-hidden rounded-[10px] border" style={{ borderColor: "var(--color-border)" }}>
          {LOCK_MODE_OPTIONS.map((m, i) => {
            const on = selected === m.value;
            const Icon = MODE_ICONS[m.value];
            return (
              <div
                key={m.value}
                className={"transition-colors" + (on ? "" : " hover:bg-[var(--color-bg-secondary)]")}
                style={{
                  ...(i > 0 ? { borderTop: "1px solid var(--color-border)" } : {}),
                  ...(on ? { background: "color-mix(in oklab, var(--color-primary) 8%, var(--color-bg))" } : {}),
                }}
              >
                <label className="grid cursor-pointer grid-cols-[16px_1fr] items-start gap-2.5 px-3 py-2.5">
                  <input
                    type="radio"
                    name={`lock-mode-${target.id}`}
                    value={m.value}
                    checked={on}
                    onChange={() => pick(m.value)}
                    className="peer sr-only"
                  />
                  <span
                    aria-hidden="true"
                    className="mt-0.5 size-4 rounded-full border transition-[box-shadow,border-color] peer-focus-visible:ring-2 peer-focus-visible:ring-[var(--color-primary)]/50"
                    style={on
                      ? { borderColor: "var(--color-primary)", background: "var(--color-primary)", boxShadow: "inset 0 0 0 3px var(--color-bg)" }
                      : { borderColor: "var(--color-border)" }}
                  />
                  <div className="min-w-0">
                    <div className="flex items-center gap-1.5 text-sm font-medium leading-5">
                      <Icon size={15} style={{ color: on ? "var(--color-primary)" : "var(--color-text-muted)" }} />
                      {m.label}
                    </div>
                    <p className="mt-px max-w-[46ch] text-xs text-[var(--color-text-muted)]">{describeLockMode(target.type, m.value)}</p>
                  </div>
                </label>

                {on && m.value === "full_lock" && (
                  <div className="px-3 pb-3 pl-[38px]">
                    <label htmlFor={passwordId} className="mb-1.5 block text-xs font-medium">{passwordFieldLabel(current)}</label>
                    <div className="relative">
                      <input
                        id={passwordId}
                        type={showPassword ? "text" : "password"}
                        value={password}
                        onChange={(e) => { setPassword(e.target.value); setTooShort(false); }}
                        // Plain Enter submits; modifier+Enter is left to the window shortcut so it is not handled twice.
                        onKeyDown={(e) => { if (e.key === "Enter" && !e.metaKey && !e.ctrlKey) { e.preventDefault(); void submit(); } }}
                        placeholder={current === "full_lock" ? "Type a new password" : "Choose a password"}
                        autoComplete="new-password"
                        spellCheck={false}
                        aria-invalid={tooShort || undefined}
                        aria-describedby={hintId}
                        className="w-full rounded-lg border bg-transparent py-2 pl-3 pr-9 text-sm outline-none focus:border-[var(--color-primary)]"
                        style={{ borderColor: tooShort ? "var(--color-danger)" : "var(--color-border)" }}
                        autoFocus
                      />
                      <button
                        type="button"
                        aria-label={showPassword ? "Hide password" : "Show password"}
                        onClick={() => setShowPassword((v) => !v)}
                        className="absolute right-1 top-1 flex size-7 items-center justify-center rounded-md text-[var(--color-text-muted)] hover:bg-[var(--color-bg-secondary)]"
                      >
                        {showPassword ? <EyeOff size={15} /> : <Eye size={15} />}
                      </button>
                    </div>
                    <p id={hintId} className="mt-1.5 text-xs" style={{ color: tooShort ? "var(--color-danger)" : "var(--color-text-muted)" }}>
                      {tooShort ? `Use at least ${MIN_LOCK_PASSWORD_LENGTH} characters.` : passwordHint(current)}
                    </p>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      <div className="mt-4 flex items-center justify-end gap-2">
        <div className="mr-auto flex items-center gap-2.5 whitespace-nowrap text-[11px] text-[var(--color-text-muted)]">
          <span className="flex items-center gap-1"><Kbd>Esc</Kbd> Cancel</span>
          <span className="flex items-center gap-1"><Kbd>{IS_MAC ? "⌘" : "Ctrl"}</Kbd><Kbd>↵</Kbd> Apply</span>
        </div>
        <button
          type="button"
          onClick={onClose}
          disabled={saving}
          className="whitespace-nowrap rounded-lg border px-4 py-2 text-sm disabled:opacity-50"
          style={{ borderColor: "var(--color-border)" }}
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={() => void submit()}
          disabled={!enabled}
          className="flex items-center gap-1.5 whitespace-nowrap rounded-lg px-4 py-2 text-sm font-medium text-[var(--color-primary-fg)] disabled:opacity-50"
          style={{ background: "var(--color-primary)" }}
        >
          {saving && <Loader2 size={14} className="animate-spin" />}
          {label}
        </button>
      </div>
    </div>
  );
}
