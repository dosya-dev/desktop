/**
 * Minimal pure ID3v2 reader (2.2 / 2.3 / 2.4): title, artist, album, artwork,
 * lyrics.
 * Contract: NEVER throws - malformed input yields partial or empty results.
 * Text encodings per spec byte 0: 0 latin1, 1 utf16+BOM, 2 utf16be, 3 utf8.
 */

export interface Id3Result {
  title?: string;
  artist?: string;
  album?: string;
  artwork?: { mime: string; data: Uint8Array };
  /** USLT frame text. May be plain prose or LRC-style timestamped lines. */
  lyrics?: string;
}

const ARTWORK_CAP = 2 * 1024 * 1024;

function syncsafe(b: Uint8Array, off: number): number {
  return ((b[off] & 0x7f) << 21) | ((b[off + 1] & 0x7f) << 14) | ((b[off + 2] & 0x7f) << 7) | (b[off + 3] & 0x7f);
}

function u32(b: Uint8Array, off: number): number {
  return (b[off] << 24) | (b[off + 1] << 16) | (b[off + 2] << 8) | b[off + 3];
}

export function id3TagSize(bytes: Uint8Array): number {
  if (bytes.length < 10 || bytes[0] !== 0x49 || bytes[1] !== 0x44 || bytes[2] !== 0x33) return 0;
  return 10 + syncsafe(bytes, 6);
}

function decodeLatin1(b: Uint8Array): string {
  let s = "";
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return s;
}

function decodeUtf16(b: Uint8Array, bigEndian: boolean): string {
  let start = 0;
  let be = bigEndian;
  if (b.length >= 2 && b[0] === 0xff && b[1] === 0xfe) { be = false; start = 2; }
  else if (b.length >= 2 && b[0] === 0xfe && b[1] === 0xff) { be = true; start = 2; }
  let s = "";
  for (let i = start; i + 1 < b.length; i += 2) {
    const code = be ? (b[i] << 8) | b[i + 1] : (b[i + 1] << 8) | b[i];
    if (code === 0) break;
    s += String.fromCharCode(code);
  }
  return s;
}

function decodeUtf8(b: Uint8Array): string {
  let s = "";
  let i = 0;
  while (i < b.length) {
    const c = b[i];
    if (c === 0) break;
    if (c < 0x80) { s += String.fromCharCode(c); i += 1; }
    else if (c < 0xe0 && i + 1 < b.length) { s += String.fromCharCode(((c & 0x1f) << 6) | (b[i + 1] & 0x3f)); i += 2; }
    else if (c < 0xf0 && i + 2 < b.length) { s += String.fromCharCode(((c & 0x0f) << 12) | ((b[i + 1] & 0x3f) << 6) | (b[i + 2] & 0x3f)); i += 3; }
    else if (i + 3 < b.length) {
      const cp = ((c & 0x07) << 18) | ((b[i + 1] & 0x3f) << 12) | ((b[i + 2] & 0x3f) << 6) | (b[i + 3] & 0x3f);
      if (cp <= 0x10ffff) s += String.fromCodePoint(cp); i += 4;
    } else break;
  }
  return s;
}

function decodeText(body: Uint8Array): string {
  if (body.length === 0) return "";
  const enc = body[0];
  const rest = body.slice(1);
  const raw = enc === 1 ? decodeUtf16(rest, false) : enc === 2 ? decodeUtf16(rest, true) : enc === 3 ? decodeUtf8(rest) : decodeLatin1(rest);
  return raw.replace(/\0+$/, "").trim();
}

/** Index just past the first null terminator for the given encoding. */
function skipNullTerm(b: Uint8Array, start: number, enc: number): number {
  if (enc === 1 || enc === 2) {
    for (let i = start; i + 1 < b.length; i += 2) if (b[i] === 0 && b[i + 1] === 0) return i + 2;
    return b.length;
  }
  for (let i = start; i < b.length; i++) if (b[i] === 0) return i + 1;
  return b.length;
}

function parseApic(body: Uint8Array, v22: boolean): { mime: string; data: Uint8Array } | undefined {
  try {
    if (body.length < 4) return undefined;
    const enc = body[0];
    let mime: string;
    let pos: number;
    if (v22) {
      mime = decodeLatin1(body.slice(1, 4)).toUpperCase() === "PNG" ? "image/png" : "image/jpeg";
      pos = 4;
    } else {
      const end = skipNullTerm(body, 1, 0);
      mime = decodeLatin1(body.slice(1, end - 1)) || "image/jpeg";
      pos = end;
    }
    pos += 1; // picture type
    pos = skipNullTerm(body, pos, enc); // description
    const data = body.slice(pos);
    if (data.length === 0 || data.length > ARTWORK_CAP) return undefined;
    return { mime, data };
  } catch {
    return undefined;
  }
}

