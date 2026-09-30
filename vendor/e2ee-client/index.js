// src/api.ts
import { toB64, fromB64 } from "@dosya-dev/e2ee-core";
function createFetchApiClient(opts) {
  const { baseUrl, authHeaders, fetchFn = fetch } = opts;
  async function headers() {
    const auth = authHeaders ? await authHeaders() : {};
    return { "Content-Type": "application/json", ...auth };
  }
  return {
    async oprfPublicKey() {
      const res = await fetchFn(`${baseUrl}/api/e2ee/oprf-public-key`, { headers: await headers() });
      if (!res.ok) throw new Error(`e2ee: oprf-public-key request failed (${res.status})`);
      const body = await res.json();
      return fromB64(body.publicKey);
    },
    async oprfEvaluate(blinded) {
      const res = await fetchFn(`${baseUrl}/api/e2ee/oprf-evaluate`, {
        method: "POST",
        headers: await headers(),
        body: JSON.stringify({ blinded: toB64(blinded) })
      });
      if (!res.ok) throw new Error(`e2ee: oprf-evaluate request failed (${res.status})`);
      const body = await res.json();
      return fromB64(body.evaluated);
    },
    async getUserKeys() {
      const res = await fetchFn(`${baseUrl}/api/e2ee/user-keys`, { headers: await headers() });
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`e2ee: get-user-keys request failed (${res.status})`);
      return await res.json();
    },
    async putUserKeys(record) {
      const res = await fetchFn(`${baseUrl}/api/e2ee/user-keys`, {
        method: "PUT",
        headers: await headers(),
        body: JSON.stringify(record)
      });
      if (!res.ok) throw new Error(`e2ee: put-user-keys request failed (${res.status})`);
    },
    async lookupUserPubkey(email) {
      const res = await fetchFn(`${baseUrl}/api/e2ee/user-pubkey?email=${encodeURIComponent(email)}`, {
        headers: await headers()
      });
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`e2ee: lookup-user-pubkey request failed (${res.status})`);
      const body = await res.json();
      return { userId: body.userId, x25519Pub: body.x25519Pub, ed25519Pub: body.ed25519Pub };
    },
    async putWorkspaceGrant(workspaceId, wkVersion, sealed, granterEd25519Pub) {
      const res = await fetchFn(`${baseUrl}/api/e2ee/workspace-grant`, {
        method: "PUT",
        headers: await headers(),
        body: JSON.stringify({ workspaceId, wkVersion, sealed, granterEd25519Pub })
      });
      if (!res.ok) throw new Error(`e2ee: put-workspace-grant request failed (${res.status})`);
    },
    async getWorkspaceGrant(workspaceId) {
      const res = await fetchFn(`${baseUrl}/api/e2ee/workspace-grant/${encodeURIComponent(workspaceId)}`, {
        headers: await headers()
      });
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`e2ee: get-workspace-grant request failed (${res.status})`);
      const body = await res.json();
      return { wkVersion: body.wkVersion, sealed: body.sealed, granterEd25519Pub: body.granterEd25519Pub };
    },
    async getHead(workspaceId) {
      const res = await fetchFn(`${baseUrl}/api/e2ee/head/${encodeURIComponent(workspaceId)}`, {
        headers: await headers()
      });
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`e2ee: get-head request failed (${res.status})`);
      return await res.json();
    },
    async grantMember(workspaceId, granteeUserId, wkVersion, sealed, granterEd25519Pub, membershipEntry) {
      const res = await fetchFn(`${baseUrl}/api/e2ee/grant-member`, {
        method: "POST",
        headers: await headers(),
        body: JSON.stringify({ workspaceId, granteeUserId, wkVersion, sealed, granterEd25519Pub, membershipEntry })
      });
      if (!res.ok) throw new Error(`e2ee: grant-member request failed (${res.status})`);
    },
    async revokeMember(workspaceId, granteeUserId, membershipEntry) {
      const res = await fetchFn(`${baseUrl}/api/e2ee/revoke-member`, {
        method: "POST",
        headers: await headers(),
        body: JSON.stringify({ workspaceId, granteeUserId, membershipEntry })
      });
      if (!res.ok) throw new Error(`e2ee: revoke-member request failed (${res.status})`);
    },
    async listMembers(workspaceId) {
      const res = await fetchFn(`${baseUrl}/api/e2ee/members/${encodeURIComponent(workspaceId)}`, {
        headers: await headers()
      });
      if (!res.ok) throw new Error(`e2ee: list-members request failed (${res.status})`);
      const body = await res.json();
      return body.members;
    },
    async getMembershipLog(workspaceId) {
      const res = await fetchFn(`${baseUrl}/api/e2ee/membership-log/${encodeURIComponent(workspaceId)}`, {
        headers: await headers()
      });
      if (!res.ok) throw new Error(`e2ee: get-membership-log request failed (${res.status})`);
      const body = await res.json();
      return body.entries;
    },
    async listMyWorkspaces() {
      const res = await fetchFn(`${baseUrl}/api/e2ee/my-workspaces`, { headers: await headers() });
      if (!res.ok) throw new Error(`e2ee: list-my-workspaces request failed (${res.status})`);
      const body = await res.json();
      return body.workspaces;
    },
    async putWorkspaceScope(workspaceId, globalWorkspaceId) {
      const res = await fetchFn(`${baseUrl}/api/e2ee/workspace-scope`, {
        method: "PUT",
        headers: await headers(),
        body: JSON.stringify({ workspaceId, globalWorkspaceId })
      });
      if (!res.ok) throw new Error(`e2ee: put-workspace-scope request failed (${res.status})`);
    },
    async commit(body) {
      const res = await fetchFn(`${baseUrl}/api/e2ee/commit`, {
        method: "POST",
        headers: await headers(),
        body: JSON.stringify(body)
      });
      if (res.status === 409) {
        const conflictBody = await res.json();
        return { conflict: conflictBody };
      }
      if (!res.ok) throw new Error(`e2ee: commit request failed (${res.status})`);
      return await res.json();
    },
    async rotate(body) {
      const res = await fetchFn(`${baseUrl}/api/e2ee/rotate`, {
        method: "POST",
        headers: await headers(),
        body: JSON.stringify(body)
      });
      if (res.status === 409) {
        const conflictBody = await res.json();
        return { conflict: conflictBody };
      }
      if (!res.ok) throw new Error(`e2ee: rotate request failed (${res.status})`);
      return await res.json();
    },
    async chunkUploadUrl(workspaceId, chunkId, size) {
      const res = await fetchFn(`${baseUrl}/api/e2ee/chunk-upload-url`, {
        method: "POST",
        headers: await headers(),
        body: JSON.stringify({ workspaceId, chunkId, size })
      });
      if (!res.ok) throw new Error(`e2ee: chunk-upload-url request failed (${res.status})`);
      const body = await res.json();
      return body.url;
    },
    async chunkDownloadUrl(workspaceId, chunkId) {
      const qs = new URLSearchParams({ workspaceId, chunkId }).toString();
      const res = await fetchFn(`${baseUrl}/api/e2ee/chunk-download-url?${qs}`, { headers: await headers() });
      if (!res.ok) throw new Error(`e2ee: chunk-download-url request failed (${res.status})`);
      const body = await res.json();
      return body.url;
    }
  };
}

