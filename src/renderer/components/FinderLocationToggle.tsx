import { useEffect, useState } from "react";

/**
 * Turns the Finder location on and off.
 *
 * Renders nothing unless the main process says a location is possible: that is
 * false on Windows and Linux, on macOS 11, and on any build without the native
 * addon, and a switch that cannot do anything is worse than no switch.
 *
 * The preference lives in the main process, not here, because the main process
 * is what acts on it at sign-in and at sign-out.
 */
export function FinderLocationToggle({ userId }: { userId: string | null }): React.ReactElement | null {
  const [available, setAvailable] = useState(false);
  const [enabled, setEnabled] = useState(false);
  const [busy, setBusy] = useState(false);
  /** The switch is on but the extension has no session yet. */
  const [pending, setPending] = useState(false);
  /** The location exists but macOS is waiting for the user to approve it. */
  const [needsApproval, setNeedsApproval] = useState(false);

  useEffect(() => {
    let cancelled = false;
    // Promise.resolve, because a preload older than this API returns undefined and
    // an effect that throws takes the whole tree down.
    void Promise.resolve(window.electronAPI?.fileProvider?.status())
      .then((s) => {
        if (!s) return;
        if (cancelled) return;
        setAvailable(s.available);
        setEnabled(s.enabled);
        setNeedsApproval(Boolean(s.needsApproval));
      })
      .catch(() => {
        // No status means no switch, which is what the initial state already is.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (!available) return null;

  const toggle = async (): Promise<void> => {
    const next = !enabled;
    setBusy(true);
    setEnabled(next);
    setPending(false);
    try {
      const result = await window.electronAPI.fileProvider.setEnabled(next, userId ?? undefined);
      setEnabled(result.enabled);
      setNeedsApproval(Boolean(result.needsApproval));
      // The main process stored the preference but could not link: the mint is
      // rate limited and it needs the network. The preference stays on, because
      // it is what was asked for and the next sign-in retries it, but a switch
      // that is on with no location has to say so.
      setPending(result.enabled && result.linked === false);
    } catch {
      // Put it back: a switch showing what was asked for while the app is in the
      // other state is worse than one that did not move.
      setEnabled(!next);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex items-start justify-between gap-4">
      <div>
        <p className="text-sm font-medium">Show dosya in Finder</p>
        <p className="text-xs text-[var(--color-text-muted)]">
          Adds dosya.dev under Locations in the Finder sidebar. Files download when you open them.
        </p>
        {needsApproval && (
          <p className="mt-1 text-xs text-[var(--color-warning)]">
            macOS is waiting for you to approve dosya under File Providers. Until then the location
            appears but stays empty.
          </p>
        )}
        {pending && !needsApproval && (
          <p className="mt-1 text-xs text-[var(--color-warning)]">
            Not set up yet. dosya will try again the next time you sign in.
          </p>
        )}
      </div>
      {needsApproval && (
        <button
          onClick={() => {
            void Promise.resolve(window.electronAPI?.fileProvider?.openSettings()).catch(() => {});
          }}
          className="shrink-0 self-center rounded-lg border px-3 py-1.5 text-xs font-medium hover:bg-[var(--color-bg-secondary)]"
          style={{ borderColor: "var(--color-border)" }}
        >
          Open System Settings
        </button>
      )}
      <button
        role="switch"
        aria-checked={enabled}
        aria-label="Show dosya in Finder"
        disabled={busy}
        onClick={toggle}
        className={`relative h-6 w-11 shrink-0 rounded-full transition-colors ${enabled ? "bg-[var(--color-primary)]" : "bg-[var(--color-border)]"}`}
      >
        <div
          className={`absolute top-0.5 h-5 w-5 rounded-full bg-[var(--color-bg)] shadow transition-transform ${enabled ? "translate-x-5" : "translate-x-0.5"}`}
        />
      </button>
    </div>
  );
}
