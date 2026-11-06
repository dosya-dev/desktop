// Ported from apps/web/src/lib/personas-device/__fixtures__/fake-host.ts - keep the two in step.
//
// Test stand-in for ./engine-host: a fake PersonasEngine with the query and
// action methods the Personas screens call, and a usePersonasEngine that
// re-renders on every change. Screens' tests use it as the module mock:
//
//   vi.mock('@/lib/personas-device/engine-host', () => import('@/lib/personas-device/__fixtures__/fake-host'));
//   const { fakeHost } = await import('@/lib/personas-device/__fixtures__/fake-host');
import { useSyncExternalStore } from 'react';
import { vi } from 'vitest';
import type { EngineStatus, PersonaCard, PersonasEngine } from '@dosya-dev/personas-engine';
import type { PhotoRow } from '../ports';

export type Box = { x: number; y: number; w: number; h: number };
export type FakePhoto = { file_id: string; face_id: string; box: Box };
export type FakeFace = { persona_id: string | null; name: string | null; face_id: string; box: Box };

export const READY: Extract<EngineStatus, { state: 'ready' }> = { state: 'ready', read: 10, total: 10, reading: false, paused: false };

class EngineError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'PersonasEngineError';
  }
}

export function card(id: string, name: string | null, extra: Partial<PersonaCard> = {}): PersonaCard {
  return {
    id, name, face_count: 4, photo_count: 3, cover_face_id: `cf-${id}`, cover_file_id: `file-${id}`,
    cover_box: { x: 0.25, y: 0.25, w: 0.5, h: 0.5 }, ...extra,
  };
}

export class FakeEngine {
  personas: PersonaCard[] = [];
  photos = new Map<string, FakePhoto[]>();
  faces = new Map<string, FakeFace[]>();
  skipped: string[] = [];

  status = vi.fn(async () => fakeHost.state.status ?? READY);
  listPersonas = vi.fn((q?: string) =>
    this.personas.filter((p) => q === undefined || (p.name !== null && p.name.toLowerCase().startsWith(q.toLowerCase()))));
  findByName = vi.fn((prefix: string, limit = 8) =>
    this.personas.filter((p) => p.name !== null && p.name.toLowerCase().startsWith(prefix.trim().toLowerCase())).slice(0, limit));
  personaPhotos = vi.fn((pid: string, cursor?: string | null, limit = 60) => {
    const persona = this.personas.find((p) => p.id === pid);
    if (!persona) throw new EngineError('not_found');
    const all = this.photos.get(pid) ?? [];
    const start = cursor ? Number(cursor) : 0;
    const files = all.slice(start, start + limit);
    return { persona, files, next: start + limit < all.length ? String(start + limit) : null };
  });
  peopleInFile = vi.fn((fileId: string) => this.faces.get(fileId) ?? []);
  skippedFolders = vi.fn(() => [...this.skipped]);

  rename = vi.fn(async (pid: string, name: string) => {
    const p = this.personas.find((x) => x.id === pid);
    if (!p) throw new EngineError('not_found');
    if (this.personas.some((x) => x.id !== pid && x.name === name)) throw new EngineError('name_taken');
    p.name = name;
    this.changed();
  });
  setCover = vi.fn(async (pid: string, faceId: string) => {
    const p = this.personas.find((x) => x.id === pid);
    if (p) p.cover_face_id = faceId;
    this.changed();
  });
  merge = vi.fn(async (into: string, from: string) => {
    this.personas = this.personas.filter((p) => p.id !== from);
    this.changed();
    return into;
  });
  removePersona = vi.fn(async (pid: string) => {
    this.personas = this.personas.filter((p) => p.id !== pid);
    this.changed();
  });
  notThisPerson = vi.fn(async (faceId: string) => {
    for (const [pid, list] of this.photos) this.photos.set(pid, list.filter((f) => f.face_id !== faceId));
    this.changed();
  });
  skipFolder = vi.fn(async (folderId: string, on: boolean) => {
    this.skipped = on ? [...this.skipped.filter((f) => f !== folderId), folderId] : this.skipped.filter((f) => f !== folderId);
    this.changed();
  });
  turnOn = vi.fn(async () => {
    fakeHost.set({ status: { ...READY, read: 0, total: null } });
  });
  turnOff = vi.fn(async () => {
    this.personas = [];
    fakeHost.set({ status: { state: 'off' } });
  });
  deleteIndex = vi.fn(async () => {
    this.personas = [];
    fakeHost.set({ status: { state: 'off' } });
  });
  setPaused = vi.fn((p: boolean) => {
    const st = fakeHost.state.status;
    if (st && st.state === 'ready') fakeHost.set({ status: { ...st, paused: p } });
  });
  subscribe = vi.fn((fn: () => void) => {
    listeners.add(fn);
    return () => listeners.delete(fn);
  });

  /** Something in the index changed: the hook re-reads its status, which (as the real engine's) is a new object. */
  changed() {
    const st = fakeHost.state.status;
    fakeHost.set({ status: st ? { ...st } : st });
  }
}

type HostState = { engine: FakeEngine | null; status: EngineStatus | null; error: unknown };

const listeners = new Set<() => void>();

export const fakeHost = {
  state: { engine: null, status: null, error: null } as HostState,
  engine: new FakeEngine(),
  supported: true,
  rows: new Map<string, PhotoRow>(),
  unlockPersonas: vi.fn(async (workspaceId: string) => void workspaceId),
  refresh: vi.fn(),
  set(next: Partial<HostState>) {
    this.state = { ...this.state, ...next };
    for (const fn of [...listeners]) fn();
  },
  reset(status: EngineStatus | null = READY) {
    listeners.clear();
    this.engine = new FakeEngine();
    this.supported = true;
    this.rows = new Map();
    this.unlockPersonas.mockReset();
    this.unlockPersonas.mockImplementation(async () => undefined);
    this.refresh.mockReset();
    this.state = { engine: this.engine, status, error: null };
  },
};

function subscribe(fn: () => void) {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

export function usePersonasEngine(workspaceId: string) {
  void workspaceId;
  const s = useSyncExternalStore(subscribe, () => fakeHost.state);
  return { engine: s.engine as unknown as PersonasEngine | null, status: s.status, error: s.error, refresh: fakeHost.refresh };
}

export function personasEngine(workspaceId: string): PersonasEngine {
  void workspaceId;
  if (!fakeHost.state.engine) throw new Error('not signed in');
  return fakeHost.state.engine as unknown as PersonasEngine;
}

export function unlockPersonas(workspaceId: string): Promise<void> {
  return fakeHost.unlockPersonas(workspaceId);
}

export function personasPhotoRows(workspaceId: string): Promise<ReadonlyMap<string, PhotoRow>> {
  void workspaceId;
  return Promise.resolve(fakeHost.rows);
}

export function personasReaderSupported(): boolean {
  return fakeHost.supported;
}

export function stopPersonasEngines(): void {}

/** A photo row as GET /api/library gives it. */
export function photoRow(id: string, extra: Partial<PhotoRow> = {}): PhotoRow {
  return {
    id, name: `${id}.jpg`, size_bytes: 1000, mime_type: 'image/jpeg', extension: 'jpg', region: 'weur', uploaded_by: 'u1',
    folder_id: 'fold1', current_version: 1, taken_at: 1_760_000_000, created_at: 1_760_000_000, updated_at: 1_760_000_000,
    is_hidden: 0, lock_mode: 'none', ...extra,
  };
}
