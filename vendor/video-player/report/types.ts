import type { ReportLabels } from '../labels';
import type { ReportDiagnostics, ReportPayload, ReportReason } from './payload';

/** What the host's submit call resolved to. Distinct from `validateReport`'s result. */
export type ReportResult = { ok: true } | { ok: false; error: string };

/** Report flow configuration. The popover that consumes it is mounted by Task 3. */
export interface ReportConfig {
  reasons: ReportReason[];
  /** Optional: the player supplies a default built from its video element. */
  diagnostics?(): ReportDiagnostics;
  submit(payload: ReportPayload, ui: { challengeHost: HTMLElement }): Promise<ReportResult>;
  formalNoticeUrl?: string;
  /** The popover's words; absent means English. Any subset. */
  labels?: Partial<ReportLabels>;
}
