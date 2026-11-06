// Ported from apps/web/src/components/share-modal.tsx - keep in sync with the web copy.
import { useState, useRef, useCallback, useEffect } from "react";
import { Mail, Link2, X, Loader2, Copy, ChevronDown, Files, Folder, Lock, Check } from "lucide-react";
import { toast } from "sonner";
import { api, ApiError } from "@/lib/api-client";
import { Modal } from "@/components/files/Modal";
import {
  LIMITS, buildShareEmailBody, buildShareLinkBody, shareEndpoint,
  validateEmail, validateSharePassword, validateShareExpiryAt, validateShareBundle,
} from "@dosya-dev/shared";
import { useDir, useT } from "@/lib/i18n";
import type { MessageKey } from "../../../i18n/keys";
import type { T } from "../../../i18n/translator";
import { useAutoDir } from "@/lib/bidi-ui";
import { useAuth } from "@/lib/auth-context";
import { useDistribution } from "@/lib/use-distribution";
import { showsBillingTab } from "@/lib/store-surfaces";
import { webAppUrl } from "@/lib/web-app-url";

/**
 * What is being shared. A share link is one file, one bundle of files, or one
 * folder - the API has no shape for "this folder plus these files", which is
 * why the caller must resolve the selection into exactly one of these before
 * opening the modal.
 */
export type ShareTarget =
  | { kind: "file"; fileIds: [string] }
  | { kind: "bundle"; fileIds: string[] }
  | { kind: "folder"; folderId: string };

interface ShareModalProps {
  open: boolean;
  target: ShareTarget | null;
  /** Display name: the file name, "N files", or the folder name. */
  name: string;
  onClose: () => void;
}

type Tab = "email" | "link";

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const EXPIRY_OPTIONS: { value: string; label: MessageKey }[] = [
  { value: "0", label: "common.label.never" },
  { value: "1", label: "sharing.label.oneDay" },
  { value: "7", label: "sharing.label.sevenDays" },
  { value: "30", label: "sharing.label.thirtyDays" },
  { value: "90", label: "sharing.label.ninetyDays" },
];

/**
 * The API clamps a Free creator's links to 7 days (create.ts
 * FREE_SHARE_LINK_MAX_EXPIRY_DAYS) without refusing, so a longer pick used to
 * come back as 7 days with nothing said. The picker locks those options instead.
 */
export const FREE_MAX_EXPIRY_DAYS = 7;

/** True when `value` (an EXPIRY_OPTIONS value, in days; "0" is Never) outlives the Free cap. */
export function isExpiryLockedOnFree(value: string): boolean {
  const days = Number(value);
  return days <= 0 || days > FREE_MAX_EXPIRY_DAYS;
}

/**
 * The expiry dropdown. A native <select> cannot put an icon in an option, and
 * a Free user's locked rows carry a lock at their inline end, so this is a
 * small listbox with LanguageMenu's look and dismissal (outside click,
 * Escape). Locked rows stay listed - seeing what a plan would allow is the
 * point - but are aria-disabled and skipped by the arrow keys.
 */
