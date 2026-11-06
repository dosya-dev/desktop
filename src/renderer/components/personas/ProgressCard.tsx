// apps/desktop/src/renderer/components/personas/ProgressCard.tsx
//
// Ported from apps/web/src/components/personas/progress-card.tsx - keep the
// behaviour and copy in step.
//
// The Personas progress card above the grid. Photos are read on this device,
// so the card speaks for this device: "Read {read} of {total} photos on this
// device" with a bar and Pause / Resume, gone once every photo is read. A
// device that cannot run the reader says so; the grid still works from the
// encrypted journal the user's other devices write. The rules live in
// lib/personas-progress.ts; this file only renders.
import { useId } from "react";
import { Loader2, ScanFace } from "lucide-react";
import { useT } from "@/lib/i18n";
import { progressPercent, progressView, type ReadyStatus } from "@/lib/personas-progress";
import { BORDER, OUTLINE_BUTTON, SMALL } from "./ui";

export interface ProgressCardProps {
  status: ReadyStatus;
  /** Whether this device can read photos (engine-host personasReaderSupported). */
  supported: boolean;
  /** Pause (true) or resume (false) reading on this device. */
  onPause: (paused: boolean) => void;
}

const FRAME = "flex flex-col gap-3 rounded-2xl border bg-[var(--color-bg)] px-5 py-4 sm:px-6 sm:py-5";

export function PersonasProgressCard({ status, supported, onPause }: ProgressCardProps) {
  const t = useT();
  const titleId = useId();
  const view = progressView(status, supported);
  if (view === "hidden") return null;

  const icon = (
    <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-green-50 text-green-700 dark:bg-green-950 dark:text-green-500">
      <ScanFace size={20} aria-hidden="true" />
    </span>
  );

  if (view === "unsupported") {
    return (
      <section aria-labelledby={titleId} data-progress-state="unsupported" className={FRAME} style={BORDER}>
        <div className="flex items-center gap-3.5">
          {icon}
          <p id={titleId} className="min-w-0 flex-1 text-sm text-[var(--color-text-secondary)]">{t("personas.description.thisDeviceCantReadPhotos")}</p>
        </div>
      </section>
    );
  }

  if (view === "finding") {
    return (
      <section aria-labelledby={titleId} data-progress-state="finding" className={FRAME} style={BORDER}>
        <div className="flex items-center gap-3.5">
          {icon}
          <p id={titleId} className="min-w-0 flex-1 text-sm font-semibold">{t("personas.label.findingYourPhotos")}</p>
          <Loader2 size={16} className="animate-spin text-[var(--color-text-muted)]" aria-hidden="true" />
        </div>
      </section>
    );
  }

  const total = status.total ?? 0;
  const percent = progressPercent(status);
  const line = t("personas.label.readOfTotalPhotosOnThisDevice", { read: status.read, total });
  return (
    <section aria-labelledby={titleId} data-progress-state="reading" className={FRAME} style={BORDER}>
      <div className="flex flex-wrap items-center gap-3.5">
        {icon}
        <p id={titleId} className="min-w-40 flex-1 text-sm font-semibold">{line}</p>
        <button type="button" className={`${OUTLINE_BUTTON} ${SMALL}`} style={BORDER} onClick={() => onPause(!status.paused)}>
          {status.paused ? t("personas.action.resume") : t("personas.action.pause")}
        </button>
      </div>
      <div
        role="progressbar"
        aria-label={t("personas.label.photosRead")}
        aria-valuemin={0}
        aria-valuemax={total}
        aria-valuenow={status.read}
        aria-valuetext={line}
        className="h-2 overflow-hidden rounded-full bg-[var(--color-border)]"
      >
        <div className="h-full rounded-full bg-green-700 transition-[width] dark:bg-green-500" style={{ width: `${percent}%` }} />
      </div>
    </section>
  );
}
