export type ReportReason = 'playback' | 'copyright' | 'abuse';

export interface ReportDiagnostics {
  ua: string;
  platform: string;
  codec: string;
  resolution: string;
  position_ms: number;
  media_error: number | null;
  ready_state: number;
  network_state: number;
}

export interface ReportDraft {
  reason: ReportReason;
  details?: string;
  email?: string;
  source_url?: string;
  owner_attested?: boolean;
  diagnostics?: ReportDiagnostics;
}

export interface ReportPayload {
  reason: ReportReason;
  details: string;
  email?: string;
  source_url?: string;
  /** Set (always true) on copyright reports, which cannot validate without it. */
  owner_attested?: true;
  diagnostics?: ReportDiagnostics;
}

export type ReportValidation =
  | { ok: true; payload: ReportPayload }
  | { ok: false; field: 'email' | 'owner_attested' | 'details'; message: string };

const DETAILS_MAX = 5000;
const EMAIL_MAX = 254;
// Same shape as the shared validation policy used by the API.
const EMAIL_RE =
  /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*\.[a-zA-Z]{2,}$/;

function isValidEmail(email: string): boolean {
  return !!email && email.length <= EMAIL_MAX && EMAIL_RE.test(email);
}

/** The validation messages; absent means English. */
export interface ReportMessages {
  detailsTooLong(max: number): string;
  validEmailRequired: string;
  confirmRightsOwner: string;
}

const ENGLISH_MESSAGES: ReportMessages = {
  detailsTooLong: (max) => `Details must be ${max} characters or fewer`,
  validEmailRequired: 'Valid email is required',
  confirmRightsOwner: 'You must confirm you are the rights owner or their agent',
};

export function validateReport(d: ReportDraft, messages: ReportMessages = ENGLISH_MESSAGES): ReportValidation {
  const details = (d.details ?? '').trim();
  if (details.length > DETAILS_MAX) {
    return { ok: false, field: 'details', message: messages.detailsTooLong(DETAILS_MAX) };
  }
  const email = (d.email ?? '').trim().toLowerCase();
  const sourceUrl = (d.source_url ?? '').trim();

  if (d.reason === 'copyright') {
    if (!isValidEmail(email)) return { ok: false, field: 'email', message: messages.validEmailRequired };
    if (d.owner_attested !== true) {
      return { ok: false, field: 'owner_attested', message: messages.confirmRightsOwner };
    }
  } else if (email && !isValidEmail(email)) {
    return { ok: false, field: 'email', message: messages.validEmailRequired };
  }

  const payload: ReportPayload = { reason: d.reason, details };
  if (email) payload.email = email;
  if (sourceUrl) payload.source_url = sourceUrl;
  if (d.reason === 'copyright') payload.owner_attested = true;
  if (d.diagnostics) payload.diagnostics = d.diagnostics;
  return { ok: true, payload };
}

export function diagnosticsLines(d: ReportDiagnostics): string[] {
  return [
    `ua: ${d.ua}`,
    `platform: ${d.platform}`,
    `codec: ${d.codec}`,
    `resolution: ${d.resolution}`,
    `position_ms: ${d.position_ms}`,
    `media_error: ${d.media_error === null ? 'none' : d.media_error}`,
    `ready_state: ${d.ready_state}`,
    `network_state: ${d.network_state}`,
  ];
}