// src/session.ts
import {
  oprfBlind,
  deriveKEK,
  generateIdentityBundle,
  wrapIdentityBundle,
  unwrapIdentityBundle,
  generateRecoveryKey,
  wrapIdentityBundleForRecovery,
  unwrapIdentityBundleForRecovery,
  randomBytes,
  utf8,
  toHex,
  fromHex,
  toB64 as toB642,
  fromB64 as fromB642
} from "@dosya-dev/e2ee-core";
var FMT = 1;
var IDENTITY_AD_USER_ID = "self";
var ARGON_TIER = "interactive";
async function hardenPassphrase(api, passphrase) {
  const publicKey = await api.oprfPublicKey();
  const { blindedElement, finalize } = await oprfBlind(utf8(passphrase), publicKey);
  const evaluated = await api.oprfEvaluate(blindedElement);
  return finalize(evaluated);
}
function isArgonTier(v) {
  return v === "interactive" || v === "moderate" || v === "sensitive";
}
function parseArgonTier(argonParams) {
  try {
    const parsed = JSON.parse(argonParams);
    if (isArgonTier(parsed.tier)) return parsed.tier;
  } catch {
  }
  return ARGON_TIER;
}
async function setupIdentity(api, passphrase) {
  const salt = await randomBytes(16);
  const hardened = await hardenPassphrase(api, passphrase);
  const kek = await deriveKEK(hardened, salt, ARGON_TIER);
  const identity = await generateIdentityBundle();
  const recoveryKey = await generateRecoveryKey();
  const wrappedPriv = await wrapIdentityBundle(identity, kek, FMT, IDENTITY_AD_USER_ID);
  const recoveryWrapped = await wrapIdentityBundleForRecovery(
    identity,
    recoveryKey,
    salt,
    FMT,
    IDENTITY_AD_USER_ID
  );
  const record = {
    x25519Pub: toHex(identity.x25519.publicKey),
    ed25519Pub: toHex(identity.ed25519.publicKey),
    wrappedPriv: toB642(wrappedPriv),
    recoveryWrapped: toB642(recoveryWrapped),
    argonSalt: toB642(salt),
    argonParams: JSON.stringify({ tier: ARGON_TIER })
  };
  await api.putUserKeys(record);
  return { session: { kek, identity }, recoveryKey };
}
async function unlock(api, passphrase) {
  const record = await api.getUserKeys();
  if (!record) throw new Error("e2ee: unlock failed");
  const salt = fromB642(record.argonSalt);
  const tier = parseArgonTier(record.argonParams);
  const hardened = await hardenPassphrase(api, passphrase);
  const kek = await deriveKEK(hardened, salt, tier);
  try {
    const identity = await unwrapIdentityBundle(fromB642(record.wrappedPriv), kek, FMT, IDENTITY_AD_USER_ID);
    return { kek, identity };
  } catch {
    throw new Error("e2ee: unlock failed");
  }
}
function parseRecoveryKey(input) {
  const cleaned = input.replace(/[\s-]/g, "").toLowerCase();
  if (cleaned.length === 0 || cleaned.length % 2 !== 0 || /[^0-9a-f]/.test(cleaned)) {
    throw new Error("e2ee: unlock failed");
  }
  return fromHex(cleaned);
}
async function unlockWithRecoveryKey(api, recoveryKey) {
  const record = await api.getUserKeys();
  if (!record || !record.recoveryWrapped) throw new Error("e2ee: unlock failed");
  let keyBytes;
  try {
    keyBytes = parseRecoveryKey(recoveryKey);
  } catch {
    throw new Error("e2ee: unlock failed");
  }
  const salt = fromB642(record.argonSalt);
  try {
    const identity = await unwrapIdentityBundleForRecovery(
      fromB642(record.recoveryWrapped),
      keyBytes,
      salt,
      FMT,
      IDENTITY_AD_USER_ID
    );
    const kek = await deriveKEK(keyBytes, salt, ARGON_TIER);
    return { kek, identity };
  } catch {
    throw new Error("e2ee: unlock failed");
  }
}

// src/workspace.ts
import {
  generateWorkspaceKey,
  encryptFolderIndex,
  decryptFolderIndex,
  signRootManifest,
  verifyRootManifest,
  rootManifestHash,
  applyOps,
  squashOps,
  rebase,
  merkleRoot,
  checkFreshness,
  sha256,
  utf8 as utf82,
  fromUtf8,
  toHex as toHex2,
  fromHex as fromHex2,
  toB64 as toB645,
  fromB64 as fromB645,
  sealGrant,
  openGrant,
  genesisEntry,
  appendEntry,
  replayLog,
  wrapDek,
  unwrapDek,
  encryptFileManifest,
  decryptFileManifest
} from "@dosya-dev/e2ee-core";

// src/grant-codec.ts
import { toB64 as toB643, fromB64 as fromB643 } from "@dosya-dev/e2ee-core";
function serializeGrant(g) {
  return JSON.stringify({
    enc: toB643(g.sealed.enc),
    ct: toB643(g.sealed.ciphertext),
    sig: toB643(g.granterSig)
  });
}
function deserializeGrant(s) {
  const o = JSON.parse(s);
  return { sealed: { enc: fromB643(o.enc), ciphertext: fromB643(o.ct) }, granterSig: fromB643(o.sig) };
}

// src/membership-codec.ts
import { toB64 as toB644, fromB64 as fromB644 } from "@dosya-dev/e2ee-core";
function serializeSignedEntry(e) {
  const wire = {
    fmt: e.entry.fmt,
    workspaceId: e.entry.workspaceId,
    seq: e.entry.seq,
    prevHash: toB644(e.entry.prevHash),
    op: e.entry.op,
    subjectId: e.entry.subjectId,
    subjectPubkey: toB644(e.entry.subjectPubkey),
    actorId: e.entry.actorId,
    actorSig: toB644(e.actorSig)
  };
  return JSON.stringify(wire);
}
function deserializeSignedEntry(s) {
  const wire = JSON.parse(s);
  const entry = {
    fmt: wire.fmt,
    workspaceId: wire.workspaceId,
    seq: wire.seq,
    prevHash: fromB644(wire.prevHash),
    op: wire.op,
    subjectId: wire.subjectId,
    subjectPubkey: fromB644(wire.subjectPubkey),
    actorId: wire.actorId
  };
  return { entry, actorSig: fromB644(wire.actorSig) };
}

