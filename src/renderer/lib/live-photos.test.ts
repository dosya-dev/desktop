// Ported from apps/web/src/lib/live-photos.test.ts - keep in sync
import { describe, it, expect } from 'vitest';
import { isLiveStill, isLiveTwin, collapseLiveTwins, twinsUnderStills, liveTwinIds, liveTwinOf, twinDeleteEndpoint } from './live-photos';

const still = { id: 's1', live_video_id: 'v1', live_photo_id: null };
const twin = { id: 'v1', live_video_id: null, live_photo_id: 's1' };
const plain = { id: 'p1', live_video_id: null, live_photo_id: null };
const legacy = { id: 'l1' } as { id: string; live_video_id?: string | null; live_photo_id?: string | null };

describe('live-photos helpers', () => {
  it('classifies rows, treating missing fields as no pair', () => {
    expect(isLiveStill(still)).toBe(true);
    expect(isLiveTwin(twin)).toBe(true);
    expect(isLiveStill(plain)).toBe(false);
    expect(isLiveTwin(legacy)).toBe(false);
  });

  it('collapse removes twins and keeps order', () => {
    expect(collapseLiveTwins([twin, still, plain]).map((f) => f.id)).toEqual(['s1', 'p1']);
  });

  it('twinsUnderStills moves each twin directly after its still, whatever the sort', () => {
    expect(twinsUnderStills([twin, plain, still]).map((f) => f.id)).toEqual(['p1', 's1', 'v1']);
  });

  it('a twin whose still is not in the list stays where it is', () => {
    expect(twinsUnderStills([twin, plain]).map((f) => f.id)).toEqual(['v1', 'p1']);
    expect(collapseLiveTwins([twin, plain]).map((f) => f.id)).toEqual(['v1', 'p1']);
  });

  it('liveTwinIds expands selected stills to their twins, skipping ones already selected', () => {
    expect(liveTwinIds([still, twin, plain], new Set(['s1']))).toEqual(['v1']);
    expect(liveTwinIds([still, twin, plain], new Set(['s1', 'v1']))).toEqual([]);
    expect(liveTwinIds([still, plain], new Set(['p1']))).toEqual([]);
  });

  it('liveTwinOf finds the twin row when present', () => {
    expect(liveTwinOf([still, twin], still)?.id).toBe('v1');
    expect(liveTwinOf([still], still)).toBeNull();
    expect(liveTwinOf([still, twin], plain)).toBeNull();
    expect(liveTwinOf([still, twin], twin)).toBeNull();
  });

  it('liveTwinIds names a twin that is not itself in the visible rows', () => {
    const stillOnly = [{ id: 's9', live_video_id: 'v9', live_photo_id: null }];
    expect(liveTwinIds(stillOnly, new Set(['s9']))).toEqual(['v9']);
  });

  it('twinDeleteEndpoint pins the still-delete-takes-its-twin behaviour', () => {
    expect(twinDeleteEndpoint({ type: 'file', twin: { id: 'v1' }, withTwin: true })).toBe('/api/files/v1');
    // withTwin undefined means "not asked yet" (dialog defaults the checkbox on) - still deletes the twin.
    expect(twinDeleteEndpoint({ type: 'file', twin: { id: 'v1' } })).toBe('/api/files/v1');
    // Unchecking the box is the only way to skip the twin.
    expect(twinDeleteEndpoint({ type: 'file', twin: { id: 'v1' }, withTwin: false })).toBeNull();
    expect(twinDeleteEndpoint({ type: 'file', twin: null })).toBeNull();
    expect(twinDeleteEndpoint({ type: 'folder', twin: { id: 'v1' }, withTwin: true })).toBeNull();
  });

  // The trash view projects no pairing fields, so a twin on a permanent target
  // is a leftover from the row that opened the dialog. Taking it along would
  // purge a second file for good without ever having named it.
  it('a permanent delete never takes the twin along', () => {
    expect(twinDeleteEndpoint({ type: 'file', twin: { id: 'v1' }, withTwin: true, permanent: true })).toBeNull();
    expect(twinDeleteEndpoint({ type: 'file', twin: { id: 'v1' }, permanent: true })).toBeNull();
    expect(twinDeleteEndpoint({ type: 'file', twin: { id: 'v1' }, permanent: false })).toBe('/api/files/v1');
  });
});
