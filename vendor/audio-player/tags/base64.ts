const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const REVERSE: Record<string, number> = {};
for (let i = 0; i < ALPHABET.length; i++) REVERSE[ALPHABET[i]] = i;

export function base64ToBytes(b64: string): Uint8Array {
  const clean = b64.replace(/[^A-Za-z0-9+/]/g, "");
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let o = 0;
  for (let i = 0; i + 1 < clean.length; i += 4) {
    const n = (REVERSE[clean[i]] << 18) | (REVERSE[clean[i + 1]] << 12) | ((REVERSE[clean[i + 2]] ?? 0) << 6) | (REVERSE[clean[i + 3]] ?? 0);
    out[o++] = (n >> 16) & 0xff;
    if (clean[i + 2] !== undefined) out[o++] = (n >> 8) & 0xff;
    if (clean[i + 3] !== undefined) out[o++] = n & 0xff;
  }
  return out.slice(0, o);
}

export function bytesToBase64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    s += ALPHABET[(n >> 18) & 63] + ALPHABET[(n >> 12) & 63];
    s += i + 1 < bytes.length ? ALPHABET[(n >> 6) & 63] : "=";
    s += i + 2 < bytes.length ? ALPHABET[n & 63] : "=";
  }
  return s;
}
