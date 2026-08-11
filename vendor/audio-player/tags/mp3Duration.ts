import { id3TagSize } from "./id3";

/**
 * MP3 duration/bitrate from the first MPEG audio frame. Exact when a Xing/Info
 * VBR header is present; otherwise a CBR estimate from the frame bitrate.
 * NEVER throws.
 */

export interface Mp3Info {
  durationSec?: number;
  bitrateKbps?: number;
  sampleRateHz?: number;
}

const BITRATES_V1L3 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0];
const BITRATES_V2L3 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0];
const RATES_V1 = [44100, 48000, 32000, 0];
const RATES_V2 = [22050, 24000, 16000, 0];
const RATES_V25 = [11025, 12000, 8000, 0];

export function parseMp3Duration(bytes: Uint8Array): Mp3Info {
  try {
    let pos = id3TagSize(bytes);
    const scanEnd = Math.min(bytes.length - 4, pos + 64 * 1024);
    while (pos < scanEnd && !(bytes[pos] === 0xff && (bytes[pos + 1] & 0xe0) === 0xe0)) pos++;
    if (pos >= scanEnd) return {};
    const versionBits = (bytes[pos + 1] >> 3) & 0x03; // 3=MPEG1, 2=MPEG2, 0=MPEG2.5
    const layerBits = (bytes[pos + 1] >> 1) & 0x03; // 1 = Layer III
    if (layerBits !== 1 || versionBits === 1) return {};
    const mpeg1 = versionBits === 3;
    const bitrateIdx = (bytes[pos + 2] >> 4) & 0x0f;
    const rateIdx = (bytes[pos + 2] >> 2) & 0x03;
    const bitrateKbps = (mpeg1 ? BITRATES_V1L3 : BITRATES_V2L3)[bitrateIdx];
    const sampleRateHz = (versionBits === 3 ? RATES_V1 : versionBits === 2 ? RATES_V2 : RATES_V25)[rateIdx];
    if (!bitrateKbps || !sampleRateHz) return {};
    const channelMode = (bytes[pos + 3] >> 6) & 0x03; // 3 = mono
    const sideInfo = mpeg1 ? (channelMode === 3 ? 17 : 32) : channelMode === 3 ? 9 : 17;
    const xingOff = pos + 4 + sideInfo;
    const tag = bytes.slice(xingOff, xingOff + 4);
    const tagStr = String.fromCharCode(...tag);
    const samplesPerFrame = mpeg1 ? 1152 : 576;
    if ((tagStr === "Xing" || tagStr === "Info") && (bytes[xingOff + 7] & 0x01) !== 0) {
      const frames = (bytes[xingOff + 8] << 24) | (bytes[xingOff + 9] << 16) | (bytes[xingOff + 10] << 8) | bytes[xingOff + 11];
      if (frames > 0) return { durationSec: (frames * samplesPerFrame) / sampleRateHz, bitrateKbps, sampleRateHz };
    }
    const audioBytes = bytes.length - pos;
    return { durationSec: (audioBytes * 8) / (bitrateKbps * 1000), bitrateKbps, sampleRateHz };
  } catch {
    return {};
  }
}
