// Ported from apps/web/src/lib/personas-device/engine-host.ts - keep the two in step.
//
// One PersonasEngine per workspace per window, wired to the desktop ports,
// plus the read loop that feeds it photos. The Personas screens use
// usePersonasEngine; after a Vault unlock or setup they call unlockPersonas so
// the engine can open (or create) the user's personas key.
//
// Desktop differences: reading runs while the window is open, visible or not
// (the desktop app is the fast path; only Pause stops it), the signed-in user
// comes from AuthProvider through setPersonasUser (./teardown), the Vault is
// lib/vault/store, and the API base is the desktop API client's.
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { PersonasEngine, type EngineStatus, type FaceReaderPort, type FileSource } from '@dosya-dev/personas-engine';
import { apiBase } from '@/lib/api-client';
import { useVault } from '@/lib/vault/store';
import { afterPendingWipe } from './wipe';
import { webFileSource, webJournalApi, webKeyStore, webLocalCache, type PhotoRow, type WebFileSource } from './ports';
import { PersonasUnavailableError } from './errors';
import { createWebReader, readerSupported, type WebReader } from './reader';
import { createReaderPool, readAheadFor, readerPoolSize } from './reader-pool';
import { onPersonasTeardown, personasTornDown, personasUser, subscribePersonasUser } from './teardown';

// ---- read loop ------------------------------------------------------------

export type LoopEngine = Pick<PersonasEngine, 'status' | 'readSome' | 'subscribe'>;

export interface LoopDoc {
  readonly hidden: boolean;
  addEventListener(type: 'visibilitychange', fn: () => void): void;
  removeEventListener(type: 'visibilitychange', fn: () => void): void;
}

export interface LoopOptions {
  /** Stop reading while it is hidden (the web app's tab). Desktop passes none: it reads while the window is open. */
  doc?: LoopDoc;
  /** Photos per readSome call. */
  batch?: number;
  /** Wait after a call that found nothing to read, or while the engine is not ready. */
  idleMs?: number;
  /** First wait after an error; doubles up to maxRetryMs. */
  retryMs?: number;
  maxRetryMs?: number;
}

export interface ReadLoop {
  stop(): void;
  /** Abort the read in flight and try again after the retry delay. */
  interrupt(): void;
}

const READ_BATCH = 50;

/** A document that is never hidden: the desktop window reads whether it is in view or not. */
const ALWAYS_VISIBLE: LoopDoc = { hidden: false, addEventListener() {}, removeEventListener() {} };

/**
 * Calls engine.readSome(50) while the document is visible and the engine is
 * ready and not paused: straight again while it finds work, after idleMs
 * when it found none. Hiding the document aborts the read in flight
 * (the engine journals nothing for a photo whose read was aborted) and
 * nothing more is read until it is visible again. Without a `doc` (desktop)
 * nothing is ever hidden. While the engine is not ready or paused the loop
 * waits for the engine to report a change.
 */
export function runReadLoop(engine: LoopEngine, opts: LoopOptions = {}): ReadLoop {
  const doc = opts.doc ?? ALWAYS_VISIBLE;
  const batch = opts.batch ?? READ_BATCH;
  const idleMs = opts.idleMs ?? 120_000;
  const retryMs = opts.retryMs ?? 30_000;
  const maxRetryMs = opts.maxRetryMs ?? 5 * 60_000;
  let stopped = false;
  let running = false;
  let again = false;
  let waitingForEngine = false;
  let backoff = retryMs;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let current: AbortController | null = null;

  const clear = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };
  const schedule = (ms: number) => {
    clear();
    timer = setTimeout(() => {
      timer = null;
      void step();
    }, ms);
  };
  const retryLater = () => {
    schedule(backoff);
    backoff = Math.min(backoff * 2, maxRetryMs);
  };

  async function step(): Promise<void> {
    if (stopped || doc.hidden) return;
    if (running) {
      again = true;
      return;
    }
    running = true;
    again = false;
    let more = false;
    waitingForEngine = false;
    const ac = new AbortController();
    current = ac;
    try {
      const st = await engine.status();
      if (stopped || doc.hidden || ac.signal.aborted) return;
      if (st.state !== 'ready' || st.paused) {
        waitingForEngine = true;
        schedule(idleMs);
        return;
      }
      const n = await engine.readSome(batch, ac.signal);
      if (stopped || doc.hidden || ac.signal.aborted) return;
      backoff = retryMs;
      // More work: go straight on, without a timer. A hidden window
      // throttles timers (the desktop app reads while hidden).
      if (n > 0) more = true;
      else schedule(idleMs);
    } catch {
      if (!stopped && !doc.hidden && !ac.signal.aborted) retryLater();
    } finally {
      running = false;
      if (current === ac) current = null;
      if ((more || again) && !stopped && !doc.hidden && timer === null) {
        if (more) void Promise.resolve().then(step);
        else schedule(0);
      }
    }
  }

  const onVisibility = () => {
    if (doc.hidden) {
      clear();
      current?.abort();
    } else schedule(0);
  };
  doc.addEventListener('visibilitychange', onVisibility);
  const unsubscribe = engine.subscribe(() => {
    if (waitingForEngine && !running && !stopped && !doc.hidden) schedule(0);
  });
  schedule(0);

  return {
    stop() {
      stopped = true;
      clear();
      current?.abort();
      doc.removeEventListener('visibilitychange', onVisibility);
      unsubscribe();
    },
    interrupt() {
      if (stopped) return;
      current?.abort();
      retryLater();
    },
  };
}

