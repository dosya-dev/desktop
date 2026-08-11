/**
 * Minimal pure MP4/M4A reader: moov.mvhd duration + moov.udta.meta.ilst tags.
 * NEVER throws; malformed input yields partial/empty results.
 */

export interface Mp4Result {
  title?: string;
  artist?: string;
  album?: string;
  durationSec?: number;
  artwork?: { mime: string; data: Uint8Array };
}

const ARTWORK_CAP = 2 * 1024 * 1024;

function u32(b: Uint8Array, off: number): number {
  return b[off] * 0x1000000 + ((b[off + 1] << 16) | (b[off + 2] << 8) | b[off + 3]);
}

function type4(b: Uint8Array, off: number): string {
  return String.fromCharCode(b[off], b[off + 1], b[off + 2], b[off + 3]);
}

function utf8(b: Uint8Array): string {
  let s = "";
  let i = 0;
  while (i < b.length) {
    const c = b[i];
    if (c < 0x80) { s += String.fromCharCode(c); i += 1; }
    else if (c < 0xe0 && i + 1 < b.length) { s += String.fromCharCode(((c & 0x1f) << 6) | (b[i + 1] & 0x3f)); i += 2; }
    else if (c < 0xf0 && i + 2 < b.length) { s += String.fromCharCode(((c & 0x0f) << 12) | ((b[i + 1] & 0x3f) << 6) | (b[i + 2] & 0x3f)); i += 3; }
    else break;
  }
  return s.trim();
}

/** Walk children of [start,end); call visit(type, bodyStart, bodyEnd). */
function walk(b: Uint8Array, start: number, end: number, visit: (t: string, s: number, e: number) => void): void {
  let pos = start;
  while (pos + 8 <= end) {
    const size = u32(b, pos);
    if (size < 8 || pos + size > end) break;
    visit(type4(b, pos + 4), pos + 8, pos + size);
    pos += size;
  }
}

function readData(b: Uint8Array, s: number, e: number): { flags: number; payload: Uint8Array } | null {
  let out: { flags: number; payload: Uint8Array } | null = null;
  walk(b, s, e, (t, ds, de) => {
    if (t === "data" && out === null && de - ds >= 8) out = { flags: u32(b, ds) & 0xffffff, payload: b.slice(ds + 8, de) };
  });
  return out;
}

export function parseMp4(bytes: Uint8Array): Mp4Result {
  const out: Mp4Result = {};
  try {
    walk(bytes, 0, bytes.length, (t1, s1, e1) => {
      if (t1 !== "moov") return;
      walk(bytes, s1, e1, (t2, s2, e2) => {
        if (t2 === "mvhd" && e2 - s2 >= 20) {
          const version = bytes[s2];
          if (version === 0) {
            const timescale = u32(bytes, s2 + 12);
            const duration = u32(bytes, s2 + 16);
            if (timescale > 0) out.durationSec = duration / timescale;
          } else if (version === 1 && e2 - s2 >= 32) {
            const timescale = u32(bytes, s2 + 20);
            const duration = u32(bytes, s2 + 24) * 0x100000000 + u32(bytes, s2 + 28);
            if (timescale > 0) out.durationSec = duration / timescale;
          }
        }
        if (t2 !== "udta") return;
        walk(bytes, s2, e2, (t3, s3, e3) => {
          if (t3 !== "meta") return;
          walk(bytes, s3 + 4, e3, (t4, s4, e4) => { // meta: 4 bytes version/flags before children
            if (t4 !== "ilst") return;
            walk(bytes, s4, e4, (t5, s5, e5) => {
              const item = readData(bytes, s5, e5);
              if (!item) return;
              if (t5 === "©nam") out.title = out.title ?? utf8(item.payload);
              else if (t5 === "©ART") out.artist = out.artist ?? utf8(item.payload);
              else if (t5 === "©alb") out.album = out.album ?? utf8(item.payload);
              else if (t5 === "covr" && item.payload.length > 0 && item.payload.length <= ARTWORK_CAP) {
                out.artwork = out.artwork ?? { mime: item.flags === 14 ? "image/png" : "image/jpeg", data: item.payload };
              }
            });
          });
        });
      });
    });
  } catch {
    // partial results are fine
  }
  if (out.title === "") delete out.title;
  if (out.artist === "") delete out.artist;
  if (out.album === "") delete out.album;
  return out;
}
