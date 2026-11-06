import { Component, type ErrorInfo, type ReactNode } from "react";
import { AlertTriangle, Bug, RotateCw } from "lucide-react";
import { reportError } from "../lib/sentry";
import { openReport } from "../lib/report-problem-store";
import { useT } from "@/lib/i18n";
import { useAutoDir } from "@/lib/bidi-ui";

/**
 * Catches a render-time throw so one broken page cannot take down the app.
 *
 * Written after a blocked CSP worker on the map page did exactly that: MapLibre
 * threw inside a passive effect, nothing caught it, React unmounted the whole
 * tree, and the user got a white window with no message, no way back, and
 * nothing in the main-process log. The bug was a one-line CSP fix; finding it
 * took a remote debugger, because the failure erased its own evidence.
 *
 * A boundary cannot catch everything - errors in event handlers and in async
 * callbacks that have already left the render path do not reach it - so this is
 * a floor under the damage, not a promise that nothing escapes.
 */

interface Props {
  children: ReactNode;
  /** Names the surface in the console log and the crash report. */
  where?: string;
  /** Which sentence the user reads: a page failed, or the app itself. */
  surface?: "page" | "app";
}

interface State {
  error: Error | null;
  eventId: string | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, eventId: null };

  static getDerivedStateFromError(error: Error): State {
    return { error, eventId: null };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // console.error rather than a bespoke IPC channel: the main process
    // forwards renderer console output to its own log (see index.ts), so this
    // lands in the terminal output a user can already copy out of a bug report.
    console.error(
      `[render-error] ${this.props.where ?? "app"}: ${error.message}\n${error.stack ?? ""}\n${info.componentStack ?? ""}`,
    );
    // React swallows a boundary-caught error before the SDK's global handler
    // sees it, so without this line the crash never leaves the machine.
    const id = reportError(error, { where: this.props.where ?? "app", componentStack: info.componentStack ?? "" });
    this.setState({ eventId: typeof id === "string" && id.length > 0 ? id : null });
  }

  render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <ErrorFallback
        error={error}
        surface={this.props.surface ?? "page"}
        onRetry={() => this.setState({ error: null, eventId: null })}
        onReport={() => openReport({ errorRef: this.state.eventId, errorMessage: error.message })}
      />
    );
  }
}

/** The fallback itself: a function component, so it follows a language switch. */
function ErrorFallback({
  error,
  surface,
  onRetry,
  onReport,
}: {
  error: Error;
  surface: "page" | "app";
  onRetry: () => void;
  onReport: () => void;
}) {
  const ownDir = useAutoDir();
  const t = useT();
  return (
    <div className="flex h-full min-h-64 flex-col items-center justify-center gap-3 p-8 text-center">
      <AlertTriangle size={28} className="text-[var(--color-warning)]" />
      <div>
        <p className="text-sm font-semibold">{t("common.error.thisPageDidnTLoad")}</p>
        <p className="mt-1 max-w-md text-xs text-[var(--color-text-muted)]">
          {t("common.error.somethingWentWrongRenderingThisPageTheRestOf", { surface })}
        </p>
      </div>
      {/* The message itself. Users paste this into bug reports, and it is the
          difference between "it went white" and an actionable report. */}
      <pre translate="no" dir={ownDir} className="max-w-lg overflow-x-auto rounded-lg bg-[var(--color-bg-tertiary)] px-3 py-2 text-start text-[11px] text-[var(--color-text-secondary)]">
        {error.message}
      </pre>
      <div className="flex items-center gap-2">
        <button
          onClick={onRetry}
          className="flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-medium hover:bg-[var(--color-bg-secondary)]"
          style={{ borderColor: "var(--color-border)" }}
        >
          <RotateCw size={13} /> {t("common.action.tryAgain")}
        </button>
        <button
          onClick={onReport}
          className="flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-medium hover:bg-[var(--color-bg-secondary)]"
          style={{ borderColor: "var(--color-border)" }}
        >
          <Bug size={13} /> {t("common.action.reportThisProblem")}
        </button>
      </div>
    </div>
  );
}
