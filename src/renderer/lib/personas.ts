// apps/desktop/src/renderer/lib/personas.ts
//
// Ported from apps/web/src/lib/personas.ts - keep the two in step.
//
// Small helpers the Personas screens share. Personas runs on this device
// (lib/personas-device/engine-host.ts): faces are read here, grouped here and
// kept in an end-to-end encrypted journal, so nothing in this file talks to a
// server Personas route. Faces are shown as CSS crops of the photo's own
// thumbnail, using the face box the engine keeps (fractions of the image).
//
// This file is in the main bundle (search, the viewer's chips, the avatar):
// it imports engine types only, never the engine itself.
import { apiBase } from '@/lib/api-client';
import type { Box, PersonaCard as EngineCard } from '@dosya-dev/personas-engine';

/** One person as the engine lists them. */
export type PersonaCard = EngineCard;

/** A face box: fractions of the image, top-left origin. */
export type FaceBox = Box;

/** The Biometric data policy on the marketing site: how Personas protects privacy. */
export const PERSONAS_PRIVACY_URL = 'https://dosya.dev/biometric-data-policy';

/** Width of the thumbnail a face is cropped from. */
export const FACE_THUMB_WIDTH = 256;

/** The photo's thumbnail a face avatar crops (the same image the face was read from, scaled). */
export function faceThumbUrl(fileId: string): string {
  return `${apiBase()}/api/files/${encodeURIComponent(fileId)}/thumb?w=${FACE_THUMB_WIDTH}`;
}

/** The persona page. */
export function personaHref(personaId: string): string {
  return `/personas/${encodeURIComponent(personaId)}`;
}

/**
 * Where to draw the image inside a square frame so the face fills it: the
 * image's width and height, and its offset from the frame's top-left corner
 * (x, y), as percentages of the frame. `margin`
 * widens the square around the face (1 = the face box exactly). The square
 * stays inside the image where it fits, and the image keeps its aspect. The
 * box is in fractions, so the thumbnail's own size gives the same crop as the
 * photo the face was read from. A box or size that is not usable shows the
 * whole image.
 */
export function faceCrop(box: FaceBox, imageWidth: number, imageHeight: number, margin = 1.6): { width: number; height: number; x: number; y: number } {
  const W = imageWidth;
  const H = imageHeight;
  const whole = { width: 100, height: 100, x: 0, y: 0 };
  if (![box.x, box.y, box.w, box.h, W, H, margin].every(Number.isFinite) || W <= 0 || H <= 0 || box.w <= 0 || box.h <= 0) return whole;
  const bw = box.w * W;
  const bh = box.h * H;
  const face = Math.max(bw, bh);
  // Never wider than the image's short side, unless the face itself is.
  const side = Math.min(face * Math.max(1, margin), Math.max(Math.min(W, H), face));
  const place = (centre: number, size: number) => (size >= side ? Math.min(Math.max(centre - side / 2, 0), size - side) : (size - side) / 2);
  const x0 = place((box.x + box.w / 2) * W, W);
  const y0 = place((box.y + box.h / 2) * H, H);
  const pct = (v: number) => (v * 100) / side;
  return { width: pct(W), height: pct(H), x: -pct(x0) || 0, y: -pct(y0) || 0 };
}

export type PersonasErrorCode = 'not_found' | 'name_taken' | 'name_invalid' | 'not_ready' | 'invalid' | 'retry';

/** What a failed engine call means for the UI: the engine's own code, or "try again" for anything else (offline, server). */
export function personasErrorCode(err: unknown): PersonasErrorCode {
  const e = err as { name?: unknown; code?: unknown } | null;
  if (e && e.name === 'PersonasEngineError') {
    switch (e.code) {
      case 'not_found': case 'name_taken': case 'name_invalid': case 'not_ready': case 'invalid': return e.code;
    }
  }
  return 'retry';
}
