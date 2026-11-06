// @vitest-environment node
// Ported from apps/web/src/lib/personas-device/ports.test.ts - keep the two in step.
import { describe, expect, it, vi } from 'vitest';
import { JournalFullError, JournalGoneError, KeyExistsError, ReaderUnsupportedError, type Candidate } from '@dosya-dev/personas-engine';
import { webFileSource, webJournalApi, webKeyStore, webLocalCache, PersonasHttpError } from './ports';
import { PersonasUnavailableError } from './errors';
import { FakeIdbFactory } from './__fixtures__/fake-idb';

type Call = { url: string; init: RequestInit };

function fetchMock(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fn = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input);
    calls.push({ url, init });
    return handler(url, init);
  });
  return { fetch: fn as unknown as typeof fetch, calls };
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const b64 = (b: Uint8Array) => btoa(String.fromCharCode(...b));

describe('webJournalApi', () => {
  const base = 'https://api.test';

  it('getKey: GET with the session cookie; 404 is no key', async () => {
    const m = fetchMock((url) => (url.endsWith('/key') ? json({ enc: 'ZW5j', ct: 'Y3Q=' }) : json({}, 500)));
    const api = webJournalApi({ base, fetch: m.fetch });
    expect(await api.getKey()).toEqual({ enc: 'ZW5j', ct: 'Y3Q=' });
    expect(m.calls[0].url).toBe('https://api.test/api/e2ee/personas/key');
    expect(m.calls[0].init.method ?? 'GET').toBe('GET');
    expect(m.calls[0].init.credentials).toBe('include');
    const none = webJournalApi({ base, fetch: fetchMock(() => json({ ok: false, error: 'No personas key' }, 404)).fetch });
    expect(await none.getKey()).toBeNull();
    const broken = webJournalApi({ base, fetch: fetchMock(() => json({ ok: false }, 500)).fetch });
    const err = await broken.getKey().catch((e) => e);
    expect(err).toBeInstanceOf(PersonasHttpError);
    expect(err.status).toBe(500);
  });

  it('putKey: PUT JSON; 409 is KeyExistsError', async () => {
    const m = fetchMock(() => new Response(null, { status: 204 }));
    await webJournalApi({ base, fetch: m.fetch }).putKey({ enc: 'ZW5j', ct: 'Y3Q=' });
    expect(m.calls[0].url).toBe('https://api.test/api/e2ee/personas/key');
    expect(m.calls[0].init.method).toBe('PUT');
    expect(JSON.parse(String(m.calls[0].init.body))).toEqual({ enc: 'ZW5j', ct: 'Y3Q=' });
    expect(new Headers(m.calls[0].init.headers).get('content-type')).toBe('application/json');
    const taken = webJournalApi({ base, fetch: fetchMock(() => json({ ok: false, error: 'personas_key_exists' }, 409)).fetch });
    await expect(taken.putKey({ enc: 'a', ct: 'b' })).rejects.toBeInstanceOf(KeyExistsError);
  });

  it('deleteKey and deleteJournal: DELETE', async () => {
    const m = fetchMock(() => new Response(null, { status: 204 }));
    const api = webJournalApi({ base, fetch: m.fetch });
    await api.deleteKey();
    await api.deleteJournal('ws/1');
    expect(m.calls.map((c) => [c.init.method, c.url])).toEqual([
      ['DELETE', 'https://api.test/api/e2ee/personas/key'],
      ['DELETE', 'https://api.test/api/e2ee/personas/ws%2F1/journal'],
    ]);
  });

  it('pull: pages after a sequence and decodes base64 bodies', async () => {
    const m = fetchMock(() => json({ batches: [{ seq: 6, body: b64(new Uint8Array([1, 2, 255])) }, { seq: 7, body: '' }], next: 7 }));
    const page = await webJournalApi({ base, fetch: m.fetch }).pull('ws1', 5);
    expect(m.calls[0].url).toBe('https://api.test/api/e2ee/personas/ws1/journal?after=5&limit=200');
    expect(m.calls[0].init.credentials).toBe('include');
    expect(page.next).toBe(7);
    expect(page.batches.map((b) => b.seq)).toEqual([6, 7]);
    expect(Array.from(page.batches[0].body)).toEqual([1, 2, 255]);
    expect(page.batches[1].body).toBeInstanceOf(Uint8Array);
  });

  it('pull: a malformed page is an error, never an empty journal', async () => {
    const api = webJournalApi({ base, fetch: fetchMock(() => json({ ok: true })).fetch });
    await expect(api.pull('ws1', 0)).rejects.toThrow();
  });

  it('append: POST raw bytes, create only when asked; 409 gone is JournalGoneError', async () => {
    const m = fetchMock(() => json({ seq: 9 }, 201));
    const api = webJournalApi({ base, fetch: m.fetch });
    expect(await api.append('ws1', new Uint8Array([7, 8]))).toEqual({ seq: 9 });
    expect(await api.append('ws1', new Uint8Array([9]), { create: true })).toEqual({ seq: 9 });
    expect(m.calls[0].url).toBe('https://api.test/api/e2ee/personas/ws1/journal');
    expect(m.calls[1].url).toBe('https://api.test/api/e2ee/personas/ws1/journal?create=1');
    expect(m.calls[0].init.method).toBe('POST');
    expect(new Headers(m.calls[0].init.headers).get('content-type')).toBe('application/octet-stream');
    expect(Array.from(new Uint8Array(m.calls[0].init.body as ArrayBuffer))).toEqual([7, 8]);
    const gone = webJournalApi({ base, fetch: fetchMock(() => json({ ok: false, error: 'personas_journal_gone' }, 409)).fetch });
    await expect(gone.append('ws1', new Uint8Array([1]))).rejects.toBeInstanceOf(JournalGoneError);
    for (const code of ['personas_journal_full', 'personas_quota']) {
      const full = webJournalApi({ base, fetch: fetchMock(() => json({ ok: false, error: code }, 413)).fetch });
      const err = await full.append('ws1', new Uint8Array([1])).catch((e) => e);
      expect(err).toBeInstanceOf(JournalFullError);
      expect(err.code).toBe(code);
    }
    const big = webJournalApi({ base, fetch: fetchMock(() => json({ ok: false, error: 'personas_batch_too_large' }, 413)).fetch });
    const err = await big.append('ws1', new Uint8Array([1])).catch((e) => e);
    expect(err).toBeInstanceOf(PersonasHttpError);
    expect(err.code).toBe('personas_batch_too_large');
  });

  it('head: GET ?head=1 answers first and last seq, no body; malformed is an error', async () => {
    const m = fetchMock(() => json({ first_seq: 3, last_seq: 9 }));
    expect(await webJournalApi({ base, fetch: m.fetch }).head('ws/1')).toEqual({ first_seq: 3, last_seq: 9 });
    expect(m.calls[0].url).toBe('https://api.test/api/e2ee/personas/ws%2F1/journal?head=1');
    expect(m.calls[0].init.method ?? 'GET').toBe('GET');
    const empty = webJournalApi({ base, fetch: fetchMock(() => json({ first_seq: null, last_seq: null })).fetch });
    expect(await empty.head('ws1')).toEqual({ first_seq: null, last_seq: null });
    for (const bad of [{}, { first_seq: '3', last_seq: 9 }, { first_seq: 3 }]) {
      await expect(webJournalApi({ base, fetch: fetchMock(() => json(bad)).fetch }).head('ws1')).rejects.toThrow();
    }
    const denied = webJournalApi({ base, fetch: fetchMock(() => json({ ok: false, error: 'Access denied' }, 403)).fetch });
    await expect(denied.head('ws1')).rejects.toBeInstanceOf(PersonasHttpError);
  });

  it('pull: passes the page\'s first_seq through (null when empty), and leaves it out when the server sent none', async () => {
    const withFirst = webJournalApi({ base, fetch: fetchMock(() => json({ batches: [], next: null, first_seq: 4 })).fetch });
    expect(await withFirst.pull('ws1', 5)).toEqual({ batches: [], next: null, first_seq: 4 });
    const emptyJ = webJournalApi({ base, fetch: fetchMock(() => json({ batches: [], next: null, first_seq: null })).fetch });
    expect((await emptyJ.pull('ws1', 5)).first_seq).toBeNull();
    const none = webJournalApi({ base, fetch: fetchMock(() => json({ batches: [], next: null })).fetch });
    expect('first_seq' in (await none.pull('ws1', 5))).toBe(false);
    const bad = webJournalApi({ base, fetch: fetchMock(() => json({ batches: [], next: null, first_seq: 'x' })).fetch });
    await expect(bad.pull('ws1', 5)).rejects.toThrow();
  });
});

