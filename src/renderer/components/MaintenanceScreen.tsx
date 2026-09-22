import { useEffect, useState } from "react";
import { RefreshCw, Wrench } from "lucide-react";

/**
 * Full-screen gate shown when the platform switch has paused the desktop
 * surface. Ports apps/web/src/components/maintenance-screen.tsx: same shape
 * (amber tile, "from the team" message, self-refreshing countdown, manual
 * check, status page link, signed-in footer), but the desktop client only
 * ever sees ONE surface ("desktop" - see the X-Dosya-Client header), so the
 * copy is fixed rather than looked up from a surface->label map.
 *
 * An <a href> to an external URL would try to navigate the app window off
 * its own origin - the main process blocks that (will-navigate handler) - so
 * the status-page link is a button that goes through window.open(), which
 * main's setWindowOpenHandler forwards to shell.openExternal (see
 * LegalNotice.tsx for the established pattern).
 */

const INTERVAL_S = 60;
const STATUS_URL = "https://status.dosya.dev";

export function MaintenanceScreen({
  message,
  onRetry,
  email,
  onSignOut,
}: {
  message: string | null;
  onRetry: () => Promise<boolean>;
  email?: string | null;
  onSignOut?: () => void;
}) {
  const [left, setLeft] = useState(INTERVAL_S);
  const [checking, setChecking] = useState(false);

  const check = async () => {
    if (checking) return;
    setChecking(true);
    try {
      await onRetry();
    } finally {
      setChecking(false);
      setLeft(INTERVAL_S);
    }
  };

  useEffect(() => {
    const id = setInterval(() => setLeft((n) => (n <= 1 ? 0 : n - 1)), 1000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    if (left === 0) void check();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [left]);

  const mm = Math.floor(left / 60);
  const ss = String(left % 60).padStart(2, "0");
  const progress = ((INTERVAL_S - left) / INTERVAL_S) * 100;

  return (
    <div
      className="flex h-screen flex-col items-center justify-center bg-[var(--color-bg)] px-6 py-10 text-center text-[var(--color-text)]"
      data-testid="maintenance-screen"
    >
      <div
        className="mb-5 flex h-14 w-14 items-center justify-center rounded-2xl"
        style={{
          background: "color-mix(in oklab, var(--color-warning), transparent 85%)",
          border: "1px solid color-mix(in oklab, var(--color-warning), transparent 55%)",
          color: "var(--color-warning)",
        }}
      >
        <Wrench className="h-7 w-7" />
      </div>
      <h1 className="mb-2 text-2xl font-bold tracking-tight">
        The desktop app is paused for maintenance
      </h1>
      <p className="mb-5 max-w-md text-[var(--color-text-secondary)]">
        Sync is paused and your local files are untouched. We&apos;ll reconnect and pick up where
        we left off.
      </p>
      {message && (
        <div
          className="mb-6 w-full max-w-md rounded-xl p-4 text-left"
          style={{
            background: "color-mix(in oklab, var(--color-warning), transparent 90%)",
            border: "1px solid color-mix(in oklab, var(--color-warning), transparent 55%)",
          }}
        >
          <div
            className="mb-1 font-mono text-[11px] uppercase tracking-wider"
            style={{ color: "var(--color-warning)" }}
          >
            From the team
          </div>
          <div className="whitespace-pre-wrap">{message}</div>
        </div>
      )}
      <div className="mb-3 h-1 w-full max-w-xs overflow-hidden rounded-full bg-[var(--color-bg-tertiary)]">
        <div
          className="h-full transition-[width] duration-1000 ease-linear"
          style={{ width: `${progress}%`, background: "var(--color-warning)" }}
        />
      </div>
      <div className="mb-4 font-mono text-sm tabular-nums text-[var(--color-text-secondary)]">
        {checking ? "Checking…" : `Checking again in ${mm}:${ss}`}
      </div>
      <div className="flex flex-wrap justify-center gap-3">
        <button
          type="button"
          onClick={check}
          disabled={checking}
          className="flex items-center gap-1.5 rounded-lg px-4 py-2 text-sm font-medium text-white disabled:opacity-60"
          style={{ background: "var(--color-primary)" }}
        >
          <RefreshCw className="h-4 w-4" />
          Check now
        </button>
        <button
          type="button"
          onClick={() => window.open(STATUS_URL, "_blank")}
          className="rounded-lg border px-4 py-2 text-sm font-medium hover:bg-[var(--color-bg-secondary)]"
          style={{ borderColor: "var(--color-border)" }}
        >
          Status page
        </button>
      </div>
      {email && (
        <div
          className="mt-10 w-full max-w-md border-t pt-4 text-sm text-[var(--color-text-secondary)]"
          style={{ borderColor: "var(--color-border)" }}
        >
          Signed in as {email}
          {onSignOut && (
            <>
              {" "}
              ·{" "}
              <button
                type="button"
                className="underline underline-offset-2"
                onClick={onSignOut}
              >
                Sign out
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
