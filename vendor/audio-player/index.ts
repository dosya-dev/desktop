export { parseTags, TAG_HEAD_BYTES } from "./tags/parse";
export type { AudioTags } from "./tags/parse";
export { mmss, hms, stripExt } from "./format";
export {
  decodePeaks, reduceToPeaks, PEAK_COUNT, PEAK_SAMPLE_RATE, MAX_ANALYSE_BYTES,
} from "./peaks/extract";
export type { OfflineAudioContextFactory } from "./peaks/extract";
export { getCachedPeaks, putCachedPeaks, peaksCacheKey } from "./peaks/cache";
export { parseLrc } from "./lyrics/lrc";
export type { LyricLine } from "./lyrics/lrc";