// src/workspace.ts
var FMT2 = 1;
var WK_VERSION = 1;
var MIN_CLIENT_VERSION = 1;
var ROOT_FOLDER_ID = "root";
var GENESIS_PREV_ROOT_HASH = new Uint8Array(32);
var MAX_REBASE_ATTEMPTS = 10;
async function personalMembershipHeadHash(session) {
  return sha256(utf82(`personal:${toHex2(session.identity.ed25519.publicKey)}`));
}
var MAX_SPACE_NAME_LENGTH = 100;
var INVISIBLE_NAME_CHARS = /[\u0000-\u001F\u007F-\u009F\u00AD\u061C\u180E\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u206F\uFEFF\uFFF9-\uFFFB]/g;
function normaliseSpaceName(raw) {
  const cleaned = raw.normalize("NFC").replace(INVISIBLE_NAME_CHARS, "").replace(/\s+/g, " ").trim();
  if (cleaned.length === 0) return null;
  return Array.from(cleaned).slice(0, MAX_SPACE_NAME_LENGTH).join("");
}
function serializeFolderIndex(state, name) {
  const entries = Array.from(state.values()).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  if (name === null) return utf82(JSON.stringify(entries));
  return utf82(JSON.stringify({ v: 2, name, entries }));
}
function stateFromEntries(entries) {
  const state = /* @__PURE__ */ new Map();
  for (const entry of entries) state.set(entry.id, entry);
  return state;
}
function deserializeFolderIndex(bytes) {
  const parsed = JSON.parse(fromUtf8(bytes));
  if (Array.isArray(parsed)) return { state: stateFromEntries(parsed), name: null };
  if (isV2Index(parsed)) {
    return { state: stateFromEntries(parsed.entries), name: normaliseSpaceName(parsed.name) };
  }
  throw new Error("e2ee: folder index: unrecognised plaintext shape");
}
function isV2Index(v) {
  if (typeof v !== "object" || v === null) return false;
  const o = v;
  return o.v === 2 && typeof o.name === "string" && Array.isArray(o.entries);
}
function encodeSignedRoot(fields, sig) {
  const wire = {
    fmt: fields.fmt,
    workspaceId: fields.workspaceId,
    manifestVersion: fields.manifestVersion,
    prevRootHash: toHex2(fields.prevRootHash),
    folderMerkleRoot: toHex2(fields.folderMerkleRoot),
    membershipHeadHash: toHex2(fields.membershipHeadHash),
    minClientVersion: fields.minClientVersion,
    sig: toHex2(sig)
  };
  return JSON.stringify(wire);
}
function decodeSignedRoot(signedRoot) {
  const wire = JSON.parse(signedRoot);
  return {
    fields: {
      fmt: wire.fmt,
      workspaceId: wire.workspaceId,
      manifestVersion: wire.manifestVersion,
      prevRootHash: fromHex2(wire.prevRootHash),
      folderMerkleRoot: fromHex2(wire.folderMerkleRoot),
      membershipHeadHash: fromHex2(wire.membershipHeadHash),
      minClientVersion: wire.minClientVersion
    },
    sig: fromHex2(wire.sig)
  };
}
async function folderMerkleRootOf(folderIndexes) {
  const sorted = [...folderIndexes].sort((a, b) => a.folderId < b.folderId ? -1 : a.folderId > b.folderId ? 1 : 0);
  const leaves = await Promise.all(sorted.map((f) => sha256(f.ciphertext)));
  return merkleRoot(leaves);
}
async function getVerifiedHead(api, session, ws) {
  const head = await api.getHead(ws.workspaceId);
  if (!head) return null;
  const { fields, sig } = decodeSignedRoot(head.signedRoot);
  const rawLog = await api.getMembershipLog(ws.workspaceId);
  const entries = rawLog.map((e) => deserializeSignedEntry(e.entryBlob));
  const selfPub = session.identity.ed25519.publicKey;
  const selfId = toHex2(selfPub);
  const anchor = ws.selfFounded ? { id: selfId, pubkey: selfPub } : void 0;
  const { members } = await replayLog(entries, anchor);
  let ok = false;
  for (const pubHex of members.values()) {
    if (await verifyRootManifest(fields, sig, fromHex2(pubHex))) {
      ok = true;
      break;
    }
  }
  if (!ok) throw new Error("e2ee: root not signed by any current member");
  const hash = await rootManifestHash(fields);
  const freshness = checkFreshness(ws.lastSeen ?? null, {
    version: head.version,
    hash,
    prevHash: fields.prevRootHash
  });
  if (freshness === "rollback") throw new Error("e2ee: workspace rollback detected");
  if (freshness === "fork") throw new Error("e2ee: workspace fork detected");
  ws.lastSeen = { version: head.version, hash };
  return { head, fields };
}
async function folderIndexFromHead(verified, folderId, ws) {
  if (!verified) return { state: /* @__PURE__ */ new Map(), name: null };
  const ref = verified.head.folderIndexes.find((f) => f.folderId === folderId);
  if (!ref) return { state: /* @__PURE__ */ new Map(), name: null };
  const plaintext = await decryptFolderIndex(
    fromB645(ref.ciphertext),
    ws.wk,
    FMT2,
    ws.workspaceId,
    folderId,
    ref.indexVersion,
    ws.wkVersion
  );
  return deserializeFolderIndex(plaintext);
}
async function createWorkspace(api, session, workspaceId, opts) {
  const wk = await generateWorkspaceKey();
  const indexVersion = 1;
  const plaintext = serializeFolderIndex(/* @__PURE__ */ new Map(), opts?.name === void 0 ? null : normaliseSpaceName(opts.name));
  const ciphertext = await encryptFolderIndex(plaintext, wk, FMT2, workspaceId, ROOT_FOLDER_ID, indexVersion, WK_VERSION);
  const folderMerkleRoot = await folderMerkleRootOf([{ folderId: ROOT_FOLDER_ID, ciphertext }]);
  const founderPubkey = session.identity.ed25519.publicKey;
  const founderId = toHex2(founderPubkey);
  const genesis = await genesisEntry({
    fmt: FMT2,
    workspaceId,
    founderId,
    founderPubkey,
    founderSignKey: session.identity.ed25519.privateKey
  });
  const genesisBlob = serializeSignedEntry(genesis);
  const { headHash: membershipHeadHash } = await replayLog([genesis]);
  const fields = {
    fmt: FMT2,
    workspaceId,
    manifestVersion: 1,
    prevRootHash: GENESIS_PREV_ROOT_HASH,
    folderMerkleRoot,
    membershipHeadHash,
    minClientVersion: MIN_CLIENT_VERSION
  };
  const sig = await signRootManifest(fields, session.identity.ed25519.privateKey);
  const signedRoot = encodeSignedRoot(fields, sig);
  const rootHashBytes = await rootManifestHash(fields);
  const rootHash = toHex2(rootHashBytes);
  const result = await api.commit({
    workspaceId,
    expectedPrev: null,
    signedRoot,
    rootHash,
    changedFolderIndexes: [{ folderId: ROOT_FOLDER_ID, indexVersion, ciphertext: toB645(ciphertext) }],
    fileManifests: [],
    addedChunkRefs: [],
    removedChunkRefs: [],
    membershipEntries: [{ seq: 0, entryBlob: genesisBlob }]
  });
  if ("conflict" in result) {
    throw new Error(
      `e2ee: createWorkspace: workspace "${workspaceId}" already exists (head at version ${result.conflict.currentVersion})`
    );
  }
  const selfId = toHex2(session.identity.ed25519.publicKey);
  const grant = await sealGrant({
    wk,
    fmt: FMT2,
    workspaceId,
    wkVersion: WK_VERSION,
    granteeId: selfId,
    granteePubkey: session.identity.x25519.publicKey,
    granterId: selfId,
    granterSignKey: session.identity.ed25519.privateKey
  });
  await api.putWorkspaceGrant(workspaceId, WK_VERSION, serializeGrant(grant), selfId);
  return { workspaceId, wk, wkVersion: WK_VERSION, selfFounded: true, lastSeen: { version: 1, hash: rootHashBytes } };
}
async function openWorkspace(api, session, workspaceId, opts) {
  const stored = await api.getWorkspaceGrant(workspaceId);
  if (!stored) throw new Error("e2ee: openWorkspace: no stored key for this workspace");
  const { wk, wkVersion } = await deriveWkFromStoredGrant(session, workspaceId, stored);
  const ws = { workspaceId, wk, wkVersion, selfFounded: opts?.selfFounded ?? false };
  await getVerifiedHead(api, session, ws);
  return ws;
}
async function deriveWkFromStoredGrant(session, workspaceId, stored) {
  const selfPubHex = toHex2(session.identity.ed25519.publicKey);
  const granterEd25519Pub = stored.granterEd25519Pub ? fromHex2(stored.granterEd25519Pub) : session.identity.ed25519.publicKey;
  const granterId = toHex2(granterEd25519Pub);
  const wk = await openGrant({
    grant: deserializeGrant(stored.sealed),
    fmt: FMT2,
    workspaceId,
    wkVersion: stored.wkVersion,
    granteeId: selfPubHex,
    granteePubkey: session.identity.x25519.publicKey,
    granterId,
    granterSignPubkey: granterEd25519Pub,
    recipientPrivkey: session.identity.x25519.privateKey
  });
  return { wk, wkVersion: stored.wkVersion };
}
async function grantAccess(api, session, ws, granteeEmail) {
  const dir = await api.lookupUserPubkey(granteeEmail);
  if (!dir) throw new Error("e2ee: grantAccess: that user has no E2EE identity");
  const granterId = toHex2(session.identity.ed25519.publicKey);
  const grant = await sealGrant({
    wk: ws.wk,
    fmt: FMT2,
    workspaceId: ws.workspaceId,
    wkVersion: ws.wkVersion,
    granteeId: dir.ed25519Pub,
    granteePubkey: fromHex2(dir.x25519Pub),
    granterId,
    granterSignKey: session.identity.ed25519.privateKey
  });
  const rawLog = await api.getMembershipLog(ws.workspaceId);
  const prev = deserializeSignedEntry(rawLog[rawLog.length - 1].entryBlob);
  const appended = await appendEntry({
    prev,
    op: "add",
    subjectId: dir.ed25519Pub,
    subjectPubkey: fromHex2(dir.ed25519Pub),
    actorId: granterId,
    actorSignKey: session.identity.ed25519.privateKey
  });
  const entryBlob = serializeSignedEntry(appended);
  await api.grantMember(ws.workspaceId, dir.userId, ws.wkVersion, serializeGrant(grant), granterId, {
    seq: prev.entry.seq + 1,
    entryBlob
  });
}
var MAX_ROTATION_ATTEMPTS = 10;
async function revokeAccess(api, session, ws, removed) {
  const selfEd25519Pub = toHex2(session.identity.ed25519.publicKey);
  const callerRoster = await listMembers(api, ws);
  const callerMember = callerRoster.find((m) => m.ed25519Pub === selfEd25519Pub);
  if (!callerMember) {
    throw new Error(
      `e2ee: revokeAccess: caller's own identity was not found in workspace "${ws.workspaceId}"'s member list`
    );
  }
  if (callerMember.userId === removed.userId) {
    throw new Error("e2ee: cannot revoke yourself; use leave-workspace");
  }
  for (let attempt = 1; ; attempt++) {
    if (attempt > MAX_ROTATION_ATTEMPTS) {
      throw new Error(
        `e2ee: revokeAccess: gave up after ${MAX_ROTATION_ATTEMPTS} rotation attempts on workspace "${ws.workspaceId}" -- a concurrent writer keeps winning the rotate CAS`
      );
    }
    const members = await listMembers(api, ws);
    if (!members.some((m) => m.userId === removed.userId)) {
      return;
    }
    const remaining = members.filter((m) => m.userId !== removed.userId);
    if (remaining.length === 0) {
      throw new Error("e2ee: cannot remove the last member of a workspace");
    }
    const selfMember = members.find((m) => m.ed25519Pub === selfEd25519Pub);
    const payload = await computeRotation(api, session, ws, { remaining, removed });
    const res = await api.rotate({ workspaceId: ws.workspaceId, ...payload });
    if ("conflict" in res) {
      const stored = await api.getWorkspaceGrant(ws.workspaceId);
      if (!stored) {
        throw new Error(
          `e2ee: revokeAccess: lost this identity's own grant for workspace "${ws.workspaceId}" while retrying a rotation (a concurrent rotation may have removed the caller itself) -- re-open the workspace`
        );
      }
      const { wk, wkVersion } = await deriveWkFromStoredGrant(session, ws.workspaceId, stored);
      ws.wk = wk;
      ws.wkVersion = wkVersion;
      await getVerifiedHead(api, session, ws);
      continue;
    }
    const selfGrant = selfMember ? payload.grants.find((g) => g.memberUserId === selfMember.userId) : void 0;
    if (!selfGrant) {
      throw new Error(
        "e2ee: revokeAccess: rotation succeeded but no self-grant was sealed -- caller not in 'remaining'"
      );
    }
    const wk2 = await openGrant({
      grant: deserializeGrant(selfGrant.sealed),
      fmt: FMT2,
      workspaceId: ws.workspaceId,
      wkVersion: payload.newWkVersion,
      granteeId: selfEd25519Pub,
      granteePubkey: session.identity.x25519.publicKey,
      granterId: selfGrant.granterEd25519Pub,
      granterSignPubkey: fromHex2(selfGrant.granterEd25519Pub),
      recipientPrivkey: session.identity.x25519.privateKey
    });
    ws.wk = wk2;
    ws.wkVersion = payload.newWkVersion;
    ws.lastSeen = { version: res.version, hash: fromHex2(payload.rootHash) };
    return;
  }
}
async function listMembers(api, ws) {
  return api.listMembers(ws.workspaceId);
}
async function computeRotation(api, session, ws, args) {
  const wk2 = await generateWorkspaceKey();
  const newWkVersion = ws.wkVersion + 1;
  const selfId = toHex2(session.identity.ed25519.publicKey);
  const verified = await getVerifiedHead(api, session, ws);
  if (!verified) {
    throw new Error("e2ee: computeRotation: workspace has no head yet");
  }
  const { head } = verified;
  const changedFolderIndexes = [];
  const fileManifests = [];
  const newFolderCiphertexts = [];
  for (const ref of head.folderIndexes) {
    const folderId = ref.folderId;
    const plaintext = await decryptFolderIndex(
      fromB645(ref.ciphertext),
      ws.wk,
      FMT2,
      ws.workspaceId,
      folderId,
      ref.indexVersion,
      ws.wkVersion
    );
    const { state, name } = deserializeFolderIndex(plaintext);
    for (const entry of state.values()) {
      if (entry.kind !== "file") continue;
      const rawRecord = entry.meta.record;
      if (typeof rawRecord !== "string") {
        throw new Error(`e2ee: computeRotation: file "${entry.id}" has no file record (entry.meta.record missing)`);
      }
      const record = JSON.parse(rawRecord);
      const manifest = await decryptFileManifest(
        fromB645(record.manifestCiphertext),
        ws.wk,
        FMT2,
        ws.workspaceId,
        record.fileId,
        record.version,
        folderId,
        ws.wkVersion
      );
      const dek = await unwrapDek(fromB645(record.wrappedDek), ws.wk, FMT2, ws.workspaceId, ws.wkVersion);
      const newManifestCiphertext = await encryptFileManifest(
        manifest,
        wk2,
        FMT2,
        ws.workspaceId,
        record.fileId,
        record.version,
        folderId,
        newWkVersion
      );
      const newWrappedDek = await wrapDek(dek, wk2, FMT2, ws.workspaceId, newWkVersion);
      const newRecord = {
        manifestCiphertext: toB645(newManifestCiphertext),
        wrappedDek: toB645(newWrappedDek),
        version: record.version,
        fileId: record.fileId
      };
      entry.meta = { ...entry.meta, record: JSON.stringify(newRecord) };
      fileManifests.push({
        fileId: record.fileId,
        version: record.version,
        ciphertext: toB645(newManifestCiphertext)
      });
    }
    const newIndexVersion = ref.indexVersion + 1;
    const newCiphertext = await encryptFolderIndex(
      // `name` round-trips: a rotation re-encrypts every index under the new
      // key and must not quietly drop the Space's name on the way through.
      serializeFolderIndex(state, name),
      wk2,
      FMT2,
      ws.workspaceId,
      folderId,
      newIndexVersion,
      newWkVersion
    );
    changedFolderIndexes.push({ folderId, indexVersion: newIndexVersion, ciphertext: toB645(newCiphertext) });
    newFolderCiphertexts.push({ folderId, ciphertext: newCiphertext });
  }
  const folderMerkleRoot = await folderMerkleRootOf(newFolderCiphertexts);
  const rawLog = await api.getMembershipLog(ws.workspaceId);
  const existingEntries = rawLog.map((e) => deserializeSignedEntry(e.entryBlob));
  const prevEntry = existingEntries[existingEntries.length - 1];
  if (!prevEntry) {
    throw new Error("e2ee: computeRotation: workspace has no membership log yet");
  }
  const removeEntry = await appendEntry({
    prev: prevEntry,
    op: "remove",
    subjectId: args.removed.ed25519Pub,
    subjectPubkey: fromHex2(args.removed.ed25519Pub),
    actorId: selfId,
    actorSignKey: session.identity.ed25519.privateKey
  });
  const { headHash: membershipHeadHash } = await replayLog([...existingEntries, removeEntry]);
  const fields = {
    fmt: FMT2,
    workspaceId: ws.workspaceId,
    manifestVersion: head.version + 1,
    prevRootHash: fromHex2(head.rootHash),
    folderMerkleRoot,
    membershipHeadHash,
    minClientVersion: MIN_CLIENT_VERSION
  };
  const sig = await signRootManifest(fields, session.identity.ed25519.privateKey);
  const signedRoot = encodeSignedRoot(fields, sig);
  const rootHash = toHex2(await rootManifestHash(fields));
  const grants = [];
  for (const m of args.remaining) {
    const grant = await sealGrant({
      wk: wk2,
      fmt: FMT2,
      workspaceId: ws.workspaceId,
      wkVersion: newWkVersion,
      granteeId: m.ed25519Pub,
      granteePubkey: fromHex2(m.x25519Pub),
      granterId: selfId,
      granterSignKey: session.identity.ed25519.privateKey
    });
    grants.push({
      memberUserId: m.userId,
      wkVersion: newWkVersion,
      sealed: serializeGrant(grant),
      granterEd25519Pub: selfId
    });
  }
  return {
    newWkVersion,
    signedRoot,
    rootHash,
    changedFolderIndexes,
    fileManifests,
    grants,
    membershipEntry: { seq: removeEntry.entry.seq, entryBlob: serializeSignedEntry(removeEntry) },
    removedUserId: args.removed.userId,
    expectedPrev: head.version
  };
}
async function listFolder(api, session, ws, folderId) {
  return (await listFolderAt(api, session, ws, folderId)).state;
}
async function listFolderAt(api, session, ws, folderId) {
  const verified = await getVerifiedHead(api, session, ws);
  const { state, name } = await folderIndexFromHead(verified, folderId, ws);
  return { state, headVersion: verified?.head.version ?? null, spaceName: name };
}
async function readWorkspaceName(api, session, ws) {
  const verified = await getVerifiedHead(api, session, ws);
  return (await folderIndexFromHead(verified, ROOT_FOLDER_ID, ws)).name;
}
async function renameWorkspace(api, session, ws, name) {
  await commitFolderOps(api, session, ws, ROOT_FOLDER_ID, [], void 0, { spaceName: name });
}
function makeConflictId() {
  return `conflict-${crypto.randomUUID()}`;
}
function resolveChunkRefDeltas(localOps, remote, merged, conflicts, chunkRefDeltas) {
  const localById = /* @__PURE__ */ new Map();
  const localDelIds = /* @__PURE__ */ new Set();
  for (const op of localOps) {
    if (op.type === "put") localById.set(op.entry.id, op.entry);
    else localDelIds.add(op.id);
  }
  const conflictedCopyIds = new Set(conflicts.filter((c) => c.kind === "conflicted-copy").map((c) => c.id));
  const added = [];
  const removed = [];
  for (const delta of chunkRefDeltas) {
    const local = localById.get(delta.entryId);
    if (local && merged.get(delta.entryId) === local) {
      added.push(...delta.added);
      removed.push(...delta.removed);
    } else if (conflictedCopyIds.has(delta.entryId)) {
      added.push(...delta.added);
    } else if (localDelIds.has(delta.entryId) && remote.has(delta.entryId) && !merged.has(delta.entryId)) {
      added.push(...delta.added);
      removed.push(...delta.removed);
    }
  }
  return { added, removed };
}
var WorkspaceRekeyedError = class extends Error {
  newWkVersion;
  constructor(newWkVersion) {
    super(
      `e2ee: commitFolderOps: the workspace key was rotated to wkVersion ${newWkVersion} while this commit was pending -- the caller's file-layer ciphertext (manifest/DEK wrap) was sealed under the old key and must be re-sealed under the new one before retrying (ws.wk/ws.wkVersion have already been updated in place)`
    );
    this.name = "WorkspaceRekeyedError";
    this.newWkVersion = newWkVersion;
  }
};
async function commitFolderOps(api, session, ws, folderId, localOps, fileExtras, opts) {
  const squashed = squashOps(localOps);
  const renaming = opts !== void 0 && opts.spaceName !== void 0;
  if (squashed.length === 0 && !renaming) return;
  if (renaming && folderId !== ROOT_FOLDER_ID) {
    throw new Error(
      `e2ee: commitFolderOps: a Space name lives in the root index, not folder "${folderId}"`
    );
  }
  const renameTo = renaming ? opts.spaceName === null ? null : normaliseSpaceName(opts.spaceName) : null;
  const startWkVersion = ws.wkVersion;
  const firstHead = await getVerifiedHead(api, session, ws);
  const { state: remoteAtStart, name: remoteName } = await folderIndexFromHead(firstHead, folderId, ws);
  let inheritedName = remoteName;
  const base = fileExtras?.base?.state ?? remoteAtStart;
  const movedOn = fileExtras?.base !== void 0 && (firstHead?.head.version ?? null) !== fileExtras.base.headVersion;
  let merged;
  let conflicts;
  let currentRemote;
  if (movedOn) {
    ({ merged, conflicts } = rebase({ base, remote: remoteAtStart, localOps: squashed, makeConflictId }));
    currentRemote = remoteAtStart;
  } else {
    merged = applyOps(base, squashed);
    conflicts = [];
    currentRemote = base;
  }
  let priorHead = firstHead;
  for (let attempt = 1; ; attempt++) {
    if (attempt > MAX_REBASE_ATTEMPTS) {
      throw new Error(
        `e2ee: commitFolderOps: gave up after ${MAX_REBASE_ATTEMPTS} rebase attempts on folder "${folderId}" (workspace "${ws.workspaceId}")`
      );
    }
    const priorFolderIndexes = priorHead?.head.folderIndexes ?? [];
    const currentVersion = priorHead?.head.version ?? null;
    const prevRootHash = priorHead ? fromHex2(priorHead.head.rootHash) : GENESIS_PREV_ROOT_HASH;
    const priorOwnIndexVersion = priorFolderIndexes.find((f) => f.folderId === folderId)?.indexVersion ?? 0;
    const newIndexVersion = priorOwnIndexVersion + 1;
    const plaintext = serializeFolderIndex(merged, renaming ? renameTo : inheritedName);
    const ciphertext = await encryptFolderIndex(
      plaintext,
      ws.wk,
      FMT2,
      ws.workspaceId,
      folderId,
      newIndexVersion,
      ws.wkVersion
    );
    const otherFolders = priorFolderIndexes.filter((f) => f.folderId !== folderId).map((f) => ({ folderId: f.folderId, ciphertext: fromB645(f.ciphertext) }));
    const folderMerkleRoot = await folderMerkleRootOf([...otherFolders, { folderId, ciphertext }]);
    const membershipHeadHash = await personalMembershipHeadHash(session);
    const fields = {
      fmt: FMT2,
      workspaceId: ws.workspaceId,
      manifestVersion: (currentVersion ?? 0) + 1,
      prevRootHash,
      folderMerkleRoot,
      membershipHeadHash,
      minClientVersion: MIN_CLIENT_VERSION
    };
    const sig = await signRootManifest(fields, session.identity.ed25519.privateKey);
    const signedRoot = encodeSignedRoot(fields, sig);
    const rootHashBytes = await rootManifestHash(fields);
    const rootHash = toHex2(rootHashBytes);
    const { added: addedChunkRefs, removed: removedChunkRefs } = resolveChunkRefDeltas(
      squashed,
      currentRemote,
      merged,
      conflicts,
      fileExtras?.chunkRefDeltas ?? []
    );
    const result = await api.commit({
      workspaceId: ws.workspaceId,
      expectedPrev: currentVersion,
      signedRoot,
      rootHash,
      changedFolderIndexes: [{ folderId, indexVersion: newIndexVersion, ciphertext: toB645(ciphertext) }],
      fileManifests: fileExtras?.fileManifests ?? [],
      addedChunkRefs,
      removedChunkRefs
    });
    if (!("conflict" in result)) {
      ws.lastSeen = { version: fields.manifestVersion, hash: rootHashBytes };
      return;
    }
    const stored = await api.getWorkspaceGrant(ws.workspaceId);
    if (!stored) {
      throw new Error(
        `e2ee: commitFolderOps: lost this identity's own grant for workspace "${ws.workspaceId}" while retrying a commit (a concurrent rotation may have removed the caller itself) -- re-open the workspace`
      );
    }
    const { wk, wkVersion } = await deriveWkFromStoredGrant(session, ws.workspaceId, stored);
    ws.wk = wk;
    ws.wkVersion = wkVersion;
    if (wkVersion !== startWkVersion) {
      const hasFileRecord = squashed.some(
        (op) => op.type === "put" && typeof op.entry.meta.record === "string"
      );
      const hasFileManifests = (fileExtras?.fileManifests?.length ?? 0) > 0;
      if (hasFileRecord || hasFileManifests) {
        throw new WorkspaceRekeyedError(wkVersion);
      }
    }
    const retryHead = await getVerifiedHead(api, session, ws);
    const { state: remoteState, name: retryName } = await folderIndexFromHead(retryHead, folderId, ws);
    inheritedName = retryName;
    const { merged: remerged, conflicts: remergedConflicts } = rebase({
      base,
      remote: remoteState,
      localOps: squashed,
      makeConflictId
    });
    merged = remerged;
    conflicts = remergedConflicts;
    currentRemote = remoteState;
    priorHead = retryHead;
  }
}

