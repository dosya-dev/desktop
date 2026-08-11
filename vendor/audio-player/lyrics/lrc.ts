/** One timed lyric line. `t` is seconds from the start of the track. */
export interface LyricLine {
  t: number;
  line: string;
}

// [mm:ss.xx], [mm:ss:xx] or [mm:ss]. Metadata headers like [ar:...] fail the
// digit match and are dropped, which is what we want - they are not lyrics.
const STAMP = /\[(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?\]/g;

export function parseLrc(text: string): LyricLine[] {
  const out: LyricLine[] = [];

  for (const raw of text.split(/\r?\n/)) {
    STAMP.lastIndex = 0;
    const stamps: number[] = [];
    let m: RegExpExecArray | null;
    let lastEnd = 0;
    while ((m = STAMP.exec(raw)) !== null) {
      // Only leading stamps count. A bracketed time inside the lyric itself
      // is text, not a cue.
      if (m.index !== lastEnd) break;
      const frac = m[3] ? Number(`0.${m[3]}`) : 0;
      stamps.push(Number(m[1]) * 60 + Number(m[2]) + frac);
      lastEnd = m.index + m[0].length;
    }
    if (stamps.length === 0) continue;

    const line = raw.slice(lastEnd).trim();
    if (!line) continue;
    for (const t of stamps) out.push({ t, line });
  }

  return out.sort((a, b) => a.t - b.t);
}
