// Ported from apps/web/src/lib/personas-device/errors.ts - keep the two in step.
//
// A Personas step failed for a reason that is not the photo's: the reader
// could not load, the network is down, the session expired, the server is
// busy. engine-host aborts the reads in flight when it sees one, so the
// engine never journals such a photo as failed, and tries again later.
export class PersonasUnavailableError extends Error {
  constructor(message = 'personas: temporarily unavailable') {
    super(message);
    this.name = 'PersonasUnavailableError';
  }
}
