// Hand copy of apps/web/src/lib/support-chat/sounds.ts; keep in step.
// Hand copy of apps/admin/src/app/lib/chat-sounds.ts (the receive chime and the
// mute key), plus the send pop; the two apps deploy standalone, so keep them in step.
// Send: a 120 ms soft pop gliding 520 -> 380 Hz. Receive: two soft sine notes
// (E5 then A5, 180 ms in all). Nothing here may throw: audio is a courtesy,
// never a reason for the chat to break. A browser that refuses autoplay rejects
// resume(); that rejection is swallowed and the cue is simply silent.

const MUTE_KEY = 'dosya.supportChat.sound';
const NOTES: Array<{ hz: number; at: number; len: number }> = [
  { hz: 659, at: 0, len: 0.09 },
  { hz: 880, at: 0.09, len: 0.09 },
];
const PEAK = 0.2;
const SEND = { from: 520, to: 380, len: 0.12, peak: 0.15 };

let ctx: AudioContext | null = null;

export function isMuted(): boolean {
  try { return localStorage.getItem(MUTE_KEY) === 'off'; } catch { return false; }
}

export function setMuted(muted: boolean): void {
  try {
    if (muted) localStorage.setItem(MUTE_KEY, 'off');
    else localStorage.removeItem(MUTE_KEY);
  } catch { /* storage unavailable: the choice just does not persist */ }
}

/** The shared context, created on first use; null when audio is unavailable or muted. */
function context(): AudioContext | null {
  if (isMuted() || typeof AudioContext === 'undefined') return null;
  ctx ??= new AudioContext();
  const c = ctx;
  if (c.state === 'suspended') {
    try {
      const p = c.resume() as Promise<void> | undefined;
      if (p && typeof p.catch === 'function') p.catch(() => {});
    } catch { /* an old engine that throws instead of rejecting */ }
  }
  return c;
}

export function playReceive(): void {
  try {
    const c = context();
    if (!c) return;
    const t0 = c.currentTime;
    for (const n of NOTES) {
      const osc = c.createOscillator();
      const gain = c.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(n.hz, t0 + n.at);
      gain.gain.setValueAtTime(0.0001, t0 + n.at);
      gain.gain.linearRampToValueAtTime(PEAK, t0 + n.at + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + n.at + n.len);
      osc.connect(gain);
      gain.connect(c.destination);
      osc.start(t0 + n.at);
      osc.stop(t0 + n.at + n.len);
    }
  } catch { /* sound is best effort */ }
}

export function playSend(): void {
  try {
    const c = context();
    if (!c) return;
    const t0 = c.currentTime;
    const osc = c.createOscillator();
    const gain = c.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(SEND.from, t0);
    osc.frequency.exponentialRampToValueAtTime(SEND.to, t0 + SEND.len);
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.linearRampToValueAtTime(SEND.peak, t0 + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + SEND.len);
    osc.connect(gain);
    gain.connect(c.destination);
    osc.start(t0);
    osc.stop(t0 + SEND.len);
  } catch { /* sound is best effort */ }
}
