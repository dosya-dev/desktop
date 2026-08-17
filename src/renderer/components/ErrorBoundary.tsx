import { Component, type ErrorInfo, type ReactNode } from "react";
import { AlertTriangle, RotateCw } from "lucide-react";

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
  /** Shown above the message; helps say *which* surface failed. */
  where?: string;
}

interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // console.error rather than a bespoke IPC channel: the main process
    // forwards renderer console output to its own log (see index.ts), so this
    // lands in the terminal output a user can already copy out of a bug report.
    console.error(
      `[render-error] ${this.props.where ?? "app"}: ${error.message}\n${error.stack ?? ""}\n${info.componentStack ?? ""}`,
    );
  }

  render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <div className="flex h-full min-h-64 flex-col items-center justify-center gap-3 p-8 text-center">
        <AlertTriangle size={28} className="text-[var(--color-warning)]" />
        <div>
          <p className="text-sm font-semibold">This page didn't load</p>
          <p className="mt-1 max-w-md text-xs text-[var(--color-text-muted)]">
            Something went wrong rendering {this.props.where ?? "this page"}. The rest of
            the app still works - use the sidebar to go somewhere else, or try again.
          </p>
        </div>
        {/* The message itself. Users paste this into bug reports, and it is the
            difference between "it went white" and an actionable report. */}
        <pre className="max-w-lg overflow-x-auto rounded-lg bg-[var(--color-bg-tertiary)] px-3 py-2 text-left text-[11px] text-[var(--color-text-secondary)]">
          {error.message}
        </pre>
        <button
          onClick={() => this.setState({ error: null })}
          className="flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-medium hover:bg-[var(--color-bg-secondary)]"
          style={{ borderColor: "var(--color-border)" }}
        >
          <RotateCw size={13} /> Try again
        </button>
      </div>
    );
  }
}
