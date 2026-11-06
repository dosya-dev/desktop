// apps/desktop/src/renderer/lib/personas.test.ts
//
// Ported from apps/web/src/lib/personas.test.ts - keep the two in step.
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/api-client', async (orig) => ({
  ...(await orig<typeof import('@/lib/api-client')>()),
  apiBase: () => 'https://api.test',
}));

const personas = await import('./personas');
const { faceCrop, faceThumbUrl, personaHref, personasErrorCode } = personas;

describe('faceThumbUrl', () => {
  it('is the file thumbnail at 256 px (no face image route)', () => {
    expect(faceThumbUrl('f 1')).toBe('https://api.test/api/files/f%201/thumb?w=256');
  });
});

describe('personaHref', () => {
  it('is the persona page', () => {
    expect(personaHref('p/1')).toBe('/personas/p%2F1');
  });
});

describe('faceCrop', () => {
  it('fills a square with the face box and its margin, as percentages of the frame', () => {
    // A 200 x 200 image, the face in the middle quarter, no margin: the face fills the frame.
    expect(faceCrop({ x: 0.25, y: 0.25, w: 0.5, h: 0.5 }, 200, 200, 1)).toEqual({ width: 200, height: 200, x: -50, y: -50 });
  });

  it('keeps the image aspect: a wide image is not stretched', () => {
    // 400 x 200, face 100 x 100 px at (100, 50): square side 100, so the image is 4 x 2 frames.
    const c = faceCrop({ x: 0.25, y: 0.25, w: 0.25, h: 0.5 }, 400, 200, 1);
    expect(c.width / c.height).toBeCloseTo(2);
    expect(c).toEqual({ width: 400, height: 200, x: -100, y: -50 });
  });

  it('applies the same box to a thumbnail of another size (the box is in fractions)', () => {
    expect(faceCrop({ x: 0.25, y: 0.25, w: 0.5, h: 0.5 }, 256, 256, 1)).toEqual(faceCrop({ x: 0.25, y: 0.25, w: 0.5, h: 0.5 }, 1600, 1600, 1));
  });

  it('keeps the square inside the image near an edge', () => {
    // Face at the top-left corner: the square starts at the corner instead of going past it.
    const c = faceCrop({ x: 0, y: 0, w: 0.1, h: 0.1 }, 1000, 1000, 2);
    expect(c.x).toBeCloseTo(0);
    expect(c.y).toBeCloseTo(0);
    expect(c.width).toBeCloseTo(500);
  });

  it('never makes the square larger than the image allows, and falls back to the whole image for nonsense', () => {
    const c = faceCrop({ x: 0, y: 0, w: 1, h: 1 }, 300, 200, 1.5);
    expect(c.width).toBeCloseTo(100);
    expect(c.height).toBeCloseTo(100 * 200 / 300);
    expect(faceCrop({ x: NaN, y: 0, w: 1, h: 1 }, 100, 100)).toEqual({ width: 100, height: 100, x: 0, y: 0 });
    expect(faceCrop({ x: 0, y: 0, w: 0.5, h: 0.5 }, 0, 0)).toEqual({ width: 100, height: 100, x: 0, y: 0 });
  });
});

describe('personasErrorCode', () => {
  it('reads the engine error codes, everything else is retry', () => {
    const e = Object.assign(new Error('name_taken'), { name: 'PersonasEngineError', code: 'name_taken' });
    expect(personasErrorCode(e)).toBe('name_taken');
    expect(personasErrorCode(Object.assign(new Error('x'), { name: 'PersonasEngineError', code: 'not_found' }))).toBe('not_found');
    expect(personasErrorCode(new Error('offline'))).toBe('retry');
    expect(personasErrorCode(null)).toBe('retry');
  });
});

describe('the server Personas client is gone', () => {
  it('exports none of the server-route helpers', () => {
    for (const name of [
      'getPersonasSettings', 'putPersonasSettings', 'listPersonas', 'personaPhotos', 'personaCoverUrl', 'faceImageUrl',
      'personasConsent', 'personasAccess', 'personasVisible', 'personasDecided', 'PERSONAS_POLICY_VERSION', 'PERSONAS_ACCESS_EVENT',
      'PERSONAS_DECIDED_EVENT', 'personSearchHref', 'PERSON_SEARCH_WARNING', 'peopleInFile',
      'renamePersona', 'setCover', 'mergePersonas', 'hidePersona', 'notThisPerson', 'personasEnabled', 'forgetPersonasAccess',
      'personasErrorKind', 'apiErrorCode', 'personasSettingsOnce', 'notePersonasAccess', 'notePersonasEnabled', 'setPersonasDecision',
    ]) expect(personas, name).not.toHaveProperty(name);
  });
});
