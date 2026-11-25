import { useEffect, useState } from "react";
import { useT } from "@/lib/i18n";

/**
 * The switch for usage data, which is on unless it is turned off here.
 *
 * The choice lives in the main process, which is also what does the sending,
 * so this only shows it and asks main to change it. Renders nothing when the
 * bridge has no analytics (an older preload): a switch that cannot do
 * anything is worse than no switch.
 */
export function UsageDataToggle(): React.ReactElement | null {
  const t = useT();
  const [known, setKnown] = useState(false);
  const [enabled, setEnabled] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void Promise.resolve(window.electronAPI?.analytics?.state?.())
      .then((s) => {
        if (!s || cancelled) return;
        setEnabled(s.consent === "granted");
        setKnown(true);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  if (!known) return null;

  const toggle = async (): Promise<void> => {
    const next = !enabled;
    setBusy(true);
    setEnabled(next);
    try {
      const result = await window.electronAPI.analytics.setConsent(next);
      setEnabled(result.consent === "granted");
    } catch {
      // Put it back: a switch showing what was asked for while main is in the
      // other state is worse than one that did not move.
      setEnabled(!next);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex items-start justify-between gap-4">
      <div>
        <p className="text-sm font-medium">{t("common.action.shareUsageData")}</p>
        <p className="text-xs text-[var(--color-text-muted)]">
          {t("common.description.tellsUsWhichScreensAndFeaturesAreUsed")}
        </p>
      </div>
      <button
        role="switch"
        aria-checked={enabled}
        aria-label={t("common.action.shareUsageData")}
        disabled={busy}
        onClick={toggle}
        className={`relative h-6 w-11 shrink-0 rounded-full transition-colors ${enabled ? "bg-[var(--color-primary)]" : "bg-[var(--color-border)]"}`}
      >
        <div
          // rtl-ok: mirrored, the rtl: twin slides the knob the other way
          className={`absolute top-0.5 h-5 w-5 rounded-full bg-[var(--color-bg)] shadow transition-transform ${enabled ? "translate-x-5 rtl:-translate-x-5" : "translate-x-0.5 rtl:-translate-x-0.5"}`}
        />
      </button>
    </div>
  );
}
