// apps/desktop/src/renderer/lib/personas-progress.ts
//
// Ported from apps/web/src/lib/personas-progress.ts - keep the two in step.
//
// What the Personas progress card shows for the engine's status
// (components/personas/ProgressCard.tsx renders it). Reading happens on this
// device, so the card speaks for this device only:
//
//   unsupported  this device cannot read photos (other devices can)
//   finding      the photos are not counted yet (the first listing)
//   reading      read < total: "Read {read} of {total} photos on this device"
//   hidden       every photo is read (or there are none)
import type { EngineStatus } from '@dosya-dev/personas-engine';

export type ReadyStatus = Extract<EngineStatus, { state: 'ready' }>;

export type ProgressView = 'unsupported' | 'finding' | 'reading' | 'hidden';

export function progressView(status: ReadyStatus, supported: boolean): ProgressView {
  if (!supported) return 'unsupported';
  if (status.total === null) return 'finding';
  return status.read < status.total ? 'reading' : 'hidden';
}

/** Whole percent of photos read; never 100 while photos are left. */
export function progressPercent(status: ReadyStatus): number {
  if (!status.total || status.total <= 0) return 0;
  const raw = Math.round((status.read / status.total) * 100);
  return Math.max(0, Math.min(status.read < status.total ? 99 : 100, raw));
}