// src/transport.ts
function createFetchChunkTransport(fetchFn = fetch) {
  return {
    async putChunk(url, bytes) {
      const res = await fetchFn(url, { method: "PUT", body: bytes });
      if (!res.ok) throw new Error(`e2ee: chunk upload failed (${res.status})`);
    },
    async getChunk(url) {
      const res = await fetchFn(url);
      if (!res.ok) throw new Error(`e2ee: chunk download failed (${res.status})`);
      return new Uint8Array(await res.arrayBuffer());
    }
  };
}
function objectKeyFor(url) {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}
function createInMemoryChunkTransport() {
  const store = /* @__PURE__ */ new Map();
  return {
    store,
    async putChunk(url, bytes) {
      store.set(objectKeyFor(url), bytes);
    },
    async getChunk(url) {
      const found = store.get(objectKeyFor(url));
      if (!found) throw new Error(`e2ee: in-memory transport has no chunk stored for url "${url}"`);
      return found;
    }
  };
}

// src/file.ts
import {
  generateDek,
  wrapDek as wrapDek2,
  unwrapDek as unwrapDek2,
  encryptFileStreaming,
  decryptFileStreaming,
  computeDelta,
  encryptFileManifest as encryptFileManifest2,
  decryptFileManifest as decryptFileManifest2,
  chunkBoundaries,
  toHex as toHex3,
  fromB64 as fromB646,
  toB64 as toB646,
  concat
} from "@dosya-dev/e2ee-core";
var FMT3 = 1;
var WRITER_ID = "self";
var MAX_RESEAL_ATTEMPTS = 5;
function encodeFileRecord(rec) {
  return JSON.stringify(rec);
}
function decodeFileRecord(entry) {
  const raw = entry.meta.record;
  if (typeof raw !== "string") {
    throw new Error(`e2ee: file "${entry.id}" has no file record (entry.meta.record missing)`);
  }
  return JSON.parse(raw);
}
async function uploadFileStreaming(deps, folderId, name, source) {
  const { api, transport, session, ws } = deps;
  const fileId = crypto.randomUUID();
  const { dek, dekId } = await generateDek();
  const uploadedChunkIds = [];
  const { manifest } = await encryptFileStreaming({
    dek,
    dekId,
    fmt: FMT3,
    workspaceId: ws.workspaceId,
    fileId,
    version: 1,
    source,
    sink: async (chunk) => {
      const url = await api.chunkUploadUrl(ws.workspaceId, toHex3(chunk.chunkId), chunk.ciphertext.length);
      await transport.putChunk(url, chunk.ciphertext);
      uploadedChunkIds.push(toHex3(chunk.chunkId));
    }
  });
  for (let attempt = 1; ; attempt++) {
    const manifestCiphertext = await encryptFileManifest2(
      manifest,
      ws.wk,
      FMT3,
      ws.workspaceId,
      fileId,
      manifest.version,
      folderId,
      ws.wkVersion
    );
    const wrappedDek = await wrapDek2(dek, ws.wk, FMT3, ws.workspaceId, ws.wkVersion);
    const record = {
      manifestCiphertext: toB646(manifestCiphertext),
      wrappedDek: toB646(wrappedDek),
      version: manifest.version,
      fileId
    };
    const entry = {
      id: fileId,
      name,
      kind: "file",
      contentRef: toHex3(manifest.merkleRoot),
      meta: { size: source.totalSize, record: encodeFileRecord(record) },
      writerId: WRITER_ID,
      timestamp: Date.now()
    };
    try {
      await commitFolderOps(api, session, ws, folderId, [{ type: "put", entry }], {
        fileManifests: [{ fileId, version: manifest.version, ciphertext: toB646(manifestCiphertext) }],
        chunkRefDeltas: [{ entryId: fileId, added: uploadedChunkIds, removed: [] }]
      });
      return { fileId };
    } catch (err) {
      if (!(err instanceof WorkspaceRekeyedError)) throw err;
      if (attempt >= MAX_RESEAL_ATTEMPTS) {
        throw new Error(
          `e2ee: uploadFileStreaming: gave up after ${MAX_RESEAL_ATTEMPTS} re-seal attempts on file "${fileId}" -- the workspace key keeps rotating out from under this upload`
        );
      }
    }
  }
}
async function uploadFile(deps, folderId, name, bytes) {
  return uploadFileStreaming(deps, folderId, name, {
    totalSize: bytes.length,
    boundaries: chunkBoundaries(bytes),
    read: async (offset, size) => bytes.subarray(offset, offset + size)
  });
}
async function updateFile(deps, folderId, fileId, bytes) {
  const { api, transport, session, ws } = deps;
  const { state, headVersion: baseHeadVersion } = await listFolderAt(api, session, ws, folderId);
  const entry = state.get(fileId);
  if (!entry || entry.kind !== "file") {
    throw new Error(`e2ee: updateFile: no such file "${fileId}" in folder "${folderId}"`);
  }
  const oldRecord = decodeFileRecord(entry);
  const cryptoFileId = oldRecord.fileId;
  const oldManifest = await decryptFileManifest2(
    fromB646(oldRecord.manifestCiphertext),
    ws.wk,
    FMT3,
    ws.workspaceId,
    cryptoFileId,
    oldRecord.version,
    folderId,
    ws.wkVersion
  );
  const dek = await unwrapDek2(fromB646(oldRecord.wrappedDek), ws.wk, FMT3, ws.workspaceId, ws.wkVersion);
  const newVersion = oldManifest.version + 1;
  const { manifest, newChunks } = await computeDelta({
    dek,
    dekId: oldManifest.dekId,
    fmt: FMT3,
    workspaceId: ws.workspaceId,
    fileId: cryptoFileId,
    newVersion,
    oldManifest,
    newPlaintext: bytes
  });
  for (const chunk of newChunks) {
    const url = await api.chunkUploadUrl(ws.workspaceId, toHex3(chunk.chunkId), chunk.ciphertext.length);
    await transport.putChunk(url, chunk.ciphertext);
  }
  const newChunkIds = new Set(manifest.chunks.map((c) => toHex3(c.chunkId)));
  const removedChunkRefs = oldManifest.chunks.map((c) => toHex3(c.chunkId)).filter((id) => !newChunkIds.has(id));
  for (let attempt = 1; ; attempt++) {
    const manifestCiphertext = await encryptFileManifest2(
      manifest,
      ws.wk,
      FMT3,
      ws.workspaceId,
      cryptoFileId,
      manifest.version,
      folderId,
      ws.wkVersion
    );
    const wrappedDek = await wrapDek2(dek, ws.wk, FMT3, ws.workspaceId, ws.wkVersion);
    const record = {
      manifestCiphertext: toB646(manifestCiphertext),
      wrappedDek: toB646(wrappedDek),
      version: manifest.version,
      fileId: cryptoFileId
    };
    const updatedEntry = {
      ...entry,
      contentRef: toHex3(manifest.merkleRoot),
      meta: { ...entry.meta, size: bytes.length, record: encodeFileRecord(record) },
      timestamp: Date.now()
    };
    try {
      await commitFolderOps(api, session, ws, folderId, [{ type: "put", entry: updatedEntry }], {
        fileManifests: [{ fileId: cryptoFileId, version: manifest.version, ciphertext: toB646(manifestCiphertext) }],
        chunkRefDeltas: [
          { entryId: updatedEntry.id, added: newChunks.map((c) => toHex3(c.chunkId)), removed: removedChunkRefs }
        ],
        base: { state, headVersion: baseHeadVersion }
      });
      return;
    } catch (err) {
      if (!(err instanceof WorkspaceRekeyedError)) throw err;
      if (attempt >= MAX_RESEAL_ATTEMPTS) {
        throw new Error(
          `e2ee: updateFile: gave up after ${MAX_RESEAL_ATTEMPTS} re-seal attempts on file "${cryptoFileId}" -- the workspace key keeps rotating out from under this update`
        );
      }
    }
  }
}
async function downloadFileTo(deps, folderId, fileId, sink) {
  const { api, transport, session, ws } = deps;
  const state = await listFolder(api, session, ws, folderId);
  const entry = state.get(fileId);
  if (!entry || entry.kind !== "file") {
    throw new Error(`e2ee: downloadFileTo: no such file "${fileId}" in folder "${folderId}"`);
  }
  const record = decodeFileRecord(entry);
  const manifest = await decryptFileManifest2(
    fromB646(record.manifestCiphertext),
    ws.wk,
    FMT3,
    ws.workspaceId,
    record.fileId,
    record.version,
    folderId,
    ws.wkVersion
  );
  const dek = await unwrapDek2(fromB646(record.wrappedDek), ws.wk, FMT3, ws.workspaceId, ws.wkVersion);
  await decryptFileStreaming({
    dek,
    fmt: FMT3,
    workspaceId: ws.workspaceId,
    dekId: manifest.dekId,
    manifest,
    getCiphertext: async (chunkId) => {
      const url = await api.chunkDownloadUrl(ws.workspaceId, toHex3(chunkId));
      return transport.getChunk(url);
    },
    sink
  });
  return { totalSize: manifest.totalSize };
}
async function downloadFile(deps, folderId, fileId) {
  const parts = [];
  await downloadFileTo(deps, folderId, fileId, async (plain) => {
    parts.push(plain);
  });
  return concat(...parts);
}
async function deleteEntry(deps, folderId, entryId) {
  const { api, session, ws } = deps;
  const { state, headVersion: baseHeadVersion } = await listFolderAt(api, session, ws, folderId);
  const entry = state.get(entryId);
  if (!entry) throw new Error(`e2ee: deleteEntry: no such entry "${entryId}" in folder "${folderId}"`);
  let removed = [];
  if (entry.kind === "file") {
    const record = decodeFileRecord(entry);
    const manifest = await decryptFileManifest2(
      fromB646(record.manifestCiphertext),
      ws.wk,
      FMT3,
      ws.workspaceId,
      record.fileId,
      record.version,
      folderId,
      ws.wkVersion
    );
    removed = manifest.chunks.map((c) => toHex3(c.chunkId));
  }
  for (let attempt = 1; ; attempt++) {
    try {
      await commitFolderOps(api, session, ws, folderId, [{ type: "del", id: entryId }], {
        chunkRefDeltas: removed.length > 0 ? [{ entryId, added: [], removed }] : [],
        base: { state, headVersion: baseHeadVersion }
      });
      return;
    } catch (err) {
      if (!(err instanceof WorkspaceRekeyedError)) throw err;
      if (attempt >= MAX_RESEAL_ATTEMPTS) {
        throw new Error(
          `e2ee: deleteEntry: gave up after ${MAX_RESEAL_ATTEMPTS} attempts on entry "${entryId}" -- the workspace key keeps rotating`
        );
      }
    }
  }
}
export {
  MAX_SPACE_NAME_LENGTH,
  WorkspaceRekeyedError,
  commitFolderOps,
  computeRotation,
  createFetchApiClient,
  createFetchChunkTransport,
  createInMemoryChunkTransport,
  createWorkspace,
  decodeSignedRoot,
  deleteEntry,
  deserializeGrant,
  deserializeSignedEntry,
  downloadFile,
  downloadFileTo,
  grantAccess,
  listFolder,
  listFolderAt,
  listMembers,
  normaliseSpaceName,
  openWorkspace,
  readWorkspaceName,
  renameWorkspace,
  resolveChunkRefDeltas,
  revokeAccess,
  serializeGrant,
  serializeSignedEntry,
  setupIdentity,
  unlock,
  unlockWithRecoveryKey,
  updateFile,
  uploadFile,
  uploadFileStreaming
};
