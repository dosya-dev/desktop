import { useEffect, useMemo, useState } from "react";
import { useLocation } from "react-router-dom";
import { Bug, Camera, Info, X } from "lucide-react";
import { toast } from "sonner";
import { Modal } from "./files/Modal";
import { apiRequest } from "../lib/api-client";
import { useAuth } from "../lib/auth-context";
import { useWorkspace } from "../lib/workspace-context";
import { useReportProblem } from "../lib/report-problem-store";
import {
  collectDesktopDiagnostics, composeBody, diagnosticsRows, summariseSync,
  BODY_MAX, type DiagnosticsInfo,
} from "../lib/bug-report";

/** Spec: the last 200 lines. Mirrors LOG_TAIL_LINES in src/main/bug-report.ts. */
const LOG_LINES = 200;
/** The server will not accept an image bigger than this; skip it rather than
 *  let an oversized attachment take the whole ticket down. */
const SCREENSHOT_MAX_BYTES = 4_500_000;

/**
 * The bug-report form (spec: direction B's form, A's destination). One text
 * field, a window screenshot (on by default), a diagnostics card the user can
 * untick, the log tail under its own toggle (off by default: it names files in
 * the synced folders), Send. No subject: the server derives it. Mount once in
 * App; open it with openReport().
 */