describe('webLocalCache', () => {
  it('round-trips sealed snapshots per user and workspace and clears by user or workspace', async () => {
    const idb = new FakeIdbFactory();
    const cache = webLocalCache(idb.asFactory());
    expect(await cache.load('u1', 'w1')).toBeNull();
    await cache.save('u1', 'w1', new Uint8Array([1]));
    await cache.save('u1', 'w2', new Uint8Array([2]));
    await cache.save('u2', 'w1', new Uint8Array([3]));
    expect(Array.from((await cache.load('u1', 'w1'))!)).toEqual([1]);
    expect(Array.from((await webLocalCache(idb.asFactory()).load('u2', 'w1'))!)).toEqual([3]);
    await cache.clear('u1', 'w2');
    expect(await cache.load('u1', 'w2')).toBeNull();
    expect(await cache.load('u1', 'w1')).not.toBeNull();
    await cache.clear('u1');
    expect(await cache.load('u1', 'w1')).toBeNull();
    expect(await cache.load('u2', 'w1')).not.toBeNull();
    expect([...idb.dbs.keys()]).toEqual(['dosya-personas']);
  });

  it('does not treat a user id that is a prefix of another as the same user', async () => {
    const cache = webLocalCache(new FakeIdbFactory().asFactory());
    await cache.save('u1', 'w1', new Uint8Array([1]));
    await cache.save('u10', 'w1', new Uint8Array([2]));
    await cache.clear('u1');
    expect(await cache.load('u10', 'w1')).not.toBeNull();
  });
});

