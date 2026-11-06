import { beforeEach, describe, expect, it, vi } from 'vitest';

const wipe = vi.fn(async (_u: string | null) => {});
vi.mock('./personas-device/wipe', () => ({ wipePersonasDevice: (u: string | null) => wipe(u) }));

const { resetSessionState } = await import('./session-reset');
const { setPersonasUser } = await import('./personas-device/teardown');

beforeEach(() => wipe.mockReset());

describe('resetSessionState and the personas key', () => {
  it("removes the signed-out user's key and snapshots from the device", () => {
    setPersonasUser('u1');
    resetSessionState();
    expect(wipe).toHaveBeenCalledWith('u1');
  });

  it('still knows the user after AuthProvider cleared it, and a failing wipe does not stop the reset', () => {
    setPersonasUser('u2');
    setPersonasUser(null);
    wipe.mockRejectedValueOnce(new Error('blocked'));
    const seen = vi.fn();
    window.addEventListener('dosya:session-reset', seen);
    expect(() => resetSessionState()).not.toThrow();
    expect(wipe).toHaveBeenCalledWith('u2');
    expect(seen).toHaveBeenCalled();
  });
});
