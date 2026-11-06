import { useEffect, useRef, useState } from "react";
import { Download, Loader2 } from "lucide-react";
import { apiBase } from "@/lib/api-client";
import { useT } from "@/lib/i18n";
import type { MessageKey } from "../../../i18n/keys";

/**
 * Office documents render as the PDF the server converts them to, in the same
 * iframe the PDF branch uses. This component owns only the waiting.
 *
 * The conversion is asynchronous, and its failure paths read differently:
 *
 *  - 503 + Retry-After: still converting. Not an error - showing one would make
 *    every large document look broken for the seconds it takes.
 *  - 422 with code "too_large": above the 50MB source cap. Keyed on the code
 *    rather than the status, so a client does not mislabel an ordinary large
 *    deck as an unknown error.
 *  - 415: the type cannot be converted; fall back to a download.
 *  - 403 / 404: locked, or missing. Deliberately NOT folded into "unsupported" -
 *    telling someone their file cannot be previewed when it is actually locked
 *    is a lie.
 *
 * The attempt bound is derived, not chosen: the server's conversion lock is 60s
 * and it asks for a 3s retry, so 20 attempts covers the longest legitimate
 * conversion. Past that the lock is presumed abandoned.
 *
 * Read-only. Editing is the ONLYOFFICE web editor.
 */
const MAX_ATTEMPTS = 20;
const RETRY_MS = 3000;

type State =
  | { kind: "preparing" }
  | { kind: "ready"; url: string }
  | { kind: "too-large" }
  | { kind: "unsupported" }
  | { kind: "failed"; message: MessageKey };

export function OfficePreview({ file, version, onDownload }: {
  file: { id: string; name: string };
  version?: number;
  /** Offered on every failure state, whose copy tells the user to download. */
  onDownload?: () => void;
}) {
  const t = useT();
  const [state, setState] = useState<State>({ kind: "preparing" });
  const objectUrl = useRef<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    // `version` undefined means current - the cached conversion. An explicit
    // version asks the server to convert THAT rendition (supported, uncached
    // server-side); without it the panel's version picker changed nothing.
    const url = `${apiBase()}/api/files/${file.id}/preview-pdf${version ? `?version=${version}` : ""}`;
    setState({ kind: "preparing" });

    (async () => {
      for (let attempt = 0; attempt < MAX_ATTEMPTS && !cancelled; attempt++) {
        let res: Response;
        try {
          res = await fetch(url, { credentials: "include" });
        } catch {
          if (!cancelled) setState({ kind: "failed", message: "common.error.couldNotReachTheServer" });
          return;
        }
        if (cancelled) return;

        if (res.status === 200) {
          const blob = await res.blob();
          if (cancelled) return;
          objectUrl.current = URL.createObjectURL(blob);
          setState({ kind: "ready", url: objectUrl.current });
          return;
        }
        if (res.status === 503) {
          await new Promise((r) => setTimeout(r, RETRY_MS));
          continue;
        }
        if (res.status === 422) {
          const body = (await res.json().catch(() => ({}))) as { code?: string };
          setState(
            body.code === "too_large"
              ? { kind: "too-large" }
              : { kind: "failed", message: "common.error.couldNotPrepareAPreview" },
          );
          return;
        }
        if (res.status === 415) {
          setState({ kind: "unsupported" });
          return;
        }
        setState({ kind: "failed", message: "common.error.couldNotPrepareAPreviewForThisFile" });
        return;
      }
      if (!cancelled) {
        setState({
          kind: "failed",
          message: "common.error.thisPreviewIsTakingTooLongDownloadTheFile",
        });
      }
    })();

    return () => {
      cancelled = true;
      if (objectUrl.current) {
        URL.revokeObjectURL(objectUrl.current);
        objectUrl.current = null;
      }
    };
  }, [file.id, version]);

  if (state.kind === "ready") {
    return (
      <div dir="ltr" className="h-full w-full">
        <iframe
          data-testid="office-frame"
          src={`${state.url}#toolbar=1`}
          className="h-full w-full rounded-md border-none bg-white"
          title={t("common.tooltip.previewFileName", { fileName: file.name })}
        />
      </div>
    );
  }

  const copy =
    state.kind === "preparing" ? t("common.status.preparingPreview")
    : state.kind === "too-large" ? t("common.error.thisFileIsTooLargeToPreviewDownloadIt")
    : state.kind === "unsupported" ? t("common.error.thisFileTypeCannotBePreviewedDownloadItInstead")
    : t(state.message);

  return (
    <div
      data-testid={`office-${state.kind}`}
      className="flex h-full w-full flex-col items-center justify-center gap-3 text-sm text-[var(--color-text-secondary)]"
    >
      {state.kind === "preparing" && <Loader2 size={18} className="animate-spin" />}
      <p className="max-w-xs text-center">{copy}</p>
      {state.kind !== "preparing" && onDownload && (
        <button
          type="button"
          data-testid="office-download"
          onClick={onDownload}
          className="flex h-8 items-center gap-1.5 rounded-md border px-3 text-xs font-medium text-[var(--color-text)] hover:bg-[var(--color-bg-tertiary)]"
          style={{ borderColor: "var(--color-border)" }}
        >
          <Download size={14} /> {t("common.action.download")}
        </button>
      )}
    </div>
  );
}