/** Calls onUnavailable (which aborts the reads in flight) before a PersonasUnavailableError from the reader reaches the engine. */
export function guardReader(reader: FaceReaderPort, onUnavailable: () => void): FaceReaderPort {
  return {
    async read(photo) {
      try {
        return await reader.read(photo);
      } catch (e) {
        if (e instanceof PersonasUnavailableError) onUnavailable();
        throw e;
      }
    },
  };
}

/** The same for a rendition that could not be fetched for a reason that is not the photo's. */
export function guardFiles(files: FileSource, onUnavailable: () => void): FileSource {
  return {
    candidates: (ws) => files.candidates(ws),
    async rendition(file, ver) {
      try {
        return await files.rendition(file, ver);
      } catch (e) {
        if (e instanceof PersonasUnavailableError) onUnavailable();
        throw e;
      }
    },
  };
}

// ---- engines ----------------------------------------------------------------

interface Hosted {
  engine: PersonasEngine;
  loop: ReadLoop | null;
}

const hosted = new Map<string, Hosted>();
const hostListeners = new Set<() => void>();
/** Readers side by side on this device (one Web Worker each). */
const poolSize = readerPoolSize();

let shared: { worker: WebReader; reader: FaceReaderPort; source: WebFileSource; files: FileSource } | null = null;

function interruptAll(): void {
  for (const h of hosted.values()) h.loop?.interrupt();
}

function sharedPorts() {
  if (!shared) {
    // One pool of readers and one listing cache per window, for every workspace.
    const worker = createReaderPool(poolSize, () => createWebReader(`${apiBase()}/api/personas/models`));
    const source = webFileSource();
    shared = { worker, reader: guardReader(worker, interruptAll), source, files: guardFiles(source, interruptAll) };
  }
  return shared;
}

const DEVICE_KEY = 'dosya.personas.device';

function randomHex(bytes: number): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** A random id for this device, written into the records it journals. */
function deviceId(): string {
  try {
    const have = localStorage.getItem(DEVICE_KEY);
    if (have && /^[0-9a-f]{32}$/.test(have)) return have;
    const made = randomHex(16);
    localStorage.setItem(DEVICE_KEY, made);
    return made;
  } catch {
    return randomHex(16);
  }
}

/** "Read on this device" off, per user and workspace, kept in this device's localStorage. */
const pausedKey = (userId: string, workspaceId: string) => `dosya.personas.paused:${userId}:${workspaceId}`;

/** Unreadable storage (blocked, private window) reads as not paused. */
function storedPaused(userId: string, workspaceId: string): boolean {
  try {
    return localStorage.getItem(pausedKey(userId, workspaceId)) === '1';
  } catch {
    return false;
  }
}

function storePaused(userId: string, workspaceId: string, paused: boolean): void {
  try {
    if (paused) localStorage.setItem(pausedKey(userId, workspaceId), '1');
    else localStorage.removeItem(pausedKey(userId, workspaceId));
  } catch {
    /* kept in memory for this session */
  }
}

/** Start the engine paused if this device was paused for it, and remember every setPaused. */
function rememberPause(engine: PersonasEngine, userId: string, workspaceId: string): void {
  const set = engine.setPaused.bind(engine);
  engine.setPaused = (p: boolean) => {
    set(p);
    storePaused(userId, workspaceId, p);
  };
  if (storedPaused(userId, workspaceId)) set(true);
}

/**
 * Whether the user has a Vault identity, decided the way the Vault screens
 * decide "set up" versus "unlock" (useVault.hasIdentity, checked once if
 * unknown). Throws when that cannot be known, so a network blip never shows
 * setup to someone who has an identity.
 */
async function hasVaultIdentity(): Promise<boolean> {
  const known = useVault.getState().hasIdentity;
  if (known !== null) return known;
  await useVault.getState().checkIdentity();
  const h = useVault.getState().hasIdentity;
  if (h === null) throw new Error('personas: could not check for a Vault identity');
  return h;
}

// A sign-out teardown holds until the session's user changes (cleared, or
// someone else signed in), so nothing re-creates an engine on the way out:
// setPersonasUser lifts it (./teardown).
function signedInUser(): string {
  const id = personasUser();
  if (!id || personasTornDown()) throw new Error('personas: not signed in');
  return id;
}

/**
 * The engine for this user and workspace, made once per window. Reading
 * starts with it (while the window is open and the engine is ready and not
 * paused) when the reader can run here; where it cannot, nothing is read and
 * nothing is journaled, and the screens can tell from readerSupported().
 */