describe('webKeyStore', () => {
  it('round-trips the record, wrapped under a non-extractable AES-GCM key', async () => {
    const idb = new FakeIdbFactory();
    const keys = webKeyStore(idb.asFactory());
    const rec = new Uint8Array(64).map((_, i) => i + 1);
    expect(await keys.get('u1')).toBeNull();
    await keys.set('u1', rec);
    expect(Array.from((await keys.get('u1'))!)).toEqual(Array.from(rec));
    // A second store on the same database (another tab) reads it too.
    expect(Array.from((await webKeyStore(idb.asFactory()).get('u1'))!)).toEqual(Array.from(rec));

    const store = idb.dbs.get('dosya-personas')!.stores.get('keys')!;
    const wrap = [...store.values()].find((v) => v instanceof CryptoKey) as CryptoKey;
    expect(wrap.extractable).toBe(false);
    expect(wrap.algorithm.name).toBe('AES-GCM');
    const sealed = [...store.values()].filter((v) => !(v instanceof CryptoKey)) as { iv: Uint8Array; ct: Uint8Array }[];
    expect(sealed).toHaveLength(1);
    expect(sealed[0].ct.length).toBe(64 + 16);
    expect(Array.from(sealed[0].ct.slice(0, 64))).not.toEqual(Array.from(rec));

    await keys.clear('u1');
    expect(await keys.get('u1')).toBeNull();
  });

  it('binds each record to its user: a record moved to another user does not open', async () => {
    const idb = new FakeIdbFactory();
    const keys = webKeyStore(idb.asFactory());
    await keys.set('u1', new Uint8Array(64).fill(7));
    const store = idb.dbs.get('dosya-personas')!.stores.get('keys')!;
    const k1 = [...store.keys()].find((k) => k.includes('u1'))!;
    store.set(k1.replace('u1', 'u2'), store.get(k1));
    expect(await keys.get('u2')).toBeNull();
  });

  it('a record under a lost wrapping key reads as no key', async () => {
    const idb = new FakeIdbFactory();
    await webKeyStore(idb.asFactory()).set('u1', new Uint8Array(64).fill(7));
    const store = idb.dbs.get('dosya-personas')!.stores.get('keys')!;
    for (const [k, v] of store) if (v instanceof CryptoKey) store.delete(k);
    expect(await webKeyStore(idb.asFactory()).get('u1')).toBeNull();
  });
});

