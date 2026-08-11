/**
 * Audio bytes -> a small array of amplitude peaks for the waveform.
 *
 * The memory problem this solves: decodeAudioData expands compressed audio to
 * float32 PCM at the context's sample rate. A four-minute stereo track at
 * 44.1kHz is ~84MB; an hour-long recording is over a gigabyte. Decoding into
 * an OfflineAudioContext at PEAK_SAMPLE_RATE resamples during the decode, so
 * the footprint is roughly an order of magnitude smaller, and the PCM is
 * discarded the moment the peaks are reduced.
 *
 * THIS RUNS ON THE MAIN THREAD, and it has to: the Web Audio API is exposed on
 * Window only. `OfflineAudioContext` is undefined inside a Worker, in every
 * engine, so an earlier version of this that decoded in a worker silently
 * failed every time and fell back to a plain seek bar. Unit tests could not
 * see it because they inject a context factory; only opening a real file in a
 * real browser did.
 *
 * Running here is fine: decodeAudioData is natively asynchronous and does the
 * decoding off-thread inside the browser, so the only main-thread JS is
 * reduceToPeaks - one linear pass, a few tens of milliseconds even for the
 * largest input MAX_ANALYSE_BYTES allows.
 */

/** Bars the UI ever draws. More is wasted - the canvas is ~1900px at 5px per bar. */
export const PEAK_COUNT = 900;

/** Decode sample rate. The amplitude envelope survives; nothing else is needed. */
export const PEAK_SAMPLE_RATE = 8000;

/**
 * Above this, skip analysis and let the UI fall back to a plain seek bar.
 * 80MB of compressed audio is roughly an hour of 192kbps stereo - past the
 * point where a user will wait for a waveform they did not ask for.
 */
export const MAX_ANALYSE_BYTES = 80 * 1024 * 1024;

export type OfflineAudioContextFactory = (
  channels: number,
  length: number,
  sampleRate: number,
) => { decodeAudioData(b: ArrayBuffer): Promise<AudioBuffer> };

const defaultFactory: OfflineAudioContextFactory = (channels, length, sampleRate) =>
  new OfflineAudioContext(channels, length, sampleRate);

/**
 * Bucket the samples and keep the loudest magnitude in each. Max, not mean:
 * averaging flattens transients into mush, and the whole point of the wave is
 * showing where the loud parts are.
 */
export function reduceToPeaks(samples: Float32Array, count: number): Float32Array {
  const out = new Float32Array(count);
  if (samples.length === 0 || count === 0) return out;

  const per = samples.length / count;
  for (let i = 0; i < count; i++) {
    const start = Math.floor(i * per);
    const end = Math.max(start + 1, Math.floor((i + 1) * per));
    let max = 0;
    for (let j = start; j < end && j < samples.length; j++) {
      const v = samples[j] < 0 ? -samples[j] : samples[j];
      if (v > max) max = v;
    }
    out[i] = max;
  }
  return out;
}

export async function decodePeaks(
  bytes: ArrayBuffer,
  ctxFactory: OfflineAudioContextFactory = defaultFactory,
): Promise<Float32Array> {
  if (bytes.byteLength > MAX_ANALYSE_BYTES) {
    throw new Error(`Audio too large to analyse (${bytes.byteLength} bytes)`);
  }

  // length must be >= 1; the real value is irrelevant because decodeAudioData
  // allocates its own buffer. Only the sample rate matters here.
  const ctx = ctxFactory(1, 1, PEAK_SAMPLE_RATE);
  const buffer = await ctx.decodeAudioData(bytes);

  const channels = buffer.numberOfChannels;
  if (channels === 0) return new Float32Array(PEAK_COUNT);

  let mixed = buffer.getChannelData(0);
  if (channels > 1) {
    // Louder-of-both rather than an average: a track with one near-silent
    // channel would otherwise render at half height and read as quiet.
    const merged = new Float32Array(buffer.length);
    for (let ch = 0; ch < channels; ch++) {
      const data = buffer.getChannelData(ch);
      for (let i = 0; i < data.length; i++) {
        const v = data[i] < 0 ? -data[i] : data[i];
        if (v > merged[i]) merged[i] = v;
      }
    }
    mixed = merged;
  }

  return reduceToPeaks(mixed, PEAK_COUNT);
}