export function personasEngine(workspaceId: string): PersonasEngine {
  return engineFor(signedInUser(), workspaceId);
}

function engineFor(userId: string, workspaceId: string): PersonasEngine {
  const key = `${userId}:${workspaceId}`;
  const have = hosted.get(key);
  if (have) return have.engine;
  const { reader, files } = sharedPorts();
  const engine = new PersonasEngine({
    api: webJournalApi(),
    cache: webLocalCache(),
    keys: afterPendingWipe(webKeyStore()),
    reader,
    files,
    userId,
    workspaceId,
    deviceId: deviceId(),
    hasIdentity: hasVaultIdentity,
    readAhead: readAheadFor(poolSize),
  });
  rememberPause(engine, userId, workspaceId);
  const loop = readerSupported() ? runReadLoop(engine) : null;
  hosted.set(key, { engine, loop });
  return engine;
}

/**
 * The file rows of the photos Personas may read in the workspace, by id, from
 * the listing the engine reads from (cached for five minutes, shared with
 * it). The persona page names and opens its photos from these. A photo
 * missing here is not readable now (trashed, hidden or locked) and leaves
 * its persona on the next read.
 */
export function personasPhotoRows(workspaceId: string): Promise<ReadonlyMap<string, PhotoRow>> {
  try {
    signedInUser();
  } catch (e) {
    return Promise.reject(e);
  }
  return sharedPorts().source.photos(workspaceId);
}

export type { PhotoRow };

/** Whether this device can read photos (Web Workers and WebAssembly SIMD). Where it cannot, the screens still work from the journal. */
export function personasReaderSupported(): boolean {
  return readerSupported();
}

/**
 * Hand the unlocked Vault identity to the engine: opens the user's personas
 * key, or creates and seals it if there is none, and caches it on this
 * device. Call right after a Vault unlock or setup. The key is per user, so
 * every workspace's engine picks it up.
 */
export async function unlockPersonas(workspaceId: string): Promise<void> {
  const userId = signedInUser();
  const id = useVault.getState().engine.personasIdentity?.() ?? null;
  if (!id) throw new Error('personas: the Vault is locked');
  try {
    await personasEngine(workspaceId).unlockWith({ userId, x25519Pub: id.x25519Pub, x25519Priv: id.x25519Priv });
  } finally {
    id.x25519Priv.fill(0);
  }
  for (const fn of hostListeners) fn();
}

/** Stop every read loop, forget every engine and the listing cache, and let the reader worker go (sign-out). */
export function stopPersonasEngines(): void {
  for (const h of hosted.values()) h.loop?.stop();
  hosted.clear();
  shared?.worker.dispose();
  shared = null;
  for (const fn of hostListeners) fn();
}

onPersonasTeardown(stopPersonasEngines);

export interface PersonasEngineState {
  /** Null while signed out. */
  engine: PersonasEngine | null;
  /** Null until the first status() answers (and while signed out). */
  status: EngineStatus | null;
  /** The last status() failure (offline with nothing cached); cleared by the next answer. */
  error: unknown;
  refresh: () => void;
}

/** The workspace's engine and its status, re-read whenever the engine (or a Personas unlock) reports a change. */
export function usePersonasEngine(workspaceId: string): PersonasEngineState {
  const userId = useSyncExternalStore(subscribePersonasUser, personasUser, personasUser);
  const [epoch, setEpoch] = useState(0);
  // `epoch` makes a new engine after sign-out teardown forgot the old one.
  const engine = useMemo(
    () => (userId && epoch >= 0 && !personasTornDown() ? engineFor(userId, workspaceId) : null),
    [workspaceId, userId, epoch],
  );
  const [state, setState] = useState<{ engine: PersonasEngine | null; status: EngineStatus | null; error: unknown }>({ engine, status: null, error: null });
  const [tick, setTick] = useState(0);
  const refresh = useCallback(() => setTick((n) => n + 1), []);

  useEffect(() => {
    const onHost = () => {
      if ((engine && !isHosted(engine)) || (!engine && !personasTornDown())) setEpoch((n) => n + 1);
      refresh();
    };
    const unsubscribe = engine ? engine.subscribe(refresh) : () => undefined;
    hostListeners.add(onHost);
    return () => {
      unsubscribe();
      hostListeners.delete(onHost);
    };
  }, [engine, refresh]);

  useEffect(() => {
    if (!engine) return;
    let alive = true;
    engine.status().then(
      (status) => alive && setState({ engine, status, error: null }),
      (error) => alive && setState((s) => ({ engine, status: s.engine === engine ? s.status : null, error })),
    );
    return () => {
      alive = false;
    };
  }, [engine, tick]);

  const current = state.engine === engine ? state : { engine, status: null, error: null };
  return { engine, status: current.status, error: current.error, refresh };
}

function isHosted(engine: PersonasEngine): boolean {
  for (const h of hosted.values()) if (h.engine === engine) return true;
  return false;
}
