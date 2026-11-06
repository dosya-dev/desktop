// Ported from apps/web/src/lib/personas-device/ports.ts - keep the two in step.
//
// The desktop app's PersonasEngine ports: the journal API, the snapshot cache
// and key store in IndexedDB (the renderer is Chromium), and the photo source.
// Each takes its dependencies (API base, fetch, IndexedDB factory, clock) so
// tests can inject them. The only desktop difference is the API base, which
// comes from the desktop API client (primed before the first render).
//
// Only sealed bytes and the sealed key leave the device through here; the
// photo source sends nothing but the listing and rendition requests the app
// makes to show the same photos.
import {
  JournalFullError, JournalGoneError, KeyExistsError, ReaderUnsupportedError,
  type Candidate, type FileSource, type JournalApi, type KeyStore, type LocalCache,
} from '@dosya-dev/personas-engine';
import { apiBase } from '@/lib/api-client';
import { PersonasUnavailableError } from './errors';
import { committed, defaultIdb, KEYS_STORE, openPersonasDb, request, SNAPSHOTS_STORE, type IdbFactoryLike } from './idb';

export interface HttpOptions {
  /** API origin; defaults to the desktop API client's apiBase(). */
  base?: string;
  fetch?: typeof fetch;
}

/** A Personas request the API refused; `code` is the API's error string when it sent one. */
export class PersonasHttpError extends Error {
  constructor(readonly status: number, readonly code: string | null) {
    super(`personas: HTTP ${status}${code ? ` ${code}` : ''}`);
    this.name = 'PersonasHttpError';
  }
}

async function errorCode(res: Response): Promise<string | null> {
  try {
    const body = (await res.json()) as { error?: unknown };
    return typeof body?.error === 'string' ? body.error : null;
  } catch {
    return null;
  }
}

async function httpError(res: Response): Promise<PersonasHttpError> {
  return new PersonasHttpError(res.status, await errorCode(res));
}

function http(opts: HttpOptions) {
  const base = (opts.base ?? apiBase()).replace(/\/+$/, '');
  const f = opts.fetch ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init));
  return (path: string, init: RequestInit = {}) => f(`${base}${path}`, { credentials: 'include', ...init });
}

function fromBase64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// ---- journal --------------------------------------------------------------

const JOURNAL_PAGE = 200;

const seqOrNull = (v: unknown): v is number | null => v === null || (typeof v === 'number' && Number.isSafeInteger(v));

