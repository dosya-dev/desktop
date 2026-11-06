// src/records.ts
var PersonasFormatError = class extends Error {
  constructor(message) {
    super(message);
    this.name = "PersonasFormatError";
  }
};
var KINDS = /* @__PURE__ */ new Set(["face", "none", "gone", "persona", "assign", "name", "cover", "not", "merge", "drop", "tomb", "skip"]);
var SIG_FLOATS = 128;
function encodeBatch(b) {
  return new TextEncoder().encode(JSON.stringify(b));
}
function decodeBatch(bytes) {
  let parsed;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new PersonasFormatError("personas batch: not valid JSON");
  }
  const o = parsed;
  if (!o || typeof o !== "object" || o.v !== 1) throw new PersonasFormatError("personas batch: unsupported version");
  if (!Array.isArray(o.recs)) throw new PersonasFormatError("personas batch: recs is not an array");
  for (const r of o.recs) {
    if (!r || typeof r !== "object" || typeof r.k !== "string" || !KINDS.has(r.k)) {
      throw new PersonasFormatError("personas batch: unknown record kind");
    }
    checkRec(r);
  }
  return { v: 1, recs: o.recs };
}
function bad(k, field) {
  throw new PersonasFormatError(`personas batch: ${k} record has a bad ${field}`);
}
function id(r, f) {
  if (typeof r[f] !== "string" || r[f].length === 0) bad(r.k, f);
}
function idOrNull(r, f) {
  if (r[f] !== null) id(r, f);
}
function num(r, f) {
  if (typeof r[f] !== "number" || !Number.isFinite(r[f])) bad(r.k, f);
}
function frac(v) {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1;
}
function box(r) {
  const b = r.box;
  if (!b || typeof b !== "object" || Array.isArray(b)) bad(r.k, "box");
  if (!frac(b.x) || !frac(b.y) || !frac(b.w) || !frac(b.h) || !(b.w > 0) || !(b.h > 0)) bad(r.k, "box");
}
function oneOf(r, f, allowed) {
  if (!allowed.includes(r[f])) bad(r.k, f);
}
function checkRec(r) {
  switch (r.k) {
    case "face":
      id(r, "id");
      id(r, "file");
      num(r, "ver");
      box(r);
      num(r, "score");
      num(r, "at");
      id(r, "dev");
      num(r, "sortAt");
      idOrNull(r, "folder");
      if (typeof r.sig !== "string") bad("face", "sig");
      try {
        decodeSig(r.sig);
      } catch {
        bad("face", "sig");
      }
      return;
    case "none":
      id(r, "file");
      num(r, "ver");
      num(r, "at");
      id(r, "dev");
      oneOf(r, "reason", ["no_faces", "unsupported", "failed"]);
      return;
    case "gone":
      id(r, "file");
      num(r, "at");
      return;
    case "persona":
      id(r, "id");
      num(r, "at");
      return;
    case "assign":
      id(r, "face");
      idOrNull(r, "persona");
      oneOf(r, "src", ["auto", "user"]);
      num(r, "at");
      return;
    case "name":
      id(r, "persona");
      id(r, "name");
      num(r, "at");
      return;
    case "cover":
      id(r, "persona");
      id(r, "face");
      num(r, "at");
      return;
    case "not":
      id(r, "face");
      id(r, "persona");
      num(r, "at");
      return;
    case "merge":
      id(r, "into");
      id(r, "from");
      num(r, "at");
      return;
    case "drop":
      id(r, "persona");
      num(r, "at");
      return;
    case "tomb":
      id(r, "file");
      box(r);
      num(r, "at");
      return;
    case "skip":
      id(r, "folder");
      oneOf(r, "on", [true, false]);
      num(r, "at");
      return;
  }
}
var F32 = new Float32Array(1);
var U32 = new Uint32Array(F32.buffer);
function toHalf(val) {
  F32[0] = val;
  const x = U32[0];
  const sign = x >>> 16 & 32768;
  const exp = x >>> 23 & 255;
  const man = x & 8388607;
  if (exp === 255) return sign | 31744 | (man ? 512 : 0);
  let e = exp - 127 + 15;
  if (e >= 31) return sign | 31744;
  if (e <= 0) {
    if (e < -10) return sign;
    const m = man | 8388608;
    const shift = 14 - e;
    let h2 = m >>> shift;
    const rem2 = m & (1 << shift) - 1;
    const half = 1 << shift - 1;
    if (rem2 > half || rem2 === half && h2 & 1) h2++;
    return sign | h2;
  }
  let h = sign | e << 10 | man >>> 13;
  const rem = man & 8191;
  if (rem > 4096 || rem === 4096 && h & 1) h++;
  return h;
}
function fromHalf(h) {
  const sign = h & 32768 ? -1 : 1;
  const e = h >>> 10 & 31;
  const m = h & 1023;
  if (e === 0) return sign * m * 2 ** -24;
  if (e === 31) return m ? NaN : sign * Infinity;
  return sign * (1 + m / 1024) * 2 ** (e - 15);
}
var B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
var B64_REV = {};
for (let i = 0; i < 64; i++) B64_REV[B64[i]] = i;
function bytesToB64(b) {
  let out = "";
  for (let i = 0; i < b.length; i += 3) {
    const n = b[i] << 16 | (b[i + 1] ?? 0) << 8 | (b[i + 2] ?? 0);
    out += B64[n >> 18 & 63] + B64[n >> 12 & 63];
    out += i + 1 < b.length ? B64[n >> 6 & 63] : "=";
    out += i + 2 < b.length ? B64[n & 63] : "=";
  }
  return out;
}
function b64ToBytes(s) {
  if (s.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(s)) throw new PersonasFormatError("base64: malformed");
  const pad = s.endsWith("==") ? 2 : s.endsWith("=") ? 1 : 0;
  const out = new Uint8Array(s.length / 4 * 3 - pad);
  let o = 0;
  for (let i = 0; i < s.length; i += 4) {
    const n = B64_REV[s[i]] << 18 | B64_REV[s[i + 1]] << 12 | (B64_REV[s[i + 2]] ?? 0) << 6 | (B64_REV[s[i + 3]] ?? 0);
    if (o < out.length) out[o++] = n >> 16 & 255;
    if (o < out.length) out[o++] = n >> 8 & 255;
    if (o < out.length) out[o++] = n & 255;
  }
  return out;
}
function encodeSig(v) {
  if (v.length !== SIG_FLOATS) throw new PersonasFormatError("signature: expected 128 floats");
  const out = new Uint8Array(SIG_FLOATS * 2);
  for (let i = 0; i < SIG_FLOATS; i++) {
    const h = toHalf(v[i]);
    out[i * 2] = h & 255;
    out[i * 2 + 1] = h >>> 8;
  }
  return bytesToB64(out);
}
function decodeSig(s) {
  const b = b64ToBytes(s);
  if (b.length !== SIG_FLOATS * 2) throw new PersonasFormatError("signature: expected 256 bytes");
  const out = new Float32Array(SIG_FLOATS);
  let n = 0;
  for (let i = 0; i < SIG_FLOATS; i++) {
    const f = fromHalf(b[i * 2] | b[i * 2 + 1] << 8);
    if (!Number.isFinite(f)) throw new PersonasFormatError("signature: non-finite value");
    out[i] = f;
    n += f * f;
  }
  n = Math.sqrt(n);
  if (n > 0) for (let i = 0; i < SIG_FLOATS; i++) out[i] /= n;
  return out;
}

