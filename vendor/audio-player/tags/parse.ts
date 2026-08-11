/**
 * Container-sniffing tag reader. Pure: bytes in, tags out, no I/O and no
 * platform API, so the same code runs in a browser, in Electron's renderer
 * and under vitest. Callers fetch the bytes however their platform does it
 * and hand them here.
 *
 * Contract, inherited from id3.ts and mp4.ts: NEVER throws. A head read can
 * slice a frame in half and a file can be any kind of malformed - both yield
 * partial or empty results, never an exception.
 */
import { parseId3 } from "./id3";
import { parseMp4 } from "./mp4";
import { parseMp3Duration } from "./mp3Duration";

export interface AudioTags {
  title?: string;
  artist?: string;
  album?: string;
  /** Only ever an estimate. Prefer the <audio> element's own duration once it loads. */
  durationSec?: number;
  /** MP3 only - the MP4 reader does not surface a bitrate. */
  bitrateKbps?: number;
  sampleRateHz?: number;
  artwork?: { mime: string; data: Uint8Array };
  /** Raw USLT text. Plain prose, or LRC-style timestamped lines. */
  lyrics?: string;
}

/**
 * How many leading bytes a caller should fetch. ID3 tags sit at the front of
 * the file and MP4 metadata is in a leading `moov` atom in the overwhelming
 * majority of files. 256KB is the same head slice the API's EXIF extractor
 * takes, and it comfortably covers a tag carrying cover art.
 */
export const TAG_HEAD_BYTES = 262144;

type Container = "id3" | "mp4" | null;

/** ID3v2 tags start with the literal "ID3". MP4/M4A carry an "ftyp" box at offset 4. */
function sniff(bytes: Uint8Array, ext: string): Container {
  if (bytes.length >= 3 && bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33) return "id3";
  if (
    bytes.length >= 8 &&
    bytes[4] === 0x66 && bytes[5] === 0x74 && bytes[6] === 0x79 && bytes[7] === 0x70
  ) return "mp4";

  // No magic - fall back to the extension, so a tagless MP3 still gets its
  // bitrate and duration read out of the first frame header.
  const e = ext.replace(/^\./, "").toLowerCase();
  if (e === "mp3") return "id3";
  if (e === "m4a" || e === "mp4" || e === "m4b") return "mp4";
  return null;
}

/** An empty string is not a value. Rendering one draws a blank artist line. */
function clean(v: string | undefined): string | undefined {
  const t = v?.trim();
  return t ? t : undefined;
}

/** Drops undefined keys so callers can use `in` and deep-equality freely. */
function compact(tags: AudioTags): AudioTags {
  const out: AudioTags = {};
  for (const [k, v] of Object.entries(tags)) {
    if (v !== undefined) (out as Record<string, unknown>)[k] = v;
  }
  return out;
}

export function parseTags(bytes: Uint8Array, ext: string): AudioTags {
  if (!bytes || bytes.length === 0) return {};
  const container = sniff(bytes, ext);
  if (!container) return {};

  try {
    if (container === "mp4") {
      const m = parseMp4(bytes);
      return compact({
        title: clean(m.title),
        artist: clean(m.artist),
        album: clean(m.album),
        durationSec: m.durationSec,
        artwork: m.artwork,
      });
    }

    const id3 = parseId3(bytes);
    const mp3 = parseMp3Duration(bytes);
    return compact({
      title: clean(id3.title),
      artist: clean(id3.artist),
      album: clean(id3.album),
      artwork: id3.artwork,
      lyrics: id3.lyrics,
      durationSec: mp3.durationSec,
      bitrateKbps: mp3.bitrateKbps,
      sampleRateHz: mp3.sampleRateHz,
    });
  } catch {
    // The parsers promise not to throw, but this entry is the one callers
    // trust - a regression in a parser must not take a viewer down with it.
    return {};
  }
}
