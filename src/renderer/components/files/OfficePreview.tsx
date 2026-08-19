import { useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { apiBase } from "@/lib/api-client";

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
  | { kind: "failed"; message: string };

export function OfficePreview({ file, version }: { file: { id: string; name: string }; version?: number }) {
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
          if (!cancelled) setState({ kind: "failed", message: "Could not reach the server." });
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
              : { kind: "failed", message: "Could not prepare a preview." },
          );
          return;
        }
        if (res.status === 415) {
          setState({ kind: "unsupported" });
          return;
        }
        setState({ kind: "failed", message: "Could not prepare a preview for this file." });
        return;
      }
      if (!cancelled) {
        setState({
          kind: "failed",
          message: "This preview is taking too long. Download the file instead.",
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
      <iframe
        data-testid="office-frame"
        src={`${state.url}#toolbar=1`}
        className="h-full w-full rounded-md border-none bg-white"
        title={`Preview: ${file.name}`}
      />
    );
  }

  const copy =
    state.kind === "preparing" ? "Preparing preview…"
    : state.kind === "too-large" ? "This file is too large to preview. Download it instead."
    : state.kind === "unsupported" ? "This file type cannot be previewed. Download it instead."
    : state.message;

  return (
    <div
      data-testid={`office-${state.kind}`}
      className="flex h-full w-full flex-col items-center justify-center gap-3 text-sm text-[var(--color-text-secondary)]"
    >
      {state.kind === "preparing" && <Loader2 size={18} className="animate-spin" />}
      <p className="max-w-xs text-center">{copy}</p>
    </div>
  );
}