// src/crypto.ts
import {
  hpkeSeal,
  hpkeOpen,
  aeadEncrypt,
  aeadDecrypt,
  encodeAD,
  sha256,
  randomBytes
} from "@dosya-dev/e2ee-core";
var PersonasKeyError = class extends Error {
  constructor(message) {
    super(message);
    this.name = "PersonasKeyError";
  }
};
var KEY_INFO = new TextEncoder().encode("dosya-personas-key/v1");
var NONCE_BYTES = 24;
async function newPersonasKey() {
  return randomBytes(32);
}
async function sealPersonasKey(key, userId, identityX25519Pub) {
  const { enc, ciphertext } = await hpkeSeal(identityX25519Pub, KEY_INFO, key, encodeAD("personas-key", [1, userId]));
  return { enc: bytesToB64(enc), ct: bytesToB64(ciphertext) };
}
async function openPersonasKey(sealed, userId, identityX25519Priv) {
  try {
    const key = await hpkeOpen(
      identityX25519Priv,
      b64ToBytes(sealed.enc),
      KEY_INFO,
      b64ToBytes(sealed.ct),
      encodeAD("personas-key", [1, userId])
    );
    if (key.length !== 32) throw new Error("bad length");
    return key;
  } catch {
    throw new PersonasKeyError("personas key: cannot open");
  }
}
async function workspaceKey(personasKey, userId, workspaceId) {
  return sha256(encodeAD("personas-ws-key", [personasKey, userId, workspaceId]));
}
var batchAD = (userId, workspaceId) => encodeAD("personas-batch", [1, userId, workspaceId]);
async function sealBatch(wsKey, userId, workspaceId, b) {
  const { nonce, ciphertext } = await aeadEncrypt(wsKey, encodeBatch(b), batchAD(userId, workspaceId));
  const out = new Uint8Array(nonce.length + ciphertext.length);
  out.set(nonce, 0);
  out.set(ciphertext, nonce.length);
  return out;
}
async function openBatch(wsKey, userId, workspaceId, bytes) {
  if (bytes.length < NONCE_BYTES) throw new PersonasKeyError("personas batch: too short");
  let pt;
  try {
    pt = await aeadDecrypt(wsKey, bytes.slice(0, NONCE_BYTES), bytes.slice(NONCE_BYTES), batchAD(userId, workspaceId));
  } catch {
    throw new PersonasKeyError("personas batch: cannot open");
  }
  return decodeBatch(pt);
}
var snapshotAD = (userId, workspaceId) => encodeAD("personas-snapshot", [1, userId, workspaceId]);
async function sealSnapshot(wsKey, userId, workspaceId, snapshot) {
  const { nonce, ciphertext } = await aeadEncrypt(wsKey, snapshot, snapshotAD(userId, workspaceId));
  const out = new Uint8Array(nonce.length + ciphertext.length);
  out.set(nonce, 0);
  out.set(ciphertext, nonce.length);
  return out;
}
async function openSnapshot(wsKey, userId, workspaceId, bytes) {
  if (bytes.length < NONCE_BYTES) throw new PersonasKeyError("personas snapshot: too short");
  try {
    return await aeadDecrypt(wsKey, bytes.slice(0, NONCE_BYTES), bytes.slice(NONCE_BYTES), snapshotAD(userId, workspaceId));
  } catch {
    throw new PersonasKeyError("personas snapshot: cannot open");
  }
}
async function sealedKeyFingerprint(sealed) {
  return sha256(encodeAD("personas-key-fp", [sealed.enc, sealed.ct]));
}

// src/ports.ts
var ReaderUnsupportedError = class extends Error {
  constructor(message = "photo cannot be decoded") {
    super(message);
    this.name = "ReaderUnsupportedError";
  }
};
var KeyExistsError = class extends Error {
  constructor(message = "personas key exists") {
    super(message);
    this.name = "KeyExistsError";
  }
};
var JournalGoneError = class extends Error {
  constructor(message = "personas journal gone") {
    super(message);
    this.name = "JournalGoneError";
  }
};
var JournalFullError = class extends Error {
  constructor(code = "personas_journal_full") {
    super(`personas journal full: ${code}`);
    this.code = code;
    this.name = "JournalFullError";
  }
  code;
};

// src/group.ts
var MATCH_THRESHOLD = 0.363;
var MIN_PERSONA_FACES = 3;
function dot(a, b) {
  let s = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) s += a[i] * b[i];
  return s;
}
function nearestPersona(vector, centroids) {
  let best = null;
  for (const c of centroids) {
    const similarity = dot(vector, c.vector);
    if (similarity < MATCH_THRESHOLD) continue;
    if (!best || similarity > best.similarity || similarity === best.similarity && (c.named && !best.named || c.named === best.named && c.id < best.id)) {
      best = { id: c.id, similarity, named: c.named };
    }
  }
  return best ? { id: best.id, similarity: best.similarity } : null;
}
function clusterPool(faces, threshold, minSize) {
  const items = [...faces].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const n = items.length;
  if (n === 0) return [];
  const S = new Float32Array(n * n);
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const s = dot(items[i].vector, items[j].vector);
      S[i * n + j] = s;
      S[j * n + i] = s;
    }
  }
  const active = new Uint8Array(n).fill(1);
  const size = new Uint32Array(n).fill(1);
  const members = items.map((_, i) => [i]);
  const bestJ = new Int32Array(n).fill(-1);
  const bestS = new Float32Array(n).fill(-Infinity);
  const rescan = (i) => {
    let bj = -1;
    let bs = -Infinity;
    for (let k = 0; k < n; k++) {
      if (k === i || !active[k]) continue;
      const s = S[i * n + k];
      if (s > bs) {
        bs = s;
        bj = k;
      }
    }
    bestJ[i] = bj;
    bestS[i] = bs;
  };
  for (let i = 0; i < n; i++) rescan(i);
  for (; ; ) {
    let bi = -1;
    let bs = -Infinity;
    for (let i = 0; i < n; i++) {
      if (active[i] && bestJ[i] >= 0 && bestS[i] > bs) {
        bs = bestS[i];
        bi = i;
      }
    }
    if (bi < 0 || bs < threshold) break;
    const a = Math.min(bi, bestJ[bi]);
    const b = Math.max(bi, bestJ[bi]);
    const na = size[a];
    const nb = size[b];
    for (let k = 0; k < n; k++) {
      if (!active[k] || k === a || k === b) continue;
      const s = (na * S[a * n + k] + nb * S[b * n + k]) / (na + nb);
      S[a * n + k] = s;
      S[k * n + a] = s;
    }
    active[b] = 0;
    size[a] = na + nb;
    members[a] = members[a].concat(members[b]);
    members[b] = [];
    rescan(a);
    for (let k = 0; k < n; k++) {
      if (!active[k] || k === a) continue;
      if (bestJ[k] === a || bestJ[k] === b) {
        rescan(k);
      } else {
        const s = S[k * n + a];
        if (s > bestS[k] || s === bestS[k] && a < bestJ[k]) {
          bestS[k] = s;
          bestJ[k] = a;
        }
      }
    }
  }
  const groups = [];
  for (let i = 0; i < n; i++) {
    if (active[i] && members[i].length >= minSize) groups.push(members[i].slice().sort((x, y) => x - y));
  }
  groups.sort((x, y) => x[0] - y[0]);
  return groups.map((g) => g.map((i) => items[i].id));
}
function updateCentroid(old, n, added) {
  const len = old.length;
  const out = new Float32Array(len);
  let norm = 0;
  for (let i = 0; i < len; i++) {
    const v = (old[i] * n + added[i]) / (n + 1);
    out[i] = v;
    norm += v * v;
  }
  norm = Math.sqrt(norm);
  if (norm > 0) for (let i = 0; i < len; i++) out[i] /= norm;
  return out;
}