/** /api/e2ee/personas/key and /api/e2ee/personas/:workspaceId/journal. */
export function webJournalApi(opts: HttpOptions = {}): JournalApi {
  const call = http(opts);
  const journal = (ws: string) => `/api/e2ee/personas/${encodeURIComponent(ws)}/journal`;
  const ok = async (res: Response) => {
    if (!res.ok) throw await httpError(res);
  };
  return {
    async getKey() {
      const res = await call('/api/e2ee/personas/key');
      if (res.status === 404) return null;
      await ok(res);
      const body = (await res.json()) as { enc?: unknown; ct?: unknown };
      if (typeof body?.enc !== 'string' || typeof body?.ct !== 'string') throw new Error('personas: malformed key response');
      return { enc: body.enc, ct: body.ct };
    },
    async putKey(sealed) {
      const res = await call('/api/e2ee/personas/key', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enc: sealed.enc, ct: sealed.ct }),
      });
      if (res.status === 409) throw new KeyExistsError();
      await ok(res);
    },
    async deleteKey() {
      await ok(await call('/api/e2ee/personas/key', { method: 'DELETE' }));
    },
    async head(workspaceId) {
      const res = await call(`${journal(workspaceId)}?head=1`);
      await ok(res);
      const body = (await res.json()) as { first_seq?: unknown; last_seq?: unknown };
      if (!seqOrNull(body?.first_seq) || !seqOrNull(body?.last_seq)) throw new Error('personas: malformed journal head');
      return { first_seq: body.first_seq, last_seq: body.last_seq };
    },
    async pull(workspaceId, after) {
      const res = await call(`${journal(workspaceId)}?after=${after}&limit=${JOURNAL_PAGE}`);
      await ok(res);
      const body = (await res.json()) as { batches?: unknown; next?: unknown; first_seq?: unknown };
      if (!Array.isArray(body?.batches) || !(body.next === null || typeof body.next === 'number')) {
        throw new Error('personas: malformed journal page');
      }
      if (body.first_seq !== undefined && !seqOrNull(body.first_seq)) throw new Error('personas: malformed journal page');
      const batches = body.batches.map((b: { seq?: unknown; body?: unknown }) => {
        if (typeof b?.seq !== 'number' || typeof b.body !== 'string') throw new Error('personas: malformed journal batch');
        return { seq: b.seq, body: fromBase64(b.body) };
      });
      return body.first_seq === undefined ? { batches, next: body.next } : { batches, next: body.next, first_seq: body.first_seq };
    },
    async append(workspaceId, body, o) {
      const res = await call(`${journal(workspaceId)}${o?.create ? '?create=1' : ''}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: body.slice().buffer as ArrayBuffer,
      });
      if (res.status === 409) {
        const code = await errorCode(res);
        if (code === 'personas_journal_gone') throw new JournalGoneError();
        throw new PersonasHttpError(409, code);
      }
      if (res.status === 413) {
        const code = await errorCode(res);
        if (code === 'personas_journal_full' || code === 'personas_quota') throw new JournalFullError(code);
        throw new PersonasHttpError(413, code);
      }
      await ok(res);
      const r = (await res.json()) as { seq?: unknown };
      if (typeof r?.seq !== 'number') throw new Error('personas: malformed append response');
      return { seq: r.seq };
    },
    async deleteJournal(workspaceId) {
      await ok(await call(journal(workspaceId), { method: 'DELETE' }));
    },
  };
}

// ---- snapshot cache -------------------------------------------------------

/** Sealed snapshots (the engine seals them with the workspace key) in `snapshots`, keyed `${userId}:${workspaceId}`. */
export function webLocalCache(idb?: IdbFactoryLike): LocalCache {
  const db = () => openPersonasDb(idb ?? defaultIdb());
  const key = (u: string, w: string) => `${u}:${w}`;
  return {
    async load(userId, workspaceId) {
      const tx = (await db()).transaction(SNAPSHOTS_STORE, 'readonly');
      const v = await request(tx.objectStore(SNAPSHOTS_STORE).get(key(userId, workspaceId)));
      return v instanceof Uint8Array ? v.slice() : null;
    },
    async save(userId, workspaceId, sealed) {
      const tx = (await db()).transaction(SNAPSHOTS_STORE, 'readwrite');
      tx.objectStore(SNAPSHOTS_STORE).put(sealed.slice(), key(userId, workspaceId));
      await committed(tx);
    },
    async clear(userId, workspaceId) {
      const d = await db();
      if (workspaceId !== undefined) {
        const tx = d.transaction(SNAPSHOTS_STORE, 'readwrite');
        tx.objectStore(SNAPSHOTS_STORE).delete(key(userId, workspaceId));
        return committed(tx);
      }
      const tx = d.transaction(SNAPSHOTS_STORE, 'readwrite');
      // Listened for before the first await: with nothing to delete the
      // transaction commits right after getAllKeys.
      const done = committed(tx);
      const store = tx.objectStore(SNAPSHOTS_STORE);
      const keys = await request(store.getAllKeys());
      for (const k of keys) if (typeof k === 'string' && k.startsWith(`${userId}:`)) store.delete(k);
      await done;
    },
  };
}

/** Whether this device still holds a sealed snapshot for any of the user's workspaces. */
export async function hasSnapshots(userId: string, idb?: IdbFactoryLike): Promise<boolean> {
  const tx = (await openPersonasDb(idb ?? defaultIdb())).transaction(SNAPSHOTS_STORE, 'readonly');
  const keys = await request(tx.objectStore(SNAPSHOTS_STORE).getAllKeys());
  return keys.some((k) => typeof k === 'string' && k.startsWith(`${userId}:`));
}

// ---- key store ------------------------------------------------------------

const WRAP_KEY = 'wrap';
const userKey = (userId: string) => `user:${userId}`;
const enc = new TextEncoder();
const wrapAd = (userId: string) => enc.encode(`dosya-personas-key-cache/v1\u0000${userId}`);

interface WrappedRecord {
  v: 1;
  iv: Uint8Array;
  ct: Uint8Array;
}

/**
 * The engine's per-user key record, encrypted under a non-extractable
 * AES-GCM key generated once per browser and kept in the same `keys` store
 * (so script on the page can use it but never read it out). The record is
 * bound to its user id. A record whose wrapping key is gone reads as no key
 * (the engine then shows the unlock gate).
 */
export function webKeyStore(idb?: IdbFactoryLike): KeyStore {
  const db = () => openPersonasDb(idb ?? defaultIdb());

  async function readWrap(): Promise<CryptoKey | null> {
    const tx = (await db()).transaction(KEYS_STORE, 'readonly');
    const k = await request(tx.objectStore(KEYS_STORE).get(WRAP_KEY));
    return k instanceof CryptoKey ? k : null;
  }

  async function wrapKey(): Promise<CryptoKey> {
    const have = await readWrap();
    if (have) return have;
    const made = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    const tx = (await db()).transaction(KEYS_STORE, 'readwrite');
    tx.objectStore(KEYS_STORE).add(made, WRAP_KEY);
    try {
      await committed(tx);
      return made;
    } catch {
      // Another tab stored one first: use that.
      const other = await readWrap();
      if (!other) throw new Error('personas: could not store the device key');
      return other;
    }
  }

  return {
    async get(userId) {
      const tx = (await db()).transaction(KEYS_STORE, 'readonly');
      const store = tx.objectStore(KEYS_STORE);
      const [wrap, rec] = await Promise.all([request(store.get(WRAP_KEY)), request(store.get(userKey(userId)))]);
      const r = rec as WrappedRecord | undefined;
      if (!(wrap instanceof CryptoKey) || !r || !(r.iv instanceof Uint8Array) || !(r.ct instanceof Uint8Array)) return null;
      try {
        const pt = await crypto.subtle.decrypt(
          { name: 'AES-GCM', iv: r.iv as Uint8Array<ArrayBuffer>, additionalData: wrapAd(userId) },
          wrap,
          r.ct as Uint8Array<ArrayBuffer>,
        );
        return new Uint8Array(pt);
      } catch {
        return null;
      }
    },
    async set(userId, keyBytes) {
      const wrap = await wrapKey();
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const ct = new Uint8Array(
        await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: wrapAd(userId) }, wrap, keyBytes.slice() as Uint8Array<ArrayBuffer>),
      );
      const tx = (await db()).transaction(KEYS_STORE, 'readwrite');
      tx.objectStore(KEYS_STORE).put({ v: 1, iv, ct } satisfies WrappedRecord, userKey(userId));
      await committed(tx);
    },
    async clear(userId) {
      const tx = (await db()).transaction(KEYS_STORE, 'readwrite');
      tx.objectStore(KEYS_STORE).delete(userKey(userId));
      await committed(tx);
    },
  };
}

// ---- photo source ---------------------------------------------------------

export interface FileSourceOptions extends HttpOptions {
  now?: () => number;
  /** How long a workspace's full candidate listing is reused. */
  ttlMs?: number;
}

const LISTING_TTL_MS = 5 * 60_000;
const LIBRARY_PAGE = 200;
/** Renditions are about 1600 px; anything far larger is an original the thumb route redirected to, not worth reading here. */
const MAX_RENDITION_BYTES = 32 * 1024 * 1024;
const READABLE_TYPES = ['image/jpeg', 'image/webp'];
const MAX_DEPTH = 256;

interface TreeFolder {
  id: string;
  parent_id: string | null;
  is_hidden: number;
  lock_mode: string;
  /** A folder-confined member's anchor only: a folder above it is hidden (1) or locked (1). */
  inherited_hidden?: number;
  inherited_lock?: number;
}

/** One row of GET /api/library (the fields the file rows carry; the persona page shows them). */
export interface PhotoRow {
  id: string;
  name?: string;
  size_bytes?: number;
  mime_type?: string;
  extension?: string | null;
  region?: string;
  uploaded_by?: string;
  updated_at?: number | null;
  folder_id: string | null;
  current_version?: number | null;
  taken_at?: number | null;
  created_at?: number | null;
  is_hidden?: number | null;
  lock_mode?: string | null;
}

/** Any lock at all, whether or not this user holds an unlock token for it. */
const locked = (mode: string | null | undefined) => !!mode && mode !== 'none';

/**
 * Every photo the user can list in the workspace: GET /api/library?kind=photos
 * (workspace-wide; trash, folders hidden from this user and locked folders
 * without an unlock token already left out), minus every file that is hidden
 * (for anyone) or locked itself, or sits under a folder that is: the folder
 * flags come from GET /api/folders/tree?flags=1, which also gives each file's
 * ancestry. Holding hide_files or an unlock token changes none of that: a
 * hidden or locked photo is never read. A file whose folder is not in the
 * tree is left out too.
 *
 * Any listing error throws (an empty list would take every photo out of
 * every persona). The full listing is kept for five minutes per workspace.
 */
export interface WebFileSource extends FileSource {
  /**
   * The rows of the photos `candidates` lists, by file id, from the same
   * cached listing (no request of its own while it is fresh). The same Map
   * comes back until the listing is made again.
   */
  photos(workspaceId: string): Promise<ReadonlyMap<string, PhotoRow>>;
}

interface Listing { candidates: Candidate[]; rows: ReadonlyMap<string, PhotoRow> }

export function webFileSource(opts: FileSourceOptions = {}): WebFileSource {
  const call = http(opts);
  const now = opts.now ?? (() => Date.now());
  const ttl = opts.ttlMs ?? LISTING_TTL_MS;
  const cache = new Map<string, { at: number; list: Promise<Listing> }>();

  async function getJson<T>(path: string): Promise<T> {
    const res = await call(path);
    if (!res.ok) throw await httpError(res);
    return (await res.json()) as T;
  }

  async function tree(ws: string): Promise<Map<string, TreeFolder>> {
    const body = await getJson<{ ok?: unknown; folders?: unknown }>(`/api/folders/tree?workspace_id=${encodeURIComponent(ws)}&flags=1`);
    if (body?.ok !== true || !Array.isArray(body.folders)) throw new Error('personas: malformed folder tree');
    const map = new Map<string, TreeFolder>();
    for (const f of body.folders as Partial<TreeFolder>[]) {
      if (!f || typeof f.id !== 'string') continue;
      // Without its flags a folder cannot be judged: an API that predates
      // them must stop reading rather than read under a hidden or locked folder.
      if (typeof f.is_hidden !== 'number' || typeof f.lock_mode !== 'string') throw new Error('personas: folder tree without hidden and lock flags');
      map.set(f.id, f as TreeFolder);
    }
    return map;
  }

  /**
   * The folders above `folder` (nearest first), or null if `folder` is not in
   * the tree or it or a folder above is marked hidden or locked. The tree
   * drops a hidden folder together with everything under it, so a listed
   * folder's parent is missing from it only above a folder-confined member's
   * anchor: the walk stops there, and the anchor's inherited flags say
   * whether a folder above it is hidden or locked. A walk that stops at a
   * row without them (0 and 0) fails closed.
   */
  function ancestry(folders: Map<string, TreeFolder>, folder: string): string[] | null {
    if (!folders.has(folder)) return null;
    const out: string[] = [];
    const seen = new Set<string>();
    let id: string | null = folder;
    while (id !== null) {
      const f = folders.get(id);
      if (!f) {
        const top = folders.get(out.length ? out[out.length - 1] : folder)!;
        if (top.inherited_hidden !== 0 || top.inherited_lock !== 0) return null;
        break;
      }
      if (seen.has(id) || seen.size > MAX_DEPTH || f.is_hidden === 1 || locked(f.lock_mode)) return null;
      seen.add(id);
      if (id !== folder) out.push(id);
      id = f.parent_id ?? null;
    }
    return out;
  }

  async function library(ws: string): Promise<PhotoRow[]> {
    const rows: PhotoRow[] = [];
    const cursors = new Set<string>();
    let cursor: string | null = null;
    for (;;) {
      const qs = new URLSearchParams({ workspace_id: ws, kind: 'photos', sort: 'taken_desc', limit: String(LIBRARY_PAGE) });
      if (cursor) qs.set('cursor', cursor);
      const body = await getJson<{ ok?: unknown; months?: unknown; next_cursor?: unknown }>(`/api/library?${qs.toString()}`);
      if (body?.ok !== true || !Array.isArray(body.months)) throw new Error('personas: malformed photo listing');
      for (const m of body.months as { files?: unknown }[]) {
        if (!Array.isArray(m?.files)) throw new Error('personas: malformed photo listing');
        for (const r of m.files as PhotoRow[]) if (r && typeof r.id === 'string') rows.push(r);
      }
      const next = body.next_cursor;
      if (next === null || next === undefined) return rows;
      if (typeof next !== 'string' || cursors.has(next)) throw new Error('personas: photo listing does not end');
      cursors.add(next);
      cursor = next;
    }
  }

  async function listing(ws: string): Promise<Listing> {
    let folders = await tree(ws);
    const rows = await library(ws);
    // A folder made between the two requests: look at the tree once more.
    if (rows.some((r) => r.folder_id && !folders.has(r.folder_id))) folders = await tree(ws);
    const out: Candidate[] = [];
    const byId = new Map<string, PhotoRow>();
    const seen = new Set<string>();
    for (const r of rows) {
      if (seen.has(r.id) || r.is_hidden === 1 || locked(r.lock_mode)) continue;
      const folder = typeof r.folder_id === 'string' && r.folder_id ? r.folder_id : null;
      const ancestors = folder === null ? [] : ancestry(folders, folder);
      if (!ancestors) continue;
      seen.add(r.id);
      byId.set(r.id, r);
      const ver = Number(r.current_version);
      const at = Number(r.taken_at ?? r.created_at);
      out.push({ file: r.id, ver: Number.isSafeInteger(ver) && ver >= 1 ? ver : 1, folder, ancestors, sortAt: Number.isFinite(at) ? at : 0 });
    }
    return { candidates: out, rows: byId };
  }

  function cached(ws: string): Promise<Listing> {
    const hit = cache.get(ws);
    if (hit && now() - hit.at < ttl) return hit.list;
    const list = listing(ws);
    const entry = { at: now(), list };
    cache.set(ws, entry);
    list.catch(() => {
      if (cache.get(ws) === entry) cache.delete(ws);
    });
    return list;
  }

  return {
    async *candidates(workspaceId) {
      yield* (await cached(workspaceId)).candidates;
    },
    async photos(workspaceId) {
      return (await cached(workspaceId)).rows;
    },
    /**
     * 404 and 415 are the photo's (gone, or no rendition), as is anything
     * that is not a JPEG or WebP; a network error and every other refusal
     * (signed out, forbidden right now, rate limited, server trouble) is
     * PersonasUnavailableError, which the host turns into "try later"
     * instead of a failure journaled for the photo.
     */
    async rendition(file, ver) {
      let res: Response;
      try {
        res = await call(`/api/files/${encodeURIComponent(file)}/thumb?w=1600&version=${ver}`);
      } catch (e) {
        throw new PersonasUnavailableError(e instanceof Error ? e.message : String(e));
      }
      if (!res.ok) {
        if (res.status === 404 || res.status === 415) throw await httpError(res);
        await res.body?.cancel().catch(() => undefined);
        throw new PersonasUnavailableError(`personas: rendition HTTP ${res.status}`);
      }
      const type = (res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
      const declared = Number(res.headers.get('content-length'));
      if (!READABLE_TYPES.includes(type) || (Number.isFinite(declared) && declared > MAX_RENDITION_BYTES)) {
        await res.body?.cancel().catch(() => undefined);
        throw new ReaderUnsupportedError();
      }
      let bytes: Uint8Array;
      try {
        bytes = new Uint8Array(await res.arrayBuffer());
      } catch (e) {
        throw new PersonasUnavailableError(e instanceof Error ? e.message : String(e)); // the body broke off
      }
      if (bytes.length > MAX_RENDITION_BYTES) throw new ReaderUnsupportedError();
      return bytes;
    },
  };
}
