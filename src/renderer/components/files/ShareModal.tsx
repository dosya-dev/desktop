// Ported from apps/web/src/components/share-modal.tsx - keep in sync with the web copy.
import { useState, useRef, useCallback, useEffect } from "react";
import { Mail, Link2, X, Loader2, Copy, ChevronDown, Files, Folder } from "lucide-react";
import { toast } from "sonner";
import { api, ApiError } from "@/lib/api-client";
import { Modal } from "@/components/files/Modal";

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

const EXPIRY_OPTIONS = [
  { value: "0", label: "Never" },
  { value: "1", label: "1 day" },
  { value: "7", label: "7 days" },
  { value: "30", label: "30 days" },
  { value: "90", label: "90 days" },
];

export function ShareModal({ open, target, name, onClose }: ShareModalProps) {
  const isFolder = target?.kind === "folder";
  const isBundle = target?.kind === "bundle";
  const [excludedCount, setExcludedCount] = useState(0);
  const [tab, setTab] = useState<Tab>("email");
  const [emails, setEmails] = useState<string[]>([]);
  const [emailInput, setEmailInput] = useState("");
  const [expiry, setExpiry] = useState("7");
  const [password, setPassword] = useState("");
  const [title, setTitle] = useState("");
  const [message, setMessage] = useState("");
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [resultUrl, setResultUrl] = useState("");
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
      setError("Add at least one email address.");
      emailRef.current?.focus();
      return;
    }

    const pw = password.trim();
    if (pw && pw.length < 8) {
      setError("Password must be at least 8 characters.");
      return;
    }

    setSubmitting(true);
    const expiryDays = Number(expiry);

    try {
      if (tab === "email") {
        // "bundle" exists only for type parity with web's ShareTarget - no
        // desktop caller builds one yet, and the body below is still shaped
        // for a single recipient per call with no file_ids, so this branch
        // would 400 if a bundle target were ever actually submitted here.
        const endpoint = target.kind === "folder"
          ? `/api/folders/${target.folderId}/share-email`
          : target.kind === "bundle"
            ? "/api/files/share-bundle"
            : `/api/files/${target.fileIds[0]}/share-email`;

        const body: Record<string, unknown> = {
          email: emails[0],
          message: message.trim(),
        };
        if (pw) body.password = pw;
        if (expiryDays > 0) body.expires_in_days = expiryDays;

        const res = await api.post<{ ok: boolean; error?: string }>(endpoint, body);

        // Send to remaining emails
        for (let i = 1; i < emails.length; i++) {
          await api.post(endpoint, { ...body, email: emails[i] }).catch(() => {});
        }

        if (res.ok) {
          toast.success("Share sent", { description: `Shared with ${emails.length} recipient${emails.length === 1 ? "" : "s"}.` });
          close();
        } else {
          setError(res.error ?? "Could not send.");
          setSubmitting(false);
        }
      } else {
        // Same bundle caveat as the email endpoint above: no desktop caller
        // builds a "bundle" target yet, and linkBody below has no file_ids,
        // so this branch would 400 if one were ever submitted here.
        const endpoint = target.kind === "folder"
          ? `/api/folders/${target.folderId}/share`
          : target.kind === "bundle"
            ? "/api/files/share-bundle"
            : `/api/files/${target.fileIds[0]}/share`;

        const linkBody: Record<string, unknown> = {};
        if (expiryDays > 0) linkBody.expires_in_days = expiryDays;
        if (pw) linkBody.password = pw;

        const data = await api.post<{ ok: boolean; link?: { url: string }; error?: string }>(endpoint, linkBody);

        if (data.ok && data.link) {
          setResultUrl(data.link.url);
          try {
            await navigator.clipboard.writeText(data.link.url);
            toast.success("Link copied", { description: "Share link copied to clipboard." });
          } catch {
            toast.info("Link created", { description: "Share link created." });
          }
          setSubmitting(false);
        } else {
          setError(data.error ?? "Something went wrong.");
          setSubmitting(false);
        }
      }
    } catch (err) {
      // Surface the API's real message (e.g. "This file is fully locked and
      // cannot be shared", 403) instead of a generic network error.
      setError(err instanceof ApiError ? err.message : "Something went wrong.");
      setSubmitting(false);
    }
  };

  const handleCopyUrl = async () => {
    try {
      await navigator.clipboard.writeText(resultUrl);
      toast.success("Link copied", { description: "Copied to clipboard." });
    } catch {}
  };

  if (!open) return null;

  const inputCls = "w-full rounded-lg border px-3 py-2 text-xs outline-none focus:border-[var(--color-primary)]";
  const borderStyle = { borderColor: "var(--color-border)" };

  return (
    <Modal onClose={close}>
      <h3 className="mb-3 text-lg font-semibold">Share</h3>

      {/* Tabs */}
      <div className="-mx-6 mb-3 flex border-b" style={borderStyle}>
        {([["email", "By email", Mail], ["link", "By link", Link2]] as const).map(([value, label, Icon]) => (
          <button
            key={value}
            onClick={() => setTab(value)}
            className={`flex flex-1 items-center justify-center gap-1.5 py-2.5 text-xs font-medium transition-colors ${
              tab === value
                ? "border-b-2 border-[var(--color-primary)] text-[var(--color-primary)]"
                : "text-[var(--color-text-secondary)]"
            }`}
          >
            <Icon size={14} /> {label}
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
        <span className="truncate font-medium text-[var(--color-text)]">{name}</span>
      </div>

      <div className="space-y-3">
        {/* Email tab */}
        {tab === "email" && (
          <div>
            <label className="mb-1.5 block text-xs font-medium text-[var(--color-text-muted)]">Recipients</label>
            <div
              className="flex min-h-9 cursor-text flex-wrap gap-1 rounded-lg border px-2 py-1.5 focus-within:border-[var(--color-primary)]"
              style={borderStyle}
              onClick={() => emailRef.current?.focus()}
            >
              {emails.map((e, i) => (
                <span key={i} className="inline-flex items-center gap-1 rounded bg-[var(--color-bg-tertiary)] px-1.5 py-0.5 text-[11px] font-medium">
                  {e}
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
                placeholder={emails.length === 0 ? "name@example.com, press Enter" : ""}
                className="min-w-24 flex-1 bg-transparent text-xs outline-none"
                autoComplete="off"
              />
            </div>
          </div>
        )}

        {/* Link tab */}
        {tab === "link" && !resultUrl && (
          <p className="text-xs text-[var(--color-text-muted)]">
            Anyone with the link can access {isFolder ? "this folder" : isBundle ? "these files" : "this file"}.
          </p>
        )}

        {/* Expiry */}
        {!resultUrl && (
          <div>
            <label className="mb-1.5 block text-xs font-medium text-[var(--color-text-muted)]">Expires in</label>
            <select
              value={expiry}
              onChange={(e) => setExpiry(e.target.value)}
              className="h-9 w-full rounded-lg border bg-[var(--color-bg)] px-2.5 text-xs outline-none"
              style={borderStyle}
            >
              {EXPIRY_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>{opt.label}</option>
              ))}
            </select>
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
              Advanced options
            </button>
            {showAdvanced && (
              <div className="mt-2 space-y-3">
                <div>
                  <label className="mb-1 block text-xs font-medium text-[var(--color-text-muted)]">
                    Password <span className="font-normal">(optional)</span>
                  </label>
                  <input
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="Min 8 characters"
                    className={inputCls}
                    style={borderStyle}
                    autoComplete="off"
                  />
                </div>
                <div>
                  <label className="mb-1 block text-xs font-medium text-[var(--color-text-muted)]">
                    Title <span className="font-normal">(optional)</span>
                  </label>
                  <input
                    value={title}
                    onChange={(e) => setTitle(e.target.value)}
                    placeholder="Share link title"
                    className={inputCls}
                    style={borderStyle}
                  />
                </div>
                {tab === "email" && (
                  <div>
                    <label className="mb-1 block text-xs font-medium text-[var(--color-text-muted)]">
                      Message <span className="font-normal">(optional)</span>
                    </label>
                    <textarea
                      value={message}
                      onChange={(e) => setMessage(e.target.value)}
                      placeholder="Add a message for the recipient..."
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
            <label className="mb-1.5 block text-xs font-medium text-[var(--color-text-muted)]">Share link created</label>
            <div className="flex items-center gap-2 rounded-lg border bg-[var(--color-bg-secondary)] px-3 py-2" style={borderStyle}>
              <span className="flex-1 truncate font-mono text-[11px] text-[var(--color-text-muted)]">{resultUrl}</span>
              <button onClick={handleCopyUrl} className="shrink-0 text-xs font-semibold text-[var(--color-primary)] hover:opacity-80">
                <Copy size={14} />
              </button>
            </div>
          </div>
        )}

        {/* Error */}
        {error && (
          <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-[var(--color-danger)]">
            {error}
          </div>
        )}
      </div>

      {isFolder && excludedCount > 0 && (
        <p className="mt-3 text-xs text-[var(--color-text-muted)]">
          {excludedCount} hidden or locked {excludedCount === 1 ? "item" : "items"} in this
          folder or its subfolders will not be shared.
        </p>
      )}

      <div className="mt-5 flex justify-end gap-2">
        <button onClick={close} className="rounded-lg border px-4 py-2 text-sm" style={borderStyle}>
          Cancel
        </button>
        {resultUrl ? (
          <button onClick={close} className="rounded-lg px-4 py-2 text-sm font-medium text-white" style={{ background: "var(--color-primary)" }}>
            Done
          </button>
        ) : (
          <button
            onClick={handleSubmit}
            disabled={submitting}
            className="flex items-center gap-1.5 rounded-lg px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
            style={{ background: "var(--color-primary)" }}
          >
            {submitting ? <Loader2 size={14} className="animate-spin" /> : tab === "email" ? <Mail size={14} /> : <Link2 size={14} />}
            {submitting ? (tab === "email" ? "Sending..." : "Creating...") : (tab === "email" ? "Send" : "Generate link")}
          </button>
        )}
      </div>
    </Modal>
  );
}