describe('webFileSource', () => {
  const base = 'https://api.test';
  const tree = {
    ok: true,
    folders: [
      { id: 'fa', name: 'A', parent_id: null, file_count: 1, is_hidden: 0, lock_mode: 'none' },
      { id: 'fb', name: 'B', parent_id: 'fa', file_count: 1, is_hidden: 0, lock_mode: 'none' },
    ],
  };
  const row = (id: string, extra: Record<string, unknown> = {}) => ({
    id, name: `${id}.jpg`, folder_id: null, current_version: 1, taken_at: 100, is_hidden: 0, lock_mode: 'none', ...extra,
  });

  function server(pages: unknown[][], opts: { failPage?: number; treeBody?: unknown } = {}) {
    return fetchMock((url) => {
      const u = new URL(url);
      if (u.pathname === '/api/folders/tree') {
        if (u.searchParams.get('flags') !== '1') return json({ ok: true, folders: [] });
        return json(opts.treeBody ?? tree);
      }
      if (u.pathname === '/api/library') {
        const cursor = u.searchParams.get('cursor');
        const i = cursor ? Number(cursor) : 0;
        if (opts.failPage === i) return json({ ok: false, error: 'boom' }, 500);
        return json({ ok: true, months: [{ key: '2026-10', label: 'October', files: pages[i] }], next_cursor: i + 1 < pages.length ? String(i + 1) : null });
      }
      return json({}, 404);
    });
  }

  async function all(src: ReturnType<typeof webFileSource>, ws = 'ws1'): Promise<Candidate[]> {
    const out: Candidate[] = [];
    for await (const c of src.candidates(ws)) out.push(c);
    return out;
  }

  it('lists every photo of the workspace with its version, date and folder ancestry', async () => {
    const m = server([
      [row('p1', { folder_id: 'fb', current_version: 3, taken_at: 500 }), row('p2')],
      [row('p3', { folder_id: 'fa', current_version: null })],
    ]);
    const got = await all(webFileSource({ base, fetch: m.fetch }));
    expect(got).toEqual([
      { file: 'p1', ver: 3, folder: 'fb', ancestors: ['fa'], sortAt: 500 },
      { file: 'p2', ver: 1, folder: null, ancestors: [], sortAt: 100 },
      { file: 'p3', ver: 1, folder: 'fa', ancestors: [], sortAt: 100 },
    ]);
    const lib = m.calls.filter((c) => c.url.includes('/api/library')).map((c) => new URL(c.url));
    expect(lib[0].searchParams.get('workspace_id')).toBe('ws1');
    expect(lib[0].searchParams.get('kind')).toBe('photos');
    expect(lib[0].searchParams.get('limit')).toBe('200');
    expect(lib[1].searchParams.get('cursor')).toBe('1');
    expect(m.calls.every((c) => c.init.credentials === 'include')).toBe(true);
  });

  it('gives the listed photos\' rows by id from the same cached listing, for the persona page', async () => {
    const m = server([[row('ok', { folder_id: 'fa', mime_type: 'image/jpeg' }), row('hidden', { is_hidden: 1 })]]);
    const src = webFileSource({ base, fetch: m.fetch });
    const rows = await src.photos('ws1');
    expect([...rows.keys()]).toEqual(['ok']);
    expect(rows.get('ok')).toMatchObject({ id: 'ok', name: 'ok.jpg', folder_id: 'fa', mime_type: 'image/jpeg' });
    await all(src);
    expect(await src.photos('ws1')).toBe(rows);
    expect(m.calls.filter((c) => c.url.includes('/api/library'))).toHaveLength(1);
  });

  it('leaves out hidden and locked files and files under folders it cannot see', async () => {
    const m = server([[
      row('ok'),
      row('hidden', { is_hidden: 1 }),
      row('locked', { lock_mode: 'full_lock' }),
      row('viewonly', { lock_mode: 'view_only' }),
      row('unknownFolder', { folder_id: 'gone' }),
      row('lockedFolder', { folder_id: 'fl' }),
      row('hiddenFolder', { folder_id: 'fh2' }),
    ]], {
      treeBody: {
        ok: true,
        folders: [
          { id: 'fl', name: 'L', parent_id: null, is_hidden: 0, lock_mode: 'full_lock' },
          { id: 'fh', name: 'H', parent_id: null, is_hidden: 1, lock_mode: 'none' },
          { id: 'fh2', name: 'H2', parent_id: 'fh', is_hidden: 0, lock_mode: 'none' },
        ],
      },
    });
    expect((await all(webFileSource({ base, fetch: m.fetch }))).map((c) => c.file)).toEqual(['ok']);
  });

  it('an owner (hide_files) is listed hidden files and photos under hidden folders: none of them is a candidate', async () => {
    const m = server([[
      row('visible'),
      row('hiddenFile', { is_hidden: 1 }),
      row('underHidden', { folder_id: 'kid' }),
    ]], {
      treeBody: {
        ok: true,
        folders: [
          { id: 'secret', parent_id: null, is_hidden: 1, lock_mode: 'none' },
          { id: 'kid', parent_id: 'secret', is_hidden: 0, lock_mode: 'none' },
        ],
      },
    });
    expect((await all(webFileSource({ base, fetch: m.fetch }))).map((c) => c.file)).toEqual(['visible']);
  });

  it('a photo under a locked folder the user holds an unlock token for (so the library lists it) is not a candidate', async () => {
    const m = server([[row('inUnlocked', { folder_id: 'deep' }), row('ok', { folder_id: 'open' })]], {
      treeBody: {
        ok: true,
        folders: [
          { id: 'vault', parent_id: null, is_hidden: 0, lock_mode: 'full_lock' },
          { id: 'deep', parent_id: 'vault', is_hidden: 0, lock_mode: 'none' },
          { id: 'open', parent_id: null, is_hidden: 0, lock_mode: 'none' },
        ],
      },
    });
    expect((await all(webFileSource({ base, fetch: m.fetch }))).map((c) => c.file)).toEqual(['ok']);
  });

  it('a folder-confined member whose anchor sits under a hidden or locked folder: nothing under the anchor is a candidate', async () => {
    for (const inherited of [{ inherited_lock: 1, inherited_hidden: 0 }, { inherited_lock: 0, inherited_hidden: 1 }]) {
      const m = server([[row('p1', { folder_id: 'sub' }), row('p2', { folder_id: 'anchor' })]], {
        treeBody: { ok: true, folders: [{ id: 'anchor', parent_id: 'outside', is_hidden: 0, lock_mode: 'none', ...inherited }, { id: 'sub', parent_id: 'anchor', is_hidden: 0, lock_mode: 'none' }] },
      });
      expect(await all(webFileSource({ base, fetch: m.fetch })), JSON.stringify(inherited)).toEqual([]);
    }
  });

  it('a folder tree without the flags (an API that predates them) is an error, not a guess', async () => {
    const m = server([[row('p1')]], { treeBody: { ok: true, folders: [{ id: 'fa', parent_id: null }] } });
    await expect(all(webFileSource({ base, fetch: m.fetch }))).rejects.toThrow();
  });

  it('a folder-confined member: ancestry stops at the anchor, whose parent the tree does not list', async () => {
    const m = server([[row('p1', { folder_id: 'sub' }), row('p2', { folder_id: 'anchor' })]], {
      treeBody: { ok: true, folders: [{ id: 'anchor', parent_id: 'outside', is_hidden: 0, lock_mode: 'none', inherited_hidden: 0, inherited_lock: 0 }, { id: 'sub', parent_id: 'anchor', is_hidden: 0, lock_mode: 'none' }] },
    });
    expect(await all(webFileSource({ base, fetch: m.fetch }))).toEqual([
      { file: 'p1', ver: 1, folder: 'sub', ancestors: ['anchor'], sortAt: 100 },
      { file: 'p2', ver: 1, folder: 'anchor', ancestors: [], sortAt: 100 },
    ]);
  });

  it('throws on any listing error instead of listing nothing, and does not cache it', async () => {
    const pages = [[row('p1')], [row('p2')]];
    const failing = server(pages, { failPage: 1 });
    const src = webFileSource({ base, fetch: failing.fetch });
    await expect(all(src)).rejects.toBeInstanceOf(PersonasHttpError);
    const badTree = server(pages, { treeBody: { ok: false } });
    await expect(all(webFileSource({ base, fetch: badTree.fetch }))).rejects.toThrow();
    const badBody = fetchMock((url) => (url.includes('/tree') ? json(tree) : json({ ok: true })));
    await expect(all(webFileSource({ base, fetch: badBody.fetch }))).rejects.toThrow();
  });

  it('keeps the full listing for five minutes per workspace', async () => {
    let t = 1_000_000;
    const m = server([[row('p1')]]);
    const src = webFileSource({ base, fetch: m.fetch, now: () => t });
    await all(src);
    const n = m.calls.length;
    t += 4 * 60_000;
    expect((await all(src)).map((c) => c.file)).toEqual(['p1']);
    expect(m.calls.length).toBe(n);
    await all(src, 'ws2');
    expect(m.calls.length).toBe(2 * n);
    t += 61_000;
    await all(src);
    expect(m.calls.length).toBe(3 * n);
  });

  it('rendition: the 1600 px rendition of that version; a non-JPEG/WebP answer is unsupported', async () => {
    const m = fetchMock((url) =>
      url.includes('/f1/')
        ? new Response(new Uint8Array([9, 9]), { headers: { 'Content-Type': 'image/webp' } })
        : url.includes('/f2/')
          ? new Response('<svg/>', { headers: { 'Content-Type': 'image/svg+xml' } })
          : json({ ok: false }, 404),
    );
    const src = webFileSource({ base, fetch: m.fetch });
    expect(Array.from(await src.rendition('f1', 3))).toEqual([9, 9]);
    expect(m.calls[0].url).toBe('https://api.test/api/files/f1/thumb?w=1600&version=3');
    expect(m.calls[0].init.credentials).toBe('include');
    await expect(src.rendition('f2', 1)).rejects.toBeInstanceOf(ReaderUnsupportedError);
    const err = await src.rendition('f3', 1).catch((e) => e);
    expect(err).not.toBeInstanceOf(ReaderUnsupportedError);
    expect(err.status).toBe(404);
  });

  it('rendition: network failures and refusals that are not the photo\'s fault are unavailable; 404 and 415 are the photo\'s', async () => {
    const offline = webFileSource({ base, fetch: (async () => { throw new TypeError('Failed to fetch'); }) as unknown as typeof fetch });
    await expect(offline.rendition('f1', 1)).rejects.toBeInstanceOf(PersonasUnavailableError);
    for (const status of [401, 403, 408, 429, 500, 502, 503]) {
      const src = webFileSource({ base, fetch: fetchMock(() => json({ ok: false }, status)).fetch });
      await expect(src.rendition('f1', 1), String(status)).rejects.toBeInstanceOf(PersonasUnavailableError);
    }
    for (const status of [404, 415]) {
      const src = webFileSource({ base, fetch: fetchMock(() => json({ ok: false }, status)).fetch });
      const err = await src.rendition('f1', 1).catch((e) => e);
      expect(err, String(status)).not.toBeInstanceOf(PersonasUnavailableError);
      expect(err.status).toBe(status);
    }
  });

  it('rendition: an oversized answer is unsupported without reading it', async () => {
    const m = fetchMock(() => new Response(new Uint8Array(4), { headers: { 'Content-Type': 'image/jpeg', 'Content-Length': String(64 * 1024 * 1024) } }));
    await expect(webFileSource({ base, fetch: m.fetch }).rendition('f1', 1)).rejects.toBeInstanceOf(ReaderUnsupportedError);
  });
});