/**
 * Frames whose body is encoding byte, an optional 3-byte language code, a
 * null-terminated descriptor, then the real text. They cannot go through
 * decodeText, which stops at the descriptor's own terminator and returns an
 * empty string.
 *
 * USLT (unsynchronised lyrics) has the language code. TXXX (user-defined
 * text) does not - and TXXX matters here because ffmpeg, among others, writes
 * a generic `lyrics` tag as TXXX with the description "USLT" rather than as a
 * real USLT frame.
 */
function parseDescribedText(body: Uint8Array, hasLanguage: boolean): string | undefined {
  try {
    if (body.length < (hasLanguage ? 5 : 2)) return undefined;
    const enc = body[0];
    const wide = enc === 1 || enc === 2;
    let p = hasLanguage ? 4 : 1; // encoding byte, plus 3 language bytes when present

    // Skip the descriptor. A UTF-16 terminator is two zero bytes on an even
    // offset from the descriptor's start, not any single zero byte.
    if (wide) {
      while (p + 1 < body.length && !(body[p] === 0 && body[p + 1] === 0)) p += 2;
      p += 2;
    } else {
      while (p < body.length && body[p] !== 0) p += 1;
      p += 1;
    }
    if (p >= body.length) return undefined;

    const rest = body.slice(p);
    const text = enc === 1 ? decodeUtf16(rest, false)
      : enc === 2 ? decodeUtf16(rest, true)
      : enc === 3 ? decodeUtf8(rest)
      : decodeLatin1(rest);
    const trimmed = text.trim();
    return trimmed ? trimmed : undefined;
  } catch {
    return undefined;
  }
}

/** The descriptor of a TXXX frame, uppercased, so callers can match on it. */
function describedKey(body: Uint8Array): string {
  try {
    if (body.length < 2) return "";
    const enc = body[0];
    const wide = enc === 1 || enc === 2;
    let end = 1;
    if (wide) {
      while (end + 1 < body.length && !(body[end] === 0 && body[end + 1] === 0)) end += 2;
    } else {
      while (end < body.length && body[end] !== 0) end += 1;
    }
    const raw = body.slice(1, end);
    const text = wide ? decodeUtf16(raw, enc === 2) : enc === 3 ? decodeUtf8(raw) : decodeLatin1(raw);
    return text.trim().toUpperCase();
  } catch {
    return "";
  }
}

export function parseId3(bytes: Uint8Array): Id3Result {
  const out: Id3Result = {};
  try {
    const total = id3TagSize(bytes);
    if (total === 0) return out;
    const major = bytes[3];
    const end = Math.min(total, bytes.length);
    let pos = 10;
    if (major >= 3 && (bytes[5] & 0x40) !== 0) pos += major === 4 ? syncsafe(bytes, 10) : 4 + u32(bytes, 10); // extended header
    const idLen = major === 2 ? 3 : 4;
    const headLen = major === 2 ? 6 : 10;
    while (pos + headLen <= end) {
      const id = decodeLatin1(bytes.slice(pos, pos + idLen));
      if (!/^[A-Z0-9]+$/.test(id)) break; // padding reached
      const size = major === 2
        ? (bytes[pos + 3] << 16) | (bytes[pos + 4] << 8) | bytes[pos + 5]
        : major === 4 ? syncsafe(bytes, pos + 4) : u32(bytes, pos + 4);
      const bodyStart = pos + headLen;
      if (size <= 0 || bodyStart + size > end) break;
      const body = bytes.slice(bodyStart, bodyStart + size);
      if (id === "TIT2" || id === "TT2") out.title = out.title || (decodeText(body) || undefined);
      else if (id === "TPE1" || id === "TP1") out.artist = out.artist || (decodeText(body) || undefined);
      else if (id === "TALB" || id === "TAL") out.album = out.album || (decodeText(body) || undefined);
      else if (id === "APIC" || id === "PIC") out.artwork = out.artwork || parseApic(body, major === 2);
      else if (id === "USLT" || id === "ULT") out.lyrics = out.lyrics || parseDescribedText(body, true);
      else if (id === "TXXX" || id === "TXX") {
        // Only when the description says this is lyrics - TXXX carries every
        // other non-standard tag too, and a replaygain value is not a lyric.
        const desc = describedKey(body);
        if (desc === "USLT" || desc === "LYRICS" || desc === "UNSYNCEDLYRICS") {
          out.lyrics = out.lyrics || parseDescribedText(body, false);
        }
      }
      pos = bodyStart + size;
    }
  } catch {
    // partial results are fine
  }
  if (out.title === "") delete out.title;
  if (out.artist === "") delete out.artist;
  if (out.album === "") delete out.album;
  return out;
}