export function ReportProblemDialog() {
  const open = useReportProblem((s) => s.open);
  const prefill = useReportProblem((s) => s.prefill);
  const closeReport = useReportProblem((s) => s.closeReport);
  const { active } = useWorkspace();
  const { isAuthenticated } = useAuth();
  const location = useLocation();

  const [text, setText] = useState("");
  const [includeDiagnostics, setIncludeDiagnostics] = useState(true);
  const [includeScreenshot, setIncludeScreenshot] = useState(true);
  const [includeLog, setIncludeLog] = useState(false);
  const [sending, setSending] = useState(false);
  const [info, setInfo] = useState<DiagnosticsInfo | null>(null);
  const [sync, setSync] = useState<string | null>(null);

  // Fresh state on every open (React's "adjust state during render" pattern,
  // not an effect: the repo's lint rules refuse setState in effects).
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setText(""); setIncludeDiagnostics(true); setIncludeScreenshot(true); setIncludeLog(false); setSending(false);
      setInfo(null); setSync(null);
    }
  }

  // Device facts and the sync summary are read from main when the dialog
  // opens, so the card shows what will be sent before Send is pressed.
  useEffect(() => {
    if (!open) return;
    let alive = true;
    void (async () => {
      const [i, s] = await Promise.allSettled([
        window.electronAPI.getDiagnosticsInfo(),
        window.electronAPI.getSyncStatus(),
      ]);
      if (!alive) return;
      setInfo(i.status === "fulfilled" ? i.value : null);
      setSync(s.status === "fulfilled" ? summariseSync(s.value as Parameters<typeof summariseSync>[0]) : null);
    })();
    return () => { alive = false; };
  }, [open]);

  // `prefill` is a fresh object per openReport() call, which is what re-runs
  // this (so captured_at is fresh per open); a memoised prefill would freeze it.
  const diagnostics = useMemo(() => collectDesktopDiagnostics({
    info, sync,
    workspaceId: active?.id ?? null,
    page: prefill.page ?? location.pathname,
    errorRef: prefill.errorRef ?? null,
    errorMessage: prefill.errorMessage ?? null,
  }), [info, sync, active?.id, prefill, location.pathname]);
  const rows = useMemo(() => diagnosticsRows(diagnostics), [diagnostics]);

  if (!open) return null;

  if (!isAuthenticated) {
    return (
      <Modal onClose={closeReport} maxWidth={420}>
        <div role="dialog" aria-modal="true" aria-labelledby="report-problem-title" className="space-y-4">
          <div className="flex items-start justify-between gap-3">
            <h2 id="report-problem-title" className="text-base font-semibold">Report a bug</h2>
            <button type="button" aria-label="Close" onClick={closeReport} className="rounded-md p-1 hover:bg-[var(--color-bg-secondary)]"><X size={16} /></button>
          </div>
          <p className="text-sm text-[var(--color-text-muted)]">
            Sign in first, then open Help &gt; Report a problem again. Your report is sent as a support ticket on your account.
          </p>
          <div className="flex justify-end">
            <button type="button" onClick={closeReport} className="rounded-lg border px-4 py-2 text-sm font-medium" style={{ borderColor: "var(--color-border)" }}>Close</button>
          </div>
        </div>
      </Modal>
    );
  }

  const send = async () => {
    const trimmed = text.trim();
    if (!trimmed || sending) return;
    setSending(true);
    try {
      const fd = new FormData();
      fd.append("subject", "");
      fd.append("category", "bug");
      if (active?.id) fd.append("workspace_id", active.id);
      let logTail: string | null = null;
      if (includeLog) {
        try { logTail = await window.electronAPI.readLogTail(); } catch { logTail = null; }
      }
      fd.append("body", composeBody(trimmed, logTail, LOG_LINES).slice(0, BODY_MAX));
      if (includeDiagnostics) fd.append("diagnostics", JSON.stringify(diagnostics));
      if (includeScreenshot) {
        // Best effort: a minimised or vanished window, an empty capture or an
        // oversized image is not a reason to lose the report. The user is
        // told, the ticket still goes.
        try {
          const bytes = await window.electronAPI.captureWindow();
          if (bytes.byteLength > SCREENSHOT_MAX_BYTES) {
            toast.info("Screenshot skipped", { description: "The window image was too large to attach. Your report was sent without it." });
          } else {
            fd.append("images", new File([bytes as BlobPart], "window.jpg", { type: "image/jpeg" }));
          }
        } catch {
          toast.info("Screenshot skipped", { description: "The window could not be captured. Your report was sent without it." });
        }
      }
      const res = await apiRequest<{ ok: boolean; ticket: { id: string } }>("/api/support/tickets", { method: "POST", body: fd });
      const ticketId = res?.ticket?.id?.slice(0, 8) ?? "";
      const description = ticketId
        ? `Thank you. We reply at your account email. Ticket ${ticketId}.`
        : "Thank you. We reply at your account email.";
      closeReport();
      toast.success("Report sent", { description });
    } catch (err) {
      toast.error("Could not send report", {
        description: err instanceof Error ? err.message : "Please try again in a moment.",
      });
      setSending(false);
    }
  };

  const rowClass = "flex items-start justify-between gap-3 py-1.5 text-xs";
  const check = (id: string, checked: boolean, onChange: (v: boolean) => void, label: string, hint?: string) => (
    <label className="flex items-start gap-2 text-sm">
      <input
        type="checkbox"
        data-testid={id}
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        disabled={sending}
        className="mt-0.5"
      />
      <span>
        <span className="font-medium">{label}</span>
        {hint && <span className="block text-xs text-[var(--color-text-muted)]">{hint}</span>}
      </span>
    </label>
  );

  return (
    <Modal onClose={() => { if (!sending) closeReport(); }} maxWidth={560}>
      <div role="dialog" aria-modal="true" aria-labelledby="report-problem-title" className="space-y-4">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-2">
            <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-[var(--color-bg-secondary)]"><Bug size={16} /></span>
            <div>
              <h2 id="report-problem-title" className="text-base font-semibold">Report a bug</h2>
              <p className="text-xs text-[var(--color-text-muted)]">Creates a support ticket you can follow on the web.</p>
            </div>
          </div>
          <button type="button" aria-label="Close" onClick={() => !sending && closeReport()} className="rounded-md p-1 hover:bg-[var(--color-bg-secondary)]"><X size={16} /></button>
        </div>

        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="What went wrong? What did you expect instead?"
          rows={4}
          maxLength={BODY_MAX}
          autoFocus
          aria-label="What went wrong"
          className="w-full rounded-lg border bg-[var(--color-bg)] px-3 py-2 text-sm"
          style={{ borderColor: "var(--color-border)" }}
        />

        <div className="space-y-2">
          {check("include-screenshot", includeScreenshot, setIncludeScreenshot, "Attach a screenshot of this window", "Taken when you press Send.")}
          {check("include-log", includeLog, setIncludeLog, `Include the recent log (last ${LOG_LINES} lines)`, "Holds file names from your synced folders.")}
        </div>

        <div className="rounded-lg border p-3" style={{ borderColor: "var(--color-border)", background: "var(--color-bg-secondary)" }}>
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2 text-sm font-medium"><Info size={14} /> Diagnostics</div>
            {check("include-diagnostics", includeDiagnostics, setIncludeDiagnostics, "Include")}
          </div>
          <dl className="mt-2 divide-y" style={{ borderColor: "var(--color-border)" }}>
            {rows.map((r, i) => (
              <div key={`${i}-${r.label}`} className={rowClass}>
                <dt className="text-[var(--color-text-muted)]">{r.label}</dt>
                <dd className="text-right font-mono break-all">{r.value}</dd>
              </div>
            ))}
          </dl>
          <p className="mt-2 text-xs text-[var(--color-text-muted)]">Nothing from your files is included.</p>
        </div>

        <div className="flex justify-end gap-2">
          <button type="button" onClick={() => !sending && closeReport()} disabled={sending} className="rounded-lg border px-4 py-2 text-sm font-medium" style={{ borderColor: "var(--color-border)" }}>Cancel</button>
          <button
            type="button"
            onClick={send}
            disabled={sending || !text.trim()}
            className="inline-flex items-center gap-2 rounded-lg bg-[var(--color-primary)] px-4 py-2 text-sm font-medium text-[var(--color-primary-fg)] disabled:opacity-50"
          >
            <Camera size={14} /> {sending ? "Sending…" : "Send report"}
          </button>
        </div>
      </div>
    </Modal>
  );
}
