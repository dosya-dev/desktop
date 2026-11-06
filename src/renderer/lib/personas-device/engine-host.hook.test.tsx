// Ported from apps/web/src/lib/personas-device/engine-host.hook.test.tsx - keep the two in step.
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { PersonasEngine, type EngineStatus } from '@dosya-dev/personas-engine';

vi.mock('@/lib/api-client', async (orig) => ({
  ...(await orig<typeof import('@/lib/api-client')>()),
  apiBase: () => 'https://api.test',
}));

const { useVault } = await import('@/lib/vault/store');
const { setPersonasUser, teardownPersonas } = await import('./teardown');
const { stopPersonasEngines, unlockPersonas, usePersonasEngine } = await import('./engine-host');
type PersonasEngineState = import('./engine-host').PersonasEngineState;

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

let root: Root | null = null;
afterEach(() => {
  if (root) act(() => root!.unmount());
  root = null;
  stopPersonasEngines();
  setPersonasUser(null);
  vi.restoreAllMocks();
});

describe('usePersonasEngine', () => {
  it('shows the engine status and asks again after a Personas unlock', async () => {
    setPersonasUser('u1');
    let next: EngineStatus = { state: 'needs_unlock' };
    vi.spyOn(PersonasEngine.prototype, 'status').mockImplementation(async () => next);
    vi.spyOn(PersonasEngine.prototype, 'unlockWith').mockResolvedValue();
    const vault = useVault.getState().engine;
    useVault.getState().__setEngine({ ...vault, personasIdentity: () => ({ x25519Pub: new Uint8Array(32), x25519Priv: new Uint8Array(32) }) });

    const seen: PersonasEngineState[] = [];
    function Probe() {
      seen.push(usePersonasEngine('w1'));
      return null;
    }
    root = createRoot(document.createElement('div'));
    await act(async () => root!.render(<Probe />));
    expect(seen[0].status).toBeNull();
    expect(seen.at(-1)!.status).toEqual({ state: 'needs_unlock' });

    next = { state: 'off' };
    await act(async () => unlockPersonas('w1'));
    expect(seen.at(-1)!.status).toEqual({ state: 'off' });
    expect(new Set(seen.map((s) => s.engine)).size).toBe(1);
    useVault.getState().__setEngine(vault);
  });

  it('signed out: no engine and no throw during render', async () => {
    const seen: PersonasEngineState[] = [];
    function Probe() {
      seen.push(usePersonasEngine('w1'));
      return null;
    }
    root = createRoot(document.createElement('div'));
    await act(async () => root!.render(<Probe />));
    expect(seen.at(-1)!.engine).toBeNull();
    expect(seen.at(-1)!.status).toBeNull();
  });

  it('after sign-out teardown, a mounted screen holds no engine while the session still names the user', async () => {
    setPersonasUser('u1');
    vi.spyOn(PersonasEngine.prototype, 'status').mockResolvedValue({ state: 'off' });
    const seen: PersonasEngineState[] = [];
    function Probe() {
      seen.push(usePersonasEngine('w1'));
      return null;
    }
    root = createRoot(document.createElement('div'));
    await act(async () => root!.render(<Probe />));
    expect(seen.at(-1)!.engine).not.toBeNull();
    const made = vi.spyOn(PersonasEngine.prototype, 'subscribe');
    await act(async () => teardownPersonas());
    expect(seen.at(-1)!.engine).toBeNull();
    expect(made).not.toHaveBeenCalled();
    await act(async () => setPersonasUser(null));
    expect(seen.at(-1)!.engine).toBeNull();
  });
});