function ExpiryPicker({ value, onChange, isLocked, lockedHint, labelledBy }: {
  value: string;
  onChange: (value: string) => void;
  isLocked: (value: string) => boolean;
  lockedHint: string;
  labelledBy: string;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const current = EXPIRY_OPTIONS.find((o) => o.value === value) ?? EXPIRY_OPTIONS[0];

  const close = (refocus = true) => {
    setOpen(false);
    if (refocus) triggerRef.current?.focus();
  };

  // Outside click, matching LanguageMenu. Registered only while open.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  // Open on the current choice, with focus on the list so the keys reach it.
  useEffect(() => {
    if (!open) return;
    setActive(Math.max(0, EXPIRY_OPTIONS.findIndex((o) => o.value === value)));
    listRef.current?.focus();
  }, [open, value]);

  const pick = (v: string) => {
    if (isLocked(v)) return;
    onChange(v);
    close();
  };

  /** The next pickable row from `from` in `step` direction, or `from` when there is none. */
  const nextEnabled = (from: number, step: 1 | -1) => {
    for (let i = from + step; i >= 0 && i < EXPIRY_OPTIONS.length; i += step) {
      if (!isLocked(EXPIRY_OPTIONS[i].value)) return i;
    }
    return from;
  };

  const onListKey = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") { e.preventDefault(); setActive((i) => nextEnabled(i, 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActive((i) => nextEnabled(i, -1)); }
    else if (e.key === "Enter" || e.key === " ") { e.preventDefault(); pick(EXPIRY_OPTIONS[active].value); }
    else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(); }
    else if (e.key === "Tab") close(false);
  };

  const onTriggerKey = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); setOpen(true); }
  };

  return (
    <div ref={wrapRef} className="relative">
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        onKeyDown={onTriggerKey}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-labelledby={`${labelledBy} share-expiry-value`}
        data-testid="share-expiry-trigger"
        className="flex h-9 w-full items-center gap-2 rounded-lg border bg-[var(--color-bg)] px-2.5 text-start text-xs outline-none focus:border-[var(--color-primary)]"
        style={{ borderColor: "var(--color-border)" }}
      >
        <span id="share-expiry-value" className="min-w-0 truncate">{t(current.label)}</span>
        <ChevronDown size={14} className={`ms-auto shrink-0 text-[var(--color-text-secondary)] transition-transform ${open ? "rotate-180" : ""}`} />
      </button>

      {open && (
        <div
          ref={listRef}
          role="listbox"
          tabIndex={-1}
          aria-labelledby={labelledBy}
          aria-activedescendant={`share-expiry-opt-${EXPIRY_OPTIONS[active].value}`}
          onKeyDown={onListKey}
          className="anim-pop-in absolute inset-x-0 top-full z-50 mt-1 rounded-lg border bg-[var(--color-bg)] p-1 shadow-lg outline-none"
          style={{ borderColor: "var(--color-border)", transformOrigin: "top center" }}
        >
          {EXPIRY_OPTIONS.map((opt, i) => {
            const locked = isLocked(opt.value);
            const selected = opt.value === value;
            return (
              <div
                key={opt.value}
                id={`share-expiry-opt-${opt.value}`}
                role="option"
                aria-selected={selected}
                aria-disabled={locked || undefined}
                title={locked ? lockedHint : undefined}
                onMouseEnter={() => { if (!locked) setActive(i); }}
                onClick={() => pick(opt.value)}
                className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-xs transition-colors ${
                  locked
                    ? "cursor-not-allowed text-[var(--color-text-muted)] opacity-60"
                    : `cursor-pointer ${i === active ? "bg-[var(--color-bg-tertiary)]" : ""}`
                } ${selected ? "font-medium" : ""}`}
              >
                <span className="min-w-0 truncate">{t(opt.label)}</span>
                {selected && <Check size={14} className="ms-auto shrink-0 text-[var(--color-primary)]" />}
                {locked && <Lock size={12} aria-label={lockedHint} className="ms-auto shrink-0" data-testid="expiry-lock" />}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/*
 * The shared share rules' verdicts in the chosen language. Each asks the
 * shared validator first and returns null when it accepts; the refusing
 * branch is found from the validator's documented conditions, never by
 * reading its English sentence. The desktop modal passes no lock or
 * workspace context, so the password rule can only refuse on length.
 */
function bundleError(t: T, count: number): string | null {
  if (validateShareBundle(count) === null) return null;
  return count === 0
    ? t("sharing.error.selectAtLeastOneFile")
    : t("sharing.error.maximumMaxFilesFilesPerShareLink", { maxFiles: String(LIMITS.SHARE_MAX_BUNDLE_FILES) });
}

function passwordError(t: T, pw: string): string | null {
  const refused = validateSharePassword(pw);
  if (refused === null) return null;
  return pw.length > 0 && pw.length < LIMITS.SHARE_PASSWORD_MIN
    ? t("common.error.passwordMustBeAtLeastMinCharacters", { min: String(LIMITS.SHARE_PASSWORD_MIN) })
    : refused;
}

function expiryError(t: T, expiresAt: number | null, nowSeconds: number): string | null {
  if (validateShareExpiryAt(expiresAt, nowSeconds) === null || expiresAt === null) return null;
  if (!Number.isFinite(expiresAt)) return t("sharing.error.invalidExpiry");
  if (expiresAt <= nowSeconds) return t("sharing.error.expiryMustBeInTheFuture");
  return t("sharing.error.expiryCannotBeMoreThanMaxDaysDaysFromNow", { maxDays: String(LIMITS.SHARE_MAX_EXPIRY_DAYS) });
}

export function ShareModal({ open, target, name, onClose }: ShareModalProps) {
  const ownDir = useAutoDir();
  const t = useT();
  const dir = useDir();
  const isFolder = target?.kind === "folder";
  const isBundle = target?.kind === "bundle";
  // The effective (lapse-aware) plan from /api/me, the same answer the API's
  // isUserEffectivelyFree gives. The shared User type does not declare it, so
  // it is read loosely; an older API without it reads as not Free and the
  // server's clamp is all that applies, as before.
  const { user } = useAuth();
  const isFreePlan = (user as { plan?: { id?: string } | null } | null)?.plan?.id === "free";
  // No external purchase link in a Mac App Store build (guideline 3.1.1).
  const distribution = useDistribution();
  const [excludedCount, setExcludedCount] = useState(0);
  const [tab, setTab] = useState<Tab>("email");
  const [emails, setEmails] = useState<string[]>([]);
  const [emailInput, setEmailInput] = useState("");
  // 7 days: the one default that is also inside the Free cap, so a Free
  // user never opens the dialog on a locked option.
  const [expiry, setExpiry] = useState("7");
  const [password, setPassword] = useState("");
  const [title, setTitle] = useState("");
  const [message, setMessage] = useState("");
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setErrorText] = useState("");
  // The server's own sentence takes its own direction; a translation follows the page.
  const [errorRaw, setErrorRaw] = useState(false);
  const setError = (text: string, raw = false) => { setErrorText(text); setErrorRaw(raw); };
  const [resultUrl, setResultUrl] = useState("");
  const [restrictToRecipients, setRestrictToRecipients] = useState(false);
  /**
   * "Remove photo metadata" (API migration 0183): photos served through the
   * link lose their location, camera and capture-time details. Off by
   * default and absent from the request when off.
   */
  const [stripMetadata, setStripMetadata] = useState(false);
  const emailRef = useRef<HTMLInputElement>(null);

  // What a link for this folder will NOT include, shown before the sharer
  // commits rather than discovered later from a confused recipient.
  useEffect(() => {
    if (!open || target?.kind !== "folder") { setExcludedCount(0); return; }
    let cancelled = false;
    api
      .get<{ ok: true; excluded_count: number }>(`/api/folders/${target.folderId}/share`)
      .then((r) => { if (!cancelled) setExcludedCount(r.excluded_count ?? 0); })
      .catch(() => { /* advisory only - a failed count must not block sharing */ });
    return () => { cancelled = true; };
  }, [open, target]);

  const reset = useCallback(() => {
    setTab("email");
    setEmails([]);
    setEmailInput("");
    setExpiry("7");
    setPassword("");
    setStripMetadata(false);
    setTitle("");
    setMessage("");
    setShowAdvanced(false);
    setSubmitting(false);
    setError("");
    setResultUrl("");
  }, []);

  const close = () => {
    reset();
    onClose();
  };

  const addEmail = (raw: string) => {
    const e = raw.trim().toLowerCase();
    if (!e || !EMAIL_REGEX.test(e) || emails.includes(e)) return;
    setEmails((prev) => [...prev, e]);
  };

  const removeEmail = (idx: number) => {
    setEmails((prev) => prev.filter((_, i) => i !== idx));
  };

  const handleEmailKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" || e.key === "," || e.key === " ") {
      e.preventDefault();
      addEmail(emailInput);
      setEmailInput("");
    } else if (e.key === "Backspace" && !emailInput && emails.length) {
      setEmails((prev) => prev.slice(0, -1));
    }
  };

  const handleEmailBlur = () => {
    if (emailInput.trim()) {
      addEmail(emailInput);
      setEmailInput("");
    }
  };

  const handleEmailPaste = (e: React.ClipboardEvent) => {
    e.preventDefault();
    const text = e.clipboardData.getData("text");
    text.split(/[,;\s\n]+/).forEach(addEmail);
    setEmailInput("");
  };

  const handleSubmit = async () => {
    if (!target) return;
    setError("");

    if (tab === "email" && emails.length === 0) {
      setError(t("sharing.error.addAtLeastOneEmailAddress"));
      emailRef.current?.focus();
      return;
    }

    // Kept in step with web even though no desktop caller builds a bundle yet
    // (see the note in the email branch below) - the point of a shared policy is
    // that the surface which grows the feature later already has the rule.
    if (target.kind === "bundle") {
      const refused = bundleError(t, target.fileIds.length);
      if (refused) { setError(refused); return; }
    }

    if (tab === "email") {
      // The server refuses the whole request on the first bad address without
      // saying which. Name it.
      const bad = emails.find((e) => validateEmail(e) !== null);
      if (bad) {
        setError(t("sharing.error.badIsNotAValidEmailAddress", { bad }));
        emailRef.current?.focus();
        return;
      }
    }

    // Was a hand-written copy of the length clause. Now the shared rule, which
    // also covers full_lock and a workspace that forces a password - and is the
    // same function lib/share/create.ts runs on the server.
    const pw = password.trim();
    const pwError = passwordError(t, pw);
    if (pwError) { setError(pwError); return; }

    // A pick made before /api/me said Free (or on a lapse mid-dialog) can
    // still hold a locked option; stop it here rather than let it be cut to 7 days.
    if (isFreePlan && isExpiryLockedOnFree(expiry)) {
      setError(t("sharing.label.freePlanLinksLastUpTo7Days"));
      return;
    }

    const nowSeconds = Math.floor(Date.now() / 1000);
    // The builder normalises on absolute expires_at; the picker is still in days.
    const expiresAt = (): number | null => {
      const days = Number(expiry);
      return days > 0 ? nowSeconds + days * 86400 : null;
    };

    // Nothing on this client knew about the 3650-day ceiling. The preset picker
    // cannot currently exceed it, but the check costs nothing and stops a future
    // preset from shipping a value the API refuses.
    const expiryRefused = expiryError(t, expiresAt(), nowSeconds);
    if (expiryRefused) { setError(expiryRefused); return; }

    setSubmitting(true);

    try {
      if (tab === "email") {
        // "bundle" exists only for type parity with web's ShareTarget - no
        // desktop caller builds one yet, and the body below is still shaped
        // for a single recipient per call with no file_ids, so this branch
        // would 400 if a bundle target were ever actually submitted here.
        // One request carrying every recipient, not one request per address.
        // A restricted link has to be a single link bound to the whole list; N
        // separate calls would mint N links and make "only these people" a
        // claim the data does not support.
        const endpoint = shareEndpoint(target, "email");
        const body = buildShareEmailBody({
          target,
          emails,
          message,
          restrictToRecipients,
          password: pw || null,
          expiresAt: expiresAt(),
          stripMetadata,
        });

        const res = await api.post<{ ok: boolean; error?: string; failed?: string[] }>(endpoint, body);

        if (res.ok) {
          const failedCount = res.failed?.length ?? 0;
          const sent = emails.length - failedCount;
          toast.success(restrictToRecipients ? t("sharing.label.privateShareSent") : t("sharing.label.shareSent"), {
            description: failedCount
              ? t("sharing.error.sentToSentOfEmailCountCouldNotReachFailed", {
                  sent: String(sent), emailCount: String(emails.length), failed: res.failed!.join(", "),
                })
              : t("sharing.description.sharedWithRecipient", { sent }),
          });
          close();
        } else {
          if (res.error != null) setError(res.error, true); else setError(t("sharing.error.couldNotSend"));
          setSubmitting(false);
        }
      } else {
        // Same bundle caveat as the email endpoint above: no desktop caller
        // builds a "bundle" target yet, and linkBody below has no file_ids,
        // so this branch would 400 if one were ever submitted here.
        const endpoint = shareEndpoint(target, "link");
        const linkBody = buildShareLinkBody({
          target,
          password: pw || null,
          expiresAt: expiresAt(),
          stripMetadata,
        });

        const data = await api.post<{ ok: boolean; link?: { url: string }; error?: string }>(endpoint, linkBody);

        if (data.ok && data.link) {
          setResultUrl(data.link.url);
          try {
            await navigator.clipboard.writeText(data.link.url);
            toast.success(t("common.label.linkCopied"), { description: t("sharing.description.shareLinkCopiedToClipboard") });
          } catch {
            toast.info(t("sharing.label.linkCreated"), { description: t("sharing.description.shareLinkCreated") });
          }
          setSubmitting(false);
        } else {
          if (data.error != null) setError(data.error, true); else setError(t("sharing.error.somethingWentWrong"));
          setSubmitting(false);
        }
      }
    } catch (err) {
      // Surface the API's real message (e.g. "This file is fully locked and
      // cannot be shared", 403) instead of a generic network error.
      if (err instanceof ApiError) setError(err.message, true); else setError(t("sharing.error.somethingWentWrong"));
      setSubmitting(false);
    }
  };

  const handleCopyUrl = async () => {
    try {
      await navigator.clipboard.writeText(resultUrl);
      toast.success(t("common.label.linkCopied"), { description: t("common.description.copiedToClipboard") });
    } catch {}
  };

  if (!open) return null;

  const inputCls = "w-full rounded-lg border px-3 py-2 text-xs outline-none focus:border-[var(--color-primary)]";
  const borderStyle = { borderColor: "var(--color-border)" };

  return (
    <Modal onClose={close}>
      <h3 className="mb-3 text-lg font-semibold">{t("sharing.heading.share")}</h3>

      {/* Tabs */}
      <div className="-mx-6 mb-3 flex border-b" style={borderStyle}>
        {([["email", "sharing.label.byEmail", Mail], ["link", "sharing.label.byLink", Link2]] as const).map(([value, label, Icon]) => (
          <button
            key={value}
            onClick={() => setTab(value)}
            className={`flex flex-1 items-center justify-center gap-1.5 py-2.5 text-xs font-medium transition-colors ${
              tab === value
                ? "border-b-2 border-[var(--color-primary)] text-[var(--color-primary)]"
                : "text-[var(--color-text-secondary)]"
            }`}
          >
            <Icon size={14} /> {t(label)}
          </button>
        ))}
      </div>

      {/* File info */}
      <div className="mb-3 flex items-center gap-2 text-xs text-[var(--color-text-muted)]">
        {isFolder ? (
          <Folder size={15} className="shrink-0" />
        ) : isBundle ? (
          <Files size={15} className="shrink-0" />
        ) : (
          <svg viewBox="0 0 14 14" fill="none" width="15" height="15" className="shrink-0">
            <path d="M3.5 1h5l3.5 3.5V12a1 1 0 01-1 1H3.5a1 1 0 01-1-1V2a1 1 0 011-1z" stroke="currentColor" strokeWidth="1.1" />
            <path d="M8.5 1v3.5h3.5" stroke="currentColor" strokeWidth="1.1" />
          </svg>
        )}
        <span dir={target?.kind === "bundle" ? undefined : ownDir} className="truncate font-medium text-[var(--color-text)]">{name}</span>
      </div>

      <div className="space-y-3">
        {/* Email tab */}
        {tab === "email" && (
          <div>
            <label className="mb-1.5 block text-xs font-medium text-[var(--color-text-muted)]">{t("sharing.label.recipients")}</label>
            <div
              className="flex min-h-9 cursor-text flex-wrap gap-1 rounded-lg border px-2 py-1.5 focus-within:border-[var(--color-primary)]"
              style={borderStyle}
              onClick={() => emailRef.current?.focus()}
            >
              {emails.map((e, i) => (
                <span key={i} className="inline-flex items-center gap-1 rounded bg-[var(--color-bg-tertiary)] px-1.5 py-0.5 text-[11px] font-medium">
                  {/* The chip follows the page (remove at its inline end); only the address is left to right. */}
                  {dir === "rtl" ? <span dir="ltr">{e}</span> : e}
                  <button onClick={() => removeEmail(i)} className="hover:text-[var(--color-danger)]">
                    <X size={10} />
                  </button>
                </span>
              ))}
              <input
                ref={emailRef}
                type="email"
                value={emailInput}
                onChange={(e) => setEmailInput(e.target.value)}
                onKeyDown={handleEmailKeyDown}
                onBlur={handleEmailBlur}
                onPaste={handleEmailPaste}
                placeholder={emails.length === 0 ? t("sharing.placeholder.nameExampleComPressEnter") : ""}
                className="min-w-24 flex-1 bg-transparent text-xs outline-none"
                autoComplete="off"
              />
            </div>

            {/* The one control here that changes who can open the link, so it
                states the consequence rather than just naming a setting. */}
            <label className="mt-2.5 flex cursor-pointer items-start gap-2">
              <input
                type="checkbox"
                checked={restrictToRecipients}
                onChange={(e) => setRestrictToRecipients(e.target.checked)}
                className="mt-0.5 size-3.5 accent-[var(--color-primary)]"
                data-testid="restrict-to-recipients"
              />
              <span className="text-xs leading-snug">
                {t("sharing.label.onlyTheseRecipientsCanOpenIt")}
                <span className="block text-[11px] text-[var(--color-text-muted)]">
                  {restrictToRecipients
                    ? t("sharing.label.theyWillEachHaveToSignInToThe")
                    : t("sharing.description.offMeansAnyoneWithTheLinkCanOpenIt")}
                </span>
              </span>
            </label>
          </div>
        )}

        {/* Link tab */}
        {tab === "link" && !resultUrl && (
          <p className="text-xs text-[var(--color-text-muted)]">
            {isFolder
              ? t("sharing.description.anyoneWithTheLinkCanAccessThisFolder")
              : isBundle
                ? t("sharing.description.anyoneWithTheLinkCanAccessTheseFiles")
                : t("sharing.description.anyoneWithTheLinkCanAccessThisFile")}
          </p>
        )}

        {/* Expiry */}
        {!resultUrl && (
          <div>
            <label id="share-expiry-label" className="mb-1.5 block text-xs font-medium text-[var(--color-text-muted)]">{t("sharing.label.expiresIn")}</label>
            <ExpiryPicker
              value={expiry}
              onChange={setExpiry}
              isLocked={(v) => isFreePlan && isExpiryLockedOnFree(v)}
              lockedHint={t("sharing.label.freePlanLinksLastUpTo7Days")}
              labelledBy="share-expiry-label"
            />
            {isFreePlan && (
              <p className="mt-1.5 flex flex-wrap items-center gap-1 text-[11px] text-[var(--color-text-muted)]" data-testid="free-expiry-hint">
                <Lock size={12} aria-hidden="true" />
                {t("sharing.label.freePlanLinksLastUpTo7Days")}
                {distribution !== null && showsBillingTab(distribution) && (
                  <button
                    type="button"
                    onClick={() => window.open(webAppUrl("/billing?upgrade=1"), "_blank")}
                    className="font-medium text-[var(--color-text)] underline underline-offset-2"
                  >
                    {t("common.action.seePlans")}
                  </button>
                )}
              </p>
            )}
          </div>
        )}

        {/* Advanced options */}
        {!resultUrl && (
          <div>
            <button
              className="flex items-center gap-1 text-xs font-medium text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
              onClick={() => setShowAdvanced(!showAdvanced)}
            >
              <ChevronDown size={12} className={`transition-transform ${showAdvanced ? "rotate-180" : ""}`} />
              {t("sharing.action.advancedOptions")}
            </button>
            {showAdvanced && (
              <div className="mt-2 space-y-3">
                <div>
                  <label className="mb-1 block text-xs font-medium text-[var(--color-text-muted)]">
                    {t("sharing.label.passwordOptional")}
                  </label>
                  <input
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder={t("sharing.placeholder.min8Characters")}
                    className={inputCls}
                    style={borderStyle}
                    autoComplete="off"
                  />
                </div>
                <label className="flex cursor-pointer items-start gap-2">
                  <input
                    type="checkbox"
                    checked={stripMetadata}
                    onChange={(e) => setStripMetadata(e.target.checked)}
                    className="mt-0.5 size-3.5 accent-[var(--color-primary)]"
                    data-testid="strip-metadata"
                  />
                  <span className="text-xs leading-snug">
                    {t("sharing.label.removePhotoMetadata")}
                    <span className="block text-[11px] text-[var(--color-text-muted)]">
                      {t("sharing.description.photosAreHandedOverWithoutLocationCameraAndCapture")}
                    </span>
                  </span>
                </label>
                <div>
                  <label className="mb-1 block text-xs font-medium text-[var(--color-text-muted)]">
                    {t("sharing.label.titleOptional")}
                  </label>
                  <input
                    value={title}
                    onChange={(e) => setTitle(e.target.value)}
                    placeholder={t("sharing.placeholder.shareLinkTitle")}
                    className={inputCls}
                    style={borderStyle}
                  />
                </div>
                {tab === "email" && (
                  <div>
                    <label className="mb-1 block text-xs font-medium text-[var(--color-text-muted)]">
                      {t("common.label.messageOptional")}
                    </label>
                    <textarea
                      value={message}
                      onChange={(e) => setMessage(e.target.value)}
                      placeholder={t("sharing.placeholder.addAMessageForTheRecipient")}
                      className={`${inputCls} h-14 min-h-14 resize-y`}
                      style={borderStyle}
                    />
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* Result */}
        {resultUrl && (
          <div>
            <label className="mb-1.5 block text-xs font-medium text-[var(--color-text-muted)]">{t("sharing.label.shareLinkCreated")}</label>
            <div className="flex items-center gap-2 rounded-lg border bg-[var(--color-bg-secondary)] px-3 py-2" style={borderStyle}>
              <span dir="ltr" className="ltr-value flex-1 truncate font-mono text-[11px] text-[var(--color-text-muted)]">{resultUrl}</span>
              <button onClick={handleCopyUrl} className="shrink-0 text-xs font-semibold text-[var(--color-primary)] hover:opacity-80">
                <Copy size={14} />
              </button>
            </div>
          </div>
        )}

        {/* Error */}
        {error && (
          <div dir={errorRaw ? ownDir : undefined} className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-[var(--color-danger)]">
            {error}
          </div>
        )}
      </div>

      {isFolder && excludedCount > 0 && (
        <p className="mt-3 text-xs text-[var(--color-text-muted)]">
          {t("sharing.description.hiddenOrLockedItemInThisFolderOrIts", { excludedCount })}
        </p>
      )}

      <div className="mt-5 flex justify-end gap-2">
        <button onClick={close} className="rounded-lg border px-4 py-2 text-sm" style={borderStyle}>
          {t("common.cancel")}
        </button>
        {resultUrl ? (
          <button onClick={close} className="rounded-lg px-4 py-2 text-sm font-medium text-[var(--color-primary-fg)]" style={{ background: "var(--color-primary)" }}>
            {t("sharing.done")}
          </button>
        ) : (
          <button
            onClick={handleSubmit}
            disabled={submitting}
            className="flex items-center gap-1.5 rounded-lg px-4 py-2 text-sm font-medium text-[var(--color-primary-fg)] disabled:opacity-50"
            style={{ background: "var(--color-primary)" }}
          >
            {submitting ? <Loader2 size={14} className="animate-spin" /> : tab === "email" ? <Mail size={14} /> : <Link2 size={14} />}
            {submitting
              ? (tab === "email" ? t("common.status.sending") : t("common.status.creating"))
              : (tab === "email" ? t("sharing.action.send") : t("sharing.action.generateLink"))}
          </button>
        )}
      </div>
    </Modal>
  );
}