// src/grouping.ts
var REGROUP_EVERY = 200;
var POOL_PASS_MAX = 1e3;
var CENTROID_SCAN_MAX = 2e3;
var TOMB_IOU = 0.5;
function dot2(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}
function meanUnit(vectors) {
  const sum = new Float32Array(vectors[0].length);
  for (const v of vectors) for (let i = 0; i < sum.length; i++) sum[i] += v[i];
  let n = 0;
  for (let i = 0; i < sum.length; i++) n += sum[i] * sum[i];
  n = Math.sqrt(n);
  if (n > 0) for (let i = 0; i < sum.length; i++) sum[i] /= n;
  return sum;
}
function iou(a, b) {
  const ix = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
  const iy = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
  const inter = ix * iy;
  const union = a.w * a.h + b.w * b.h - inter;
  return union > 0 ? inter / union : 0;
}
function tombed(state, f) {
  const t = state.tombs.get(f.file);
  return !!t && t.some((b) => iou(b, f.box) >= TOMB_IOU);
}
function groupNewFaces(state, newFaceIds, now, newId) {
  const out = [];
  const placed = /* @__PURE__ */ new Map();
  const groupable = (f) => !!f && f.persona === null && !f.userAssigned && !placed.has(f.id) && !tombed(state, f);
  const centroids = [];
  for (const p of state.personas.values()) {
    const vs = [];
    for (const id2 of p.faces) {
      const f = state.faces.get(id2);
      if (f) vs.push(f.sig);
    }
    if (!vs.length) continue;
    centroids.push({ id: p.id, vector: meanUnit(vs), named: p.name !== null, count: vs.length, at: p.at });
  }
  centroids.sort((a, b) => a.named !== b.named ? a.named ? -1 : 1 : b.at - a.at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  centroids.length = Math.min(centroids.length, CENTROID_SCAN_MAX);
  const byId = new Map(centroids.map((c) => [c.id, c]));
  const inPhoto = /* @__PURE__ */ new Map();
  const holds = (file, persona) => {
    let s = inPhoto.get(file);
    if (!s) inPhoto.set(file, s = /* @__PURE__ */ new Set());
    s.add(persona);
  };
  for (const f of state.faces.values()) if (f.persona !== null) holds(f.file, f.persona);
  const tryJoin = (f) => {
    const here = inPhoto.get(f.file);
    const candidates = centroids.filter((c2) => !here?.has(c2.id) && !state.personas.get(c2.id).notFaces.has(f.id));
    const match = nearestPersona(f.sig, candidates);
    if (!match) return false;
    const c = byId.get(match.id);
    c.vector = updateCentroid(c.vector, c.count, f.sig);
    c.count += 1;
    holds(f.file, c.id);
    placed.set(f.id, c.id);
    out.push({ k: "assign", face: f.id, persona: c.id, src: "auto", at: now });
    return true;
  };
  let pooled = 0;
  for (const id2 of new Set(newFaceIds)) {
    const f = state.faces.get(id2);
    if (!groupable(f)) continue;
    if (!tryJoin(f)) pooled++;
  }
  if (!pooled) return out;
  state.poolNew += pooled;
  const pool = [];
  for (const f of state.faces.values()) if (groupable(f)) pool.push(f);
  const small = pool.length < REGROUP_EVERY;
  if (!small && state.poolNew < REGROUP_EVERY) return out;
  state.poolNew = 0;
  const rows = pool.slice(-POOL_PASS_MAX).reverse();
  const left = [];
  for (const f of rows) if (!tryJoin(f)) left.push(f);
  const leftById = new Map(left.map((f) => [f.id, f]));
  for (const group of clusterPool(left.map((f) => ({ id: f.id, vector: f.sig })), MATCH_THRESHOLD, MIN_PERSONA_FACES)) {
    const members = onePerPhoto(group.map((id2) => leftById.get(id2)));
    if (members.length < MIN_PERSONA_FACES) continue;
    const personaId = newId();
    out.push({ k: "persona", id: personaId, at: now });
    members.sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    for (const f of members) {
      placed.set(f.id, personaId);
      out.push({ k: "assign", face: f.id, persona: personaId, src: "auto", at: now });
    }
  }
  return out;
}
function onePerPhoto(members) {
  const mean = meanUnit(members.map((f) => f.sig));
  const best = /* @__PURE__ */ new Map();
  for (const f of members) {
    const s = dot2(f.sig, mean);
    const cur = best.get(f.file);
    if (!cur || s > cur.s || s === cur.s && f.id < cur.f.id) best.set(f.file, { f, s });
  }
  return [...best.values()].map((e) => e.f);
}

// src/state.ts
var SIG_FLOATS2 = 128;
var SNAPSHOT_V = 1;
function sigToB64(v) {
  const out = new Uint8Array(v.length * 4);
  const dv = new DataView(out.buffer);
  for (let i = 0; i < v.length; i++) dv.setFloat32(i * 4, v[i], true);
  return bytesToB64(out);
}
function sigFromB64(s) {
  const b = b64ToBytes(s);
  if (b.length !== SIG_FLOATS2 * 4) throw new PersonasFormatError("personas snapshot: bad signature");
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const out = new Float32Array(SIG_FLOATS2);
  for (let i = 0; i < SIG_FLOATS2; i++) out[i] = dv.getFloat32(i * 4, true);
  return out;
}
var IndexState = class _IndexState {
  /** Highest journal seq applied. */
  applied = 0;
  /** Insertion order is journal order: the newest face is the last entry. */
  faces = /* @__PURE__ */ new Map();
  personas = /* @__PURE__ */ new Map();
  /** file -> version that has a face/none record. */
  read = /* @__PURE__ */ new Map();
  /** file -> positions removed with Remove person; never grouped again. */
  tombs = /* @__PURE__ */ new Map();
  /** Folder ids the user skipped. */
  skipped = /* @__PURE__ */ new Set();
  /**
   * New faces that went to the pool since the last clustering pass (the
   * server's pool_new). Device-local: only grouping.ts reads and writes it,
   * replay never does; it is kept in the snapshot.
   */
  poolNew = 0;
  /** file -> face ids; derived, rebuilt on restore. */
  byFile = /* @__PURE__ */ new Map();
  /**
   * Apply one decoded batch. A seq at or below `applied` is ignored. Never
   * throws on a batch that decodeBatch accepted: records naming unknown faces
   * or personas are no-ops.
   */
  apply(seq, b) {
    if (seq <= this.applied) return;
    const fresh = /* @__PURE__ */ new Map();
    const created = /* @__PURE__ */ new Set();
    for (const r of b.recs) this.applyRec(r, fresh, created);
    for (const id2 of created) this.pruneIfEmpty(id2);
    this.applied = seq;
  }
  applyRec(r, fresh, created) {
    switch (r.k) {
      case "face":
      case "none": {
        if (!this.claimRead(r.file, r.ver, fresh)) return;
        if (r.k === "face" && !this.faces.has(r.id)) {
          this.faces.set(r.id, {
            id: r.id,
            file: r.file,
            ver: r.ver,
            box: { ...r.box },
            sig: decodeSig(r.sig),
            score: r.score,
            sortAt: r.sortAt,
            folder: r.folder,
            persona: null,
            userAssigned: false
          });
          let s = this.byFile.get(r.file);
          if (!s) this.byFile.set(r.file, s = /* @__PURE__ */ new Set());
          s.add(r.id);
        }
        return;
      }
      case "gone":
        this.removeFileFaces(r.file);
        this.read.delete(r.file);
        fresh.delete(r.file);
        return;
      case "persona":
        if (this.personas.has(r.id)) return;
        this.personas.set(r.id, { id: r.id, name: null, cover: null, faces: /* @__PURE__ */ new Set(), notFaces: /* @__PURE__ */ new Set(), at: r.at });
        created.add(r.id);
        return;
      case "assign": {
        const f = this.faces.get(r.face);
        if (!f) return;
        if (r.src === "auto" && f.userAssigned) return;
        const target = r.persona === null ? null : this.personas.get(r.persona);
        if (target === void 0) return;
        if (target && f.persona === target.id) {
          f.userAssigned = r.src === "user";
          if (r.src === "user") target.notFaces.delete(f.id);
          return;
        }
        const old = f.persona;
        this.unassign(f, false);
        f.userAssigned = r.src === "user";
        if (target) {
          if (r.src === "user") target.notFaces.delete(f.id);
          f.persona = target.id;
          target.faces.add(f.id);
          if (target.cover === null) target.cover = f.id;
        }
        if (old !== null) this.pruneIfEmpty(old);
        return;
      }
      case "name": {
        const p = this.personas.get(r.persona);
        if (p) p.name = r.name;
        return;
      }
      case "cover": {
        const p = this.personas.get(r.persona);
        if (p && p.faces.has(r.face)) p.cover = r.face;
        return;
      }
      case "not": {
        const p = this.personas.get(r.persona);
        if (!p) return;
        p.notFaces.add(r.face);
        const f = this.faces.get(r.face);
        if (f && f.persona === p.id) {
          this.unassign(f);
          f.userAssigned = false;
        }
        return;
      }
      case "merge": {
        if (r.into === r.from) return;
        const into = this.personas.get(r.into);
        const from = this.personas.get(r.from);
        if (!into || !from) return;
        for (const id2 of from.faces) {
          const f = this.faces.get(id2);
          if (f) f.persona = into.id;
          into.faces.add(id2);
        }
        for (const id2 of from.notFaces) into.notFaces.add(id2);
        if (into.name === null) into.name = from.name;
        if (into.cover === null) into.cover = from.cover;
        this.personas.delete(from.id);
        return;
      }
      case "drop": {
        const p = this.personas.get(r.persona);
        if (!p) return;
        for (const id2 of p.faces) this.deleteFace(id2);
        this.personas.delete(p.id);
        return;
      }
      case "tomb": {
        let t = this.tombs.get(r.file);
        if (!t) this.tombs.set(r.file, t = []);
        t.push({ ...r.box });
        return;
      }
      case "skip":
        if (r.on) this.skipped.add(r.folder);
        else this.skipped.delete(r.folder);
        return;
    }
  }
  /**
   * Whether a face/none record for (file, ver) applies. First batch wins: a
   * version already read in an earlier seq at or above `ver` ignores it. A
   * higher version clears the file's older faces first.
   */
  claimRead(file, ver, fresh) {
    const mine = fresh.get(file);
    if (mine !== void 0 && ver === mine) return true;
    if (mine !== void 0 && ver < mine) return false;
    if (mine === void 0) {
      const cur = this.read.get(file);
      if (cur !== void 0 && cur >= ver) return false;
    }
    this.removeFileFaces(file);
    this.read.set(file, ver);
    fresh.set(file, ver);
    return true;
  }
  removeFileFaces(file) {
    const ids = this.byFile.get(file);
    if (!ids) return;
    for (const id2 of [...ids]) this.deleteFace(id2);
  }
  deleteFace(id2) {
    const f = this.faces.get(id2);
    if (!f) return;
    this.unassign(f);
    this.faces.delete(id2);
    const s = this.byFile.get(f.file);
    if (s) {
      s.delete(id2);
      if (!s.size) this.byFile.delete(f.file);
    }
  }
  /** Take the face out of its persona; fix the cover; drop an emptied unnamed persona unless `prune` is false. */
  unassign(f, prune = true) {
    if (f.persona === null) return;
    const p = this.personas.get(f.persona);
    f.persona = null;
    if (!p) return;
    p.faces.delete(f.id);
    if (p.cover === f.id) p.cover = this.bestFace(p);
    if (prune) this.pruneIfEmpty(p.id);
  }
  /** The best-scored face left (ties: lowest id), or null. */
  bestFace(p) {
    let best = null;
    for (const id2 of p.faces) {
      const f = this.faces.get(id2);
      if (!f) continue;
      if (!best || f.score > best.score || f.score === best.score && f.id < best.id) best = f;
    }
    return best ? best.id : null;
  }
  /** A persona with no faces is deleted unless it has a name (the server's R29 behaviour). */
  pruneIfEmpty(id2) {
    const p = this.personas.get(id2);
    if (p && p.faces.size === 0 && p.name === null) this.personas.delete(id2);
  }
  snapshot() {
    const o = {
      v: SNAPSHOT_V,
      applied: this.applied,
      poolNew: this.poolNew,
      faces: [...this.faces.values()].map((f) => ({ ...f, box: { ...f.box }, sig: sigToB64(f.sig) })),
      personas: [...this.personas.values()].map((p) => ({ ...p, faces: [...p.faces], notFaces: [...p.notFaces] })),
      read: [...this.read],
      tombs: [...this.tombs],
      skipped: [...this.skipped]
    };
    return new TextEncoder().encode(JSON.stringify(o));
  }
  static restore(bytes) {
    let o;
    try {
      o = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    } catch {
      throw new PersonasFormatError("personas snapshot: not valid JSON");
    }
    if (!o || typeof o !== "object" || o.v !== SNAPSHOT_V) throw new PersonasFormatError("personas snapshot: unsupported version");
    try {
      const s = new _IndexState();
      s.applied = num2(o.applied);
      s.poolNew = num2(o.poolNew);
      for (const f of arr(o.faces)) {
        const row = {
          id: str(f.id),
          file: str(f.file),
          ver: num2(f.ver),
          box: box2(f.box),
          sig: sigFromB64(str(f.sig)),
          score: num2(f.score),
          sortAt: num2(f.sortAt),
          folder: f.folder === null ? null : str(f.folder),
          persona: f.persona === null ? null : str(f.persona),
          userAssigned: f.userAssigned === true
        };
        s.faces.set(row.id, row);
        let set = s.byFile.get(row.file);
        if (!set) s.byFile.set(row.file, set = /* @__PURE__ */ new Set());
        set.add(row.id);
      }
      for (const p of arr(o.personas)) {
        const row = {
          id: str(p.id),
          name: p.name === null ? null : str(p.name),
          cover: p.cover === null ? null : str(p.cover),
          faces: new Set(arr(p.faces).map(str)),
          notFaces: new Set(arr(p.notFaces).map(str)),
          at: num2(p.at)
        };
        s.personas.set(row.id, row);
      }
      for (const e of arr(o.read)) {
        const [file, ver] = arr(e);
        s.read.set(str(file), num2(ver));
      }
      for (const e of arr(o.tombs)) {
        const [file, boxes] = arr(e);
        s.tombs.set(str(file), arr(boxes).map(box2));
      }
      for (const f of arr(o.skipped)) s.skipped.add(str(f));
      return s;
    } catch (e) {
      if (e instanceof PersonasFormatError) throw e;
      throw new PersonasFormatError("personas snapshot: malformed");
    }
  }
};
function bad2() {
  throw new PersonasFormatError("personas snapshot: malformed");
}
function num2(v) {
  return typeof v === "number" && Number.isFinite(v) ? v : bad2();
}
function str(v) {
  return typeof v === "string" ? v : bad2();
}
function arr(v) {
  return Array.isArray(v) ? v : bad2();
}
function box2(v) {
  const b = v;
  if (!b || typeof b !== "object") bad2();
  return { x: num2(b.x), y: num2(b.y), w: num2(b.w), h: num2(b.h) };
}

// src/engine.ts
var PersonasEngineError = class extends Error {
  constructor(code) {
    super(code);
    this.code = code;
    this.name = "PersonasEngineError";
  }
  code;
};
var MAX_RECS = 500;
var PHOTOS_PER_BATCH = 50;
var READ_AHEAD_DEFAULT = 4;
var READ_AHEAD_MAX = 16;
var MAX_FACES_PER_PHOTO = 100;
var NAME_MAX = 60;
var PHOTOS_PAGE_DEFAULT = 60;
var PHOTOS_PAGE_MAX = 500;
var FIND_DEFAULT = 8;
var FIND_MAX = 50;
var KEY_BYTES = 32;
function randomId() {
  const b = new Uint8Array(16);
  globalThis.crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}
function nameKey(name) {
  return name.normalize("NFKC").toLowerCase();
}
function sameBytes(a, b) {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i];
  return d === 0;
}
var clamp01 = (v) => Math.min(1, Math.max(0, v));
function clipBox(b) {
  if (![b.x, b.y, b.w, b.h].every(Number.isFinite)) return null;
  if (b.x >= 0 && b.y >= 0 && b.w > 0 && b.h > 0 && b.x + b.w <= 1 && b.y + b.h <= 1) return { x: b.x, y: b.y, w: b.w, h: b.h };
  const x = clamp01(b.x);
  const y = clamp01(b.y);
  const w = clamp01(b.x + b.w) - x;
  const h = clamp01(b.y + b.h) - y;
  return w > 0 && h > 0 ? { x, y, w, h } : null;
}
function chunks(xs, n) {
  const out = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
}
var isKeyExists = (e) => e instanceof KeyExistsError || e?.name === "KeyExistsError";
var isJournalGone = (e) => e instanceof JournalGoneError || e?.name === "JournalGoneError";
var isJournalFull = (e) => e instanceof JournalFullError || e?.name === "JournalFullError";
var isUnsupported = (e) => e instanceof ReaderUnsupportedError || e?.name === "ReaderUnsupportedError";
var PersonasEngine = class {
  d;
  state = new IndexState();
  wsKey = null;
  /** The cached key matched the server's sealed key this session. */
  verified = false;
  synced = false;
  paused = false;
  reading = false;
  /**
   * The server refused an append as over a storage cap: this instance reads
   * no more (and retries nothing) until the index is deleted or reset.
   */
  full = false;
  /** The state moved past the saved snapshot; saveCache() writes it. */
  dirty = false;
  /** Last candidate walk: eligible file -> version. */
  eligible = null;
  /** `${file}:${ver}` -> failed reads this session. */
  attempts = /* @__PURE__ */ new Map();
  skipped = /* @__PURE__ */ new Set();
  listeners = /* @__PURE__ */ new Set();
  lock = Promise.resolve();
  /** Bumped when the index is deleted here; reads started before drop their records. */
  gen = 0;
  constructor(deps) {
    this.d = { now: () => Date.now(), newId: randomId, ...deps, readAhead: deps.readAhead ?? READ_AHEAD_DEFAULT };
  }
  // ---- status, key ----------------------------------------------------
  /**
   * The gate the screens show. Throws (the network error) when the first sync
   * fails and there is no cached index to answer from; hosts catch it and retry.
   */
  async status() {
    if (!await this.d.hasIdentity()) return { state: "needs_identity" };
    if (!this.synced) {
      try {
        await this.sync();
      } catch (e) {
        if (!this.wsKey || this.state.applied === 0) throw e;
      }
    }
    if (!this.wsKey) return { state: "needs_unlock" };
    if (this.state.applied === 0) return { state: "off" };
    return { state: "ready", read: this.readCount(), total: this.eligible ? this.eligible.size : null, reading: this.reading, paused: this.paused };
  }
  /** Opens the user's personas key with the unlocked identity, or creates and seals it if there is none; caches it. */
  async unlockWith(identity) {
    if (identity.userId !== this.d.userId) throw new PersonasEngineError("invalid");
    await this.exclusive(async () => {
      const { api, userId } = this.d;
      let sealed = await api.getKey();
      let key;
      if (sealed) {
        key = await openPersonasKey(sealed, userId, identity.x25519Priv);
      } else {
        key = await newPersonasKey();
        const mine = await sealPersonasKey(key, userId, identity.x25519Pub);
        try {
          await api.putKey(mine);
          sealed = mine;
        } catch (e) {
          if (!isKeyExists(e)) throw e;
          sealed = await api.getKey();
          if (!sealed) throw e;
          key = await openPersonasKey(sealed, userId, identity.x25519Priv);
        }
      }
      const fp = await sealedKeyFingerprint(sealed);
      const rec = new Uint8Array(KEY_BYTES + fp.length);
      rec.set(key, 0);
      rec.set(fp, KEY_BYTES);
      await this.d.keys.set(userId, rec);
      this.wsKey = null;
      this.state = new IndexState();
      this.eligible = null;
      this.synced = false;
    });
    this.notify();
  }
  /**
   * Loads the cached key and snapshot once. False when there is no usable
   * key (status needs_unlock). On first load the key is checked against the
   * server's sealed key; a different or missing one means it was replaced.
   */
  async prepare() {
    if (this.wsKey) return true;
    const { keys, api, cache, userId, workspaceId } = this.d;
    const rec = await keys.get(userId);
    if (!rec || rec.length !== KEY_BYTES * 2) return false;
    const key = rec.slice(0, KEY_BYTES);
    let server;
    try {
      server = await api.getKey();
    } catch {
      server = void 0;
    }
    if (server === null || server && !sameBytes(await sealedKeyFingerprint(server), rec.slice(KEY_BYTES))) {
      await this.lockOut();
      return false;
    }
    this.verified = server !== void 0;
    this.wsKey = await workspaceKey(key, userId, workspaceId);
    this.state = new IndexState();
    this.dirty = false;
    const sealedSnap = await cache.load(userId, workspaceId);
    if (sealedSnap) {
      try {
        this.state = IndexState.restore(await openSnapshot(this.wsKey, userId, workspaceId, sealedSnap));
      } catch {
        this.state = new IndexState();
        await cache.clear(userId, workspaceId);
      }
    }
    return true;
  }
  /** The cached key does not fit this user's journal: forget it and everything derived from it. */
  async lockOut() {
    this.wsKey = null;
    this.verified = false;
    this.state = new IndexState();
    this.eligible = null;
    await this.d.keys.clear(this.d.userId);
    await this.d.cache.clear(this.d.userId, this.d.workspaceId);
    this.notify();
  }
  // ---- journal ----------------------------------------------------------
  async sync() {
    const changed = await this.exclusive(() => this.saving(() => this.syncLocked()));
    if (changed) this.notify();
  }
  /**
   * Pull and apply everything after `applied`; marks the state dirty if
   * anything changed (the outer operation saves it once). The head answers
   * "nothing new" without a batch body. The journal is append-only and a seq
   * is never reused, so while it still holds the batches this index applied,
   * its first seq is at most `applied`: a first seq above it (or none) means
   * it was deleted elsewhere, maybe re-created, and the index restarts.
   */
  async syncLocked() {
    if (!await this.prepare()) return false;
    const { api, userId, workspaceId } = this.d;
    let changed = false;
    const head = await api.head(workspaceId);
    const base0 = this.state.applied;
    if (base0 > 0 && (head.first_seq === null || head.first_seq > base0 || head.last_seq === null || head.last_seq < base0)) {
      if (!await this.restart()) return true;
      changed = true;
    }
    const base = this.state.applied;
    if (head.last_seq === null || head.last_seq <= base) {
      this.synced = true;
      return changed;
    }
    let after = base;
    for (; ; ) {
      const page = await api.pull(workspaceId, after);
      if (base > 0 && page.first_seq !== void 0 && (page.first_seq === null || page.first_seq > base)) {
        if (!await this.restart()) return true;
        await this.syncLocked();
        return true;
      }
      for (const b of page.batches) {
        if (b.seq <= this.state.applied) continue;
        let batch;
        try {
          batch = await openBatch(this.wsKey, userId, workspaceId, b.body);
        } catch (e) {
          if (e instanceof PersonasKeyError && !this.verified) {
            await this.lockOut();
            return false;
          }
          if (!(e instanceof PersonasKeyError) && !(e instanceof PersonasFormatError)) throw e;
          this.skipped.add(b.seq);
          batch = { v: 1, recs: [] };
        }
        this.state.apply(b.seq, batch);
        this.dirty = true;
        changed = true;
      }
      if (page.next === null || page.next <= after) break;
      after = page.next;
    }
    this.synced = true;
    return changed;
  }
  /**
   * The journal was deleted, maybe with the key: forget the local index and
   * check the key again (prepare) before reading or writing anything under
   * it. False when there is no usable key.
   */
  async restart() {
    await this.d.cache.clear(this.d.userId, this.d.workspaceId);
    this.resetLocal();
    this.notify();
    return this.prepare();
  }
  /** Forget everything derived from the journal and the cached key's check; the next prepare() starts over. */
  resetLocal() {
    this.wsKey = null;
    this.verified = false;
    this.state = new IndexState();
    this.eligible = null;
    this.attempts.clear();
    this.skipped.clear();
    this.full = false;
    this.dirty = false;
  }
  /**
   * Seal and write the whole index, only if it changed since the last save.
   * The snapshot grows with the index (about 850 bytes a face), so it is
   * written once per outer operation (a sync, a readSome call, a persona
   * action), never per journal append.
   */
  async saveCache() {
    if (!this.dirty || !this.wsKey) return;
    const { userId, workspaceId } = this.d;
    this.dirty = false;
    try {
      await this.d.cache.save(userId, workspaceId, await sealSnapshot(this.wsKey, userId, workspaceId, this.state.snapshot()));
    } catch (e) {
      this.dirty = true;
      throw e;
    }
  }
  /** Inside the lock: run fn, then save the index once if it changed (also after fn failed; then a save error is not reported over fn's). */
  async saving(fn) {
    let out;
    try {
      out = await fn();
    } catch (e) {
      await this.saveCache().catch(() => void 0);
      throw e;
    }
    await this.saveCache();
    return out;
  }
  /**
   * Append recs (split at the record limit, order kept) and apply them by
   * syncing. Inside the lock. Only `create` (turnOn) may start an empty
   * journal; any other append the server refuses as gone means the journal
   * was deleted elsewhere: the index resets, the records are dropped (not
   * retried) and the caller gets not_ready.
   */
  async commit(recs, allowEmpty = false, create = false) {
    const parts = recs.length ? chunks(recs, MAX_RECS) : allowEmpty ? [[]] : [];
    const { api, userId, workspaceId } = this.d;
    let gone = false;
    try {
      for (const [i, p] of parts.entries()) {
        if (!this.wsKey) throw new PersonasEngineError("not_ready");
        const body = await sealBatch(this.wsKey, userId, workspaceId, { v: 1, recs: p });
        if (create && i === 0) await api.append(workspaceId, body, { create: true });
        else await api.append(workspaceId, body);
      }
    } catch (e) {
      if (!isJournalGone(e)) throw e;
      gone = true;
      await this.journalGone();
      throw new PersonasEngineError("not_ready");
    } finally {
      if (parts.length && !gone) await this.syncLocked();
    }
  }
  /**
   * The journal was deleted on another device: reads in flight drop their
   * records (gen), then the same reset as the sync probe's, and a fresh pull
   * (the key is checked again first). Inside the lock.
   */
  async journalGone() {
    this.gen++;
    if (await this.restart()) await this.syncLocked();
  }
  /** Run a change under the lock with the index loaded and on; then notify. */
  async mutate(fn) {
    try {
      return await this.exclusive(() => this.saving(async () => {
        if (!await this.prepare()) throw new PersonasEngineError("not_ready");
        await this.syncLocked();
        if (!this.wsKey || this.state.applied === 0) throw new PersonasEngineError("not_ready");
        return fn();
      }));
    } finally {
      this.notify();
    }
  }
  exclusive(fn) {
    const run = this.lock.then(fn, fn);
    this.lock = run.catch(() => void 0);
    return run;
  }
  skippedBatches() {
    return this.skipped.size;
  }
  // ---- on / off ---------------------------------------------------------
  async turnOn() {
    await this.exclusive(() => this.saving(async () => {
      if (!await this.prepare()) throw new PersonasEngineError("not_ready");
      await this.syncLocked();
      if (!this.wsKey) throw new PersonasEngineError("not_ready");
      if (this.state.applied === 0) await this.commit([], true, true);
    }));
    this.notify();
  }
  async turnOff() {
    await this.deleteIndex();
  }
  async deleteIndex() {
    await this.exclusive(async () => {
      await this.d.api.deleteJournal(this.d.workspaceId);
      await this.d.cache.clear(this.d.userId, this.d.workspaceId);
      this.gen++;
      this.state = new IndexState();
      this.eligible = null;
      this.attempts.clear();
      this.skipped.clear();
      this.full = false;
      this.dirty = false;
    });
    this.notify();
  }
  // ---- reading ----------------------------------------------------------
  setPaused(p) {
    if (this.paused === p) return;
    this.paused = p;
    this.notify();
  }
  isPaused() {
    return this.paused;
  }
  readCount() {
    if (!this.eligible) return this.state.read.size;
    let n = 0;
    for (const [file, ver] of this.eligible) {
      const r = this.state.read.get(file);
      if (r !== void 0 && r >= ver) n++;
    }
    return n;
  }
  /**
   * Read up to `max` unread photos and journal them in batches. The index
   * snapshot is saved once, when the call ends. Over a storage cap (the
   * server refused an append with JournalFullError) it stops, resolves with
   * what it journaled, and later calls read nothing.
   */
  async readSome(max, signal) {
    if (this.paused || this.reading || this.full || !(max > 0)) return 0;
    this.reading = true;
    this.notify();
    let failed = false;
    try {
      return await this.readBatches(max, signal);
    } catch (e) {
      if (isJournalFull(e)) {
        this.full = true;
        return 0;
      }
      failed = true;
      throw e;
    } finally {
      try {
        await this.exclusive(() => this.saveCache());
      } catch (e) {
        if (!failed) throw e;
      } finally {
        this.reading = false;
        this.notify();
      }
    }
  }
  async readBatches(max, signal) {
    const changed = await this.exclusive(() => this.syncLocked());
    if (changed) this.notify();
    if (!this.wsKey || this.state.applied === 0 || signal?.aborted) return 0;
    const gen = this.gen;
    const eligible = /* @__PURE__ */ new Map();
    const todo = [];
    for await (const c of this.d.files.candidates(this.d.workspaceId)) {
      if (signal?.aborted) return 0;
      if (this.inSkipped(c)) continue;
      eligible.set(c.file, c.ver);
      todo.push(c);
    }
    this.eligible = eligible;
    const gone = [...this.state.read.keys()].filter((f) => !eligible.has(f));
    if (gone.length) {
      const at = this.d.now();
      await this.exclusive(async () => {
        if (gen === this.gen) await this.commit(gone.map((file) => ({ k: "gone", file, at })));
      }).catch((e) => {
        if (gen === this.gen) throw e;
      });
      this.notify();
      if (gen !== this.gen) return 0;
    }
    const unread = todo.filter((c) => {
      const r = this.state.read.get(c.file);
      return (r === void 0 || r < c.ver) && (this.attempts.get(`${c.file}:${c.ver}`) ?? 0) < 2;
    }).sort((a, b) => b.sortAt - a.sortAt || (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
    let done = 0;
    let tries = 0;
    let pending = [];
    let size = 0;
    const width = Math.min(READ_AHEAD_MAX, Math.max(1, Math.floor(this.d.readAhead) || 1));
    const inflight = [];
    let running = 0;
    let next = 0;
    let closed = false;
    const launch = () => {
      while (!closed && running < width && next < unread.length) {
        if (tries >= max || signal?.aborted || this.paused || gen !== this.gen) return;
        const c = unread[next++];
        if (this.inSkipped(c)) continue;
        tries++;
        running++;
        inflight.push(
          this.readOne(c, gen, signal).then((recs) => {
            running--;
            launch();
            return recs ? { c, recs } : null;
          })
        );
      }
    };
    try {
      launch();
      for (let i = 0; i < inflight.length; i++) {
        const r = await inflight[i];
        if (signal?.aborted) {
          for (const p of pending) this.forgetFailure(p);
          for (let j = i; j < inflight.length; j++) void inflight[j].then((d) => d && this.forgetFailure(d));
          pending = [];
          break;
        }
        if (!r) continue;
        if (pending.length >= PHOTOS_PER_BATCH || size + r.recs.length > MAX_RECS) {
          const n = await this.flushOrFull(pending, gen);
          if (n === null) return done;
          done += n;
          pending = [];
          size = 0;
        }
        pending.push(r);
        size += r.recs.length;
      }
      if (pending.length && !signal?.aborted) {
        const n = await this.flushOrFull(pending, gen);
        if (n !== null) done += n;
      }
      return done;
    } finally {
      closed = true;
      await Promise.allSettled(inflight);
    }
  }
  /** A read result that will not be journaled: if it records a failure, forget the failed tries. */
  forgetFailure(r) {
    for (const rec of r.recs) {
      if (rec.k === "none" && rec.reason === "failed") this.attempts.delete(`${rec.file}:${rec.ver}`);
    }
  }
  /** flush(), or null (and reading stops) when the server refused the batch as over a storage cap. */
  async flushOrFull(reads, gen) {
    try {
      return await this.flush(reads, gen);
    } catch (e) {
      if (!isJournalFull(e)) throw e;
      this.full = true;
      this.notify();
      return null;
    }
  }
  /** The records for one photo, or null when it failed and may be tried again later this session. */
  async readOne(c, gen, signal) {
    const { now, deviceId } = this.d;
    try {
      const photo = await this.d.files.rendition(c.file, c.ver, signal);
      if (signal?.aborted) return null;
      const faces = await this.d.reader.read(photo);
      if (signal?.aborted) return null;
      const recs = [];
      const best = faces.filter((f) => Number.isFinite(f.score) && f.sig.length === 128 && f.sig.every(Number.isFinite)).sort((a, b) => b.score - a.score).slice(0, MAX_FACES_PER_PHOTO);
      for (const f of best) {
        const box3 = clipBox(f.box);
        if (!box3) continue;
        recs.push({
          k: "face",
          id: this.d.newId(),
          file: c.file,
          ver: c.ver,
          box: box3,
          sig: encodeSig(f.sig),
          score: f.score,
          at: now(),
          dev: deviceId,
          sortAt: c.sortAt,
          folder: c.folder
        });
      }
      return recs.length ? recs : [{ k: "none", file: c.file, ver: c.ver, at: now(), dev: deviceId, reason: "no_faces" }];
    } catch (e) {
      if (signal?.aborted) return null;
      if (isUnsupported(e)) return [{ k: "none", file: c.file, ver: c.ver, at: now(), dev: deviceId, reason: "unsupported" }];
      if (gen !== this.gen) return null;
      const key = `${c.file}:${c.ver}`;
      const n = (this.attempts.get(key) ?? 0) + 1;
      this.attempts.set(key, n);
      return n >= 2 ? [{ k: "none", file: c.file, ver: c.ver, at: now(), dev: deviceId, reason: "failed" }] : null;
    }
  }
  /**
   * Journal one read batch, then group the faces that landed and journal
   * that. Under the lock, photos whose folder was skipped meanwhile are
   * dropped, and nothing is written if the index was deleted since `gen`.
   * Returns the photos journaled.
   */
  async flush(reads, gen) {
    const n = await this.exclusive(async () => {
      if (gen !== this.gen || !this.wsKey) return 0;
      const keep = reads.filter((r) => !this.inSkipped(r.c));
      if (!keep.length) return 0;
      const recs = keep.flatMap((r) => r.recs);
      try {
        await this.commit(recs);
      } catch (e) {
        if (gen !== this.gen) return 0;
        throw e;
      }
      const ids = recs.flatMap((r) => r.k === "face" ? [r.id] : []);
      if (!ids.length) return keep.length;
      const poolNew = this.state.poolNew;
      const out = groupNewFaces(this.state, ids, this.d.now(), this.d.newId);
      try {
        await this.commit(out);
      } catch (e) {
        if (gen !== this.gen) return 0;
        this.state.poolNew = poolNew;
        throw e;
      }
      return keep.length;
    });
    this.notify();
    return n;
  }
  inSkipped(c) {
    const s = this.state.skipped;
    if (!s.size) return false;
    return c.folder !== null && s.has(c.folder) || Array.isArray(c.ancestors) && c.ancestors.some((a) => s.has(a));
  }
  // ---- queries ----------------------------------------------------------
  subscribe(fn) {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }
  notify() {
    for (const fn of [...this.listeners]) {
      try {
        fn();
      } catch {
      }
    }
  }
  visible(p) {
    return p.faces.size >= MIN_PERSONA_FACES || p.name !== null && p.faces.size > 0;
  }
  /** Null only if none of its faces is in the index (never after a clean replay). */
  card(p) {
    let cover = p.cover !== null && p.faces.has(p.cover) ? this.state.faces.get(p.cover) : void 0;
    if (!cover) {
      for (const id2 of p.faces) {
        const f = this.state.faces.get(id2);
        if (f && (!cover || f.score > cover.score || f.score === cover.score && f.id < cover.id)) cover = f;
      }
    }
    if (!cover) return null;
    const files = /* @__PURE__ */ new Set();
    for (const id2 of p.faces) {
      const f = this.state.faces.get(id2);
      if (f) files.add(f.file);
    }
    return {
      id: p.id,
      name: p.name,
      face_count: p.faces.size,
      photo_count: files.size,
      cover_face_id: cover.id,
      cover_file_id: cover.file,
      cover_box: { ...cover.box }
    };
  }
  visibleCards() {
    const out = [];
    for (const p of this.state.personas.values()) {
      const c = this.visible(p) ? this.card(p) : null;
      if (c) out.push(c);
    }
    return out;
  }
  /** The visible personas, named first; with q, the named ones whose name starts with it. */
  listPersonas(q) {
    const key = q === void 0 ? "" : nameKey(q.normalize("NFC").trim());
    return this.visibleCards().filter((c) => key === "" || c.name !== null && nameKey(c.name).startsWith(key)).sort((a, b) => {
      if (a.name !== null !== (b.name !== null)) return a.name !== null ? -1 : 1;
      const ka = a.name === null ? "" : nameKey(a.name);
      const kb = b.name === null ? "" : nameKey(b.name);
      if (ka !== kb) return ka < kb ? -1 : 1;
      return b.face_count - a.face_count || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    });
  }
  /** A persona's photos, newest sortAt first (ties: file id), one row per photo. */
  personaPhotos(pid, cursor, limit = PHOTOS_PAGE_DEFAULT) {
    const p = this.state.personas.get(pid);
    const card = p && this.visible(p) ? this.card(p) : null;
    if (!p || !card) throw new PersonasEngineError("not_found");
    const lim = Number.isFinite(limit) ? Math.min(PHOTOS_PAGE_MAX, Math.max(1, Math.floor(limit))) : PHOTOS_PAGE_DEFAULT;
    const byFile = /* @__PURE__ */ new Map();
    for (const id2 of p.faces) {
      const f = this.state.faces.get(id2);
      if (!f) continue;
      const cur = byFile.get(f.file);
      if (!cur || f.score > cur.score) byFile.set(f.file, f);
    }
    const rows = [...byFile.values()].sort((a, b) => b.sortAt - a.sortAt || (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
    let start = 0;
    if (cursor) {
      const i = cursor.indexOf("|");
      const s = Number(cursor.slice(0, i));
      const file = cursor.slice(i + 1);
      if (i < 0 || !Number.isFinite(s)) throw new PersonasEngineError("invalid");
      start = rows.findIndex((f) => f.sortAt < s || f.sortAt === s && f.file > file);
      if (start < 0) start = rows.length;
    }
    const page = rows.slice(start, start + lim);
    const last = page[page.length - 1];
    return {
      persona: card,
      files: page.map((f) => ({ file_id: f.file, face_id: f.id, box: { ...f.box } })),
      next: start + lim < rows.length ? `${last.sortAt}|${last.file}` : null
    };
  }
  /** The faces in one photo, in read order; persona fields only for a visible persona. */
  peopleInFile(fileId) {
    const out = [];
    for (const f of this.state.faces.values()) {
      if (f.file !== fileId) continue;
      const p = f.persona === null ? void 0 : this.state.personas.get(f.persona);
      const shown = p && this.visible(p) ? p : null;
      out.push({ persona_id: shown ? shown.id : null, name: shown ? shown.name : null, face_id: f.id, box: { ...f.box } });
    }
    return out;
  }
  /** Named visible personas whose name starts with prefix: exact match first, then most faces. */
  findByName(prefix, limit = FIND_DEFAULT) {
    const key = nameKey(typeof prefix === "string" ? prefix.normalize("NFC").trim() : "");
    const lim = Number.isFinite(limit) ? Math.min(FIND_MAX, Math.max(1, Math.floor(limit))) : FIND_DEFAULT;
    return this.visibleCards().filter((c) => c.name !== null && nameKey(c.name).startsWith(key)).sort((a, b) => {
      const ea = nameKey(a.name) === key;
      const eb = nameKey(b.name) === key;
      if (ea !== eb) return ea ? -1 : 1;
      if (a.face_count !== b.face_count) return b.face_count - a.face_count;
      const ka = nameKey(a.name);
      const kb = nameKey(b.name);
      return ka < kb ? -1 : ka > kb ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    }).slice(0, lim);
  }
  skippedFolders() {
    return [...this.state.skipped];
  }
  // ---- persona actions --------------------------------------------------
  persona(pid) {
    const p = this.state.personas.get(pid);
    if (!p) throw new PersonasEngineError("not_found");
    return p;
  }
  async rename(pid, name) {
    const trimmed = typeof name === "string" ? name.normalize("NFC").trim() : "";
    const len = [...trimmed].length;
    if (len < 1 || len > NAME_MAX || /\p{Cc}/u.test(trimmed)) throw new PersonasEngineError("name_invalid");
    await this.mutate(async () => {
      this.persona(pid);
      const key = nameKey(trimmed);
      const at = this.d.now();
      const recs = [];
      for (const other of this.state.personas.values()) {
        if (other.id === pid || other.name === null || nameKey(other.name) !== key) continue;
        if (other.faces.size > 0) throw new PersonasEngineError("name_taken");
        recs.push({ k: "merge", into: pid, from: other.id, at });
      }
      recs.push({ k: "name", persona: pid, name: trimmed, at });
      await this.commit(recs);
    });
  }
  async setCover(pid, faceId) {
    await this.mutate(async () => {
      if (!this.persona(pid).faces.has(faceId)) throw new PersonasEngineError("not_found");
      await this.commit([{ k: "cover", persona: pid, face: faceId, at: this.d.now() }]);
    });
  }
  /** If exactly one side is named it survives; otherwise `into` does. Returns the survivor. */
  async merge(into, from) {
    if (into === from) throw new PersonasEngineError("invalid");
    return this.mutate(async () => {
      const a = this.persona(into);
      const b = this.persona(from);
      const survivor = a.name !== null !== (b.name !== null) ? a.name !== null ? a : b : a;
      const loser = survivor === a ? b : a;
      await this.commit([{ k: "merge", into: survivor.id, from: loser.id, at: this.d.now() }]);
      return survivor.id;
    });
  }
  /** Remove person: the drop (which deletes the faces), then a tomb for each of its faces' positions. */
  async removePersona(pid) {
    await this.mutate(async () => {
      const p = this.persona(pid);
      const at = this.d.now();
      const recs = [{ k: "drop", persona: pid, at }];
      for (const id2 of p.faces) {
        const f = this.state.faces.get(id2);
        if (f) recs.push({ k: "tomb", file: f.file, box: { ...f.box }, at });
      }
      await this.commit(recs);
    });
  }
  async notThisPerson(faceId) {
    await this.mutate(async () => {
      const f = this.state.faces.get(faceId);
      if (!f || f.persona === null) throw new PersonasEngineError("not_found");
      await this.commit([{ k: "not", face: faceId, persona: f.persona, at: this.d.now() }]);
    });
  }
  /** Skipping a folder also takes its photos' faces out (gone); un-skipping lets them be read again. */
  async skipFolder(folderId, on) {
    if (typeof folderId !== "string" || folderId === "") throw new PersonasEngineError("invalid");
    await this.mutate(async () => {
      const at = this.d.now();
      const recs = [{ k: "skip", folder: folderId, on, at }];
      if (on) {
        const files = /* @__PURE__ */ new Set();
        for (const f of this.state.faces.values()) if (f.folder === folderId) files.add(f.file);
        for (const file of files) recs.push({ k: "gone", file, at });
      }
      await this.commit(recs);
    });
  }
};
export {
  JournalFullError,
  JournalGoneError,
  KeyExistsError,
  PersonasEngine,
  PersonasEngineError,
  PersonasFormatError,
  PersonasKeyError,
  ReaderUnsupportedError,
  b64ToBytes,
  bytesToB64,
  decodeBatch,
  decodeSig,
  encodeBatch,
  encodeSig,
  newPersonasKey,
  openBatch,
  openPersonasKey,
  openSnapshot,
  sealBatch,
  sealPersonasKey,
  sealSnapshot,
  sealedKeyFingerprint,
  workspaceKey
};
