import * as e2eeClient from "@dosya-dev/e2ee-client";
import {
  setupIdentity,
  unlock as engineUnlock,
  createWorkspace as engineCreateWorkspace,
  openWorkspace as engineOpenWorkspace,
  readWorkspaceName as engineReadWorkspaceName,
  renameWorkspace as engineRenameWorkspace,
  listFolder as engineListFolder,
  uploadFile as engineUploadFile,
  downloadFileTo as engineDownloadFileTo,
  grantAccess as engineGrantAccess,
  revokeAccess as engineRevokeAccess,
  listMembers as engineListMembers,
  createHighWaterPersistence,
  type ApiClient,
  type Session,
  type Workspace,
  type FileDeps,
} from "@dosya-dev/e2ee-client";
import { api } from "@/lib/api-client";
import { buildE2eeClient, normalizeRecoveryKey } from "./client";

/**
 * The facade's own refusals. The text is an identifier as much as a message:
 * the store matches on it (`ENGINE_ERRORS` there turns each into a sentence
 * in the chosen language), so it stays English and never changes.
 */
export const ENGINE_LOCKED = "e2ee: locked";
export const ENGINE_NO_ACTIVE_WORKSPACE = "e2ee: no active workspace";
export const ENGINE_RECOVERY_UNAVAILABLE = "e2ee: recovery unlock unavailable in this build";

export type EncryptedEntry = { id: string; name: string; kind: "file" | "folder" };
export type WorkspaceMember = { userId: string; email: string; ed25519Pub: string; x25519Pub: string };

/**
 * Crypto boundary: everything that touches keys/Session/Workspace lives
 * behind this facade. The store and components only ever see the methods
 * below - never a raw KEK, private key, recovery key, or Session/Workspace
 * value.
 */
/**
 * What confirms a Vault destroy: the account password (a string), or the code
 * mailed by POST /api/e2ee/destroy-request. The code is the only proof an
 * Apple or Google sign-in account has - it was never given a password.
 */
export type DestroyProof = string | { code: string };

export interface E2eeEngine {
  hasIdentity(): Promise<boolean>;
  /** first-time setup; returns the recovery key as hex to show ONCE. */
  setup(passphrase: string): Promise<{ recoveryKeyHex: string }>;
  unlock(passphrase: string): Promise<void>;
  /**
   * Unlock with the recovery key shown once at setup (the hex string
   * `setup()` returned; whitespace and dashes are ignored). Contract 6 of the
   * 2026-09-02 field report: `unlockWithRecoveryKey` in @dosya-dev/e2ee-client.
   */
  unlockWithRecoveryKey(recoveryKey: string): Promise<void>;
  /**
   * Destroy this account's Vault identity, grants and index rows so setup can
   * run again - `DELETE /api/e2ee/user-keys` (Contract 6). Everything
   * encrypted under the old identity becomes unreadable; the caller confirms
   * that with the user first. `totpCode` is required when the account has
   * 2FA (the server answers 400 `2fa_required` otherwise).
   */
  destroyIdentity(proof: DestroyProof, totpCode?: string): Promise<void>;
  lock(): void;
  /**
   * The unlocked identity's X25519 keys (copies), for on-device Personas to
   * open or seal the user's personas key (lib/personas-device/engine-host.ts
   * unlockPersonas). Null while locked. Optional so test engines need not
   * implement it.
   */
  personasIdentity?(): { x25519Pub: Uint8Array; x25519Priv: Uint8Array } | null;
  /**
   * `name` is sealed INTO the Space (its root index), not merely kept on this
   * machine, so every other device reads the same label.
   */
  createWorkspace(id: string, name?: string): Promise<void>;
  /** The open Space's own name, or null for a Space made before names existed. */
  readWorkspaceName(): Promise<string | null>;
  /**
   * The name of a Space that is NOT the open one, without disturbing the open
   * one. Fills in a Spaces list whose labels this machine has never seen.
   */
  readWorkspaceNameById(id: string): Promise<string | null>;
  /** Write a name into the open Space. `null` clears it. */
  renameWorkspace(name: string | null): Promise<void>;
  /**
   * P2e: records that `workspaceId` belongs to `globalWorkspaceId` (the
   * active global storage workspace at creation time) via
   * `PUT /api/e2ee/workspace-scope` - plaintext metadata, not crypto, purely
   * for per-workspace Vault UI grouping. Called right after `createWorkspace`.
   */
  setWorkspaceScope(workspaceId: string, globalWorkspaceId: string): Promise<void>;
  /**
   * `selfFounded` is CALLER-supplied (never derived here from anything the
   * server returns) - see `Workspace.selfFounded`'s doc comment in
   * `workspace.ts`. The store sources this from the caller's OWN persisted
   * `KnownWorkspace.selfFounded`, never from the server's `my-workspaces`.
   */
  openWorkspace(id: string, selfFounded: boolean): Promise<void>;
  listFolder(folderId: string): Promise<EncryptedEntry[]>;
  uploadFile(folderId: string, name: string, bytes: Uint8Array): Promise<void>;
  /**
   * Fetch, verify and decrypt a file one chunk at a time, handing each
   * plaintext chunk to `sink` in MANIFEST ORDER (that ordering is
   * e2ee-client's `downloadFileTo` contract, and `index` is passed through so
   * the receiver can enforce it). There is no whole-buffer download on
   * purpose: holding a decrypted file in the renderer's heap and cloning it
   * across IPC cost twice the file across two processes (DSK-010).
   */
  downloadFileToSink(
    folderId: string,
    entryId: string,
    sink: (bytes: Uint8Array, index: number) => Promise<void>,
  ): Promise<void>;
  /** The currently-open workspace's members (email + ed25519 signing pubkey for display/revoke). */
  listMembers(): Promise<WorkspaceMember[]>;
  /** Invite a dosya user (by email) into the currently-open workspace. */
  inviteMember(email: string): Promise<void>;
  /**
   * Revoke a member's access to the currently-open workspace. `ed25519Pub` is
   * their signing pubkey (from `listMembers`). P2d Task 3: this now ROTATES
   * the workspace key (re-keying every file/folder and re-sealing to every
   * remaining member) rather than merely dropping the membership row - it
   * can take noticeably longer on a large workspace, so callers should show
   * `busy` state for the duration.
   */
  revokeMember(userId: string, ed25519Pub: string): Promise<void>;
  /**
   * Discovery (P2c), extended by P2e: every workspace id the caller is
   * currently a member of, per the server, plus the DISPLAY-ONLY
   * `globalWorkspaceId`/`createdByMe` scope hints (see `putWorkspaceScope`'s
   * doc comment - never wired into `selfFounded`).
   */
  listMyWorkspaces(): Promise<{ workspaceId: string; globalWorkspaceId: string | null; createdByMe: boolean }[]>;
}

/**
 * `unlockWithRecoveryKey` from @dosya-dev/e2ee-client (Contract 6). Looked up
 * on the module namespace rather than imported by name: the web app builds
 * against the VENDORED bundle in apps/web/vendor, which is re-vendored from
 * packages/e2ee-client after that package ships the export. Until then the
 * function is absent and the recovery path reports itself unavailable
 * instead of failing the whole build.
 */
type RecoveryUnlock = (api: ApiClient, recoveryKey: string) => Promise<Session>;

/**
 * Pull `unlockWithRecoveryKey` off a module namespace, or null when the bundle
 * predates it. Exported and taking the namespace as an argument purely so it
 * can be tested: `vi.mock` cannot express "this export does not exist" - its
 * mocked-module guard throws on any access to an export the factory omitted,
 * which is the exact situation this has to survive.
 */
export function recoveryUnlockFrom(mod: unknown): RecoveryUnlock | null {
  const fn = (mod as { unlockWithRecoveryKey?: unknown } | undefined)?.unlockWithRecoveryKey;
  return typeof fn === "function" ? (fn as RecoveryUnlock) : null;
}

function vendoredRecoveryUnlock(): RecoveryUnlock | null {
  return recoveryUnlockFrom(e2eeClient);
}

/**
 * Hex of a byte string. Local rather than imported from @dosya-dev/e2ee-core:
 * e2ee-client already inlines its own copy of e2ee-core, and importing the
 * separate bundle for one helper shipped a second 3 MB copy (and a second
 * libsodium WebAssembly instantiation) in the Vault chunk.
 */
function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Where each Space's rollback high-water mark lives between sessions. Not a
 * secret (a version number and a public root hash), so the renderer's
 * localStorage is fine; what matters is that it outlives the in-memory
 * `Workspace`, so a relaunch or a Space switch cannot be served a
 * pre-revocation head unnoticed. Storage that throws degrades to
 * trust-on-first-use, as before.
 */
const highWaterStore = {
  get(key: string): string | null {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set(key: string, value: string): void {
    localStorage.setItem(key, value);
  },
};

/**
 * The real engine: wraps `buildE2eeClient()` and holds the in-memory
 * `Session`/`Workspace` in closure - neither is ever exposed to callers.
 */
export function defaultEngine(): E2eeEngine {
  const { api: e2ee, transport } = buildE2eeClient();
  let session: Session | null = null;
  let ws: Workspace | null = null;
  const highWater = createHighWaterPersistence(highWaterStore);

  /** The persisted mark to check `id`'s head against, and the hook that keeps it current. */
  async function markOpts(s: Session, id: string) {
    return { highWater: await highWater.load(s, id), onAdvance: highWater.onAdvance(s, id) };
  }

  /** Builds a fresh `FileDeps` for a single call, after asserting we're unlocked with an open workspace. */
  function fileDeps(): FileDeps {
    if (!session || !ws) throw new Error(ENGINE_NO_ACTIVE_WORKSPACE);
    return { api: e2ee, transport, session, ws };
  }

  return {
    async hasIdentity() {
      return (await e2ee.getUserKeys()) !== null;
    },

    async setup(passphrase) {
      const { session: s, recoveryKey } = await setupIdentity(e2ee, passphrase);
      session = s;
      return { recoveryKeyHex: toHex(recoveryKey) };
    },

    async unlock(passphrase) {
      session = await engineUnlock(e2ee, passphrase);
    },

    async unlockWithRecoveryKey(recoveryKey) {
      const recover = vendoredRecoveryUnlock();
      if (!recover) throw new Error(ENGINE_RECOVERY_UNAVAILABLE);
      // Normalised here as well as in the store action: this is the last point
      // before the key reaches the crypto library, and a future caller of the
      // engine should not have to know the rule.
      session = await recover(e2ee, normalizeRecoveryKey(recoveryKey));
    },

    async destroyIdentity(proof, totpCode) {
      const body: { password?: string; code?: string; totp_code?: string } =
        typeof proof === "string" ? { password: proof } : { code: proof.code };
      if (totpCode) body.totp_code = totpCode;
      // `api` is the cookie-authed desktop REST client; the e2ee ApiClient
      // has no method for this route.
      await api.delete("/api/e2ee/user-keys", body);
      // Only AFTER the server confirms: dropping the session first turned a
      // refused destroy (wrong password, missing 2FA code) into a lock-out
      // from a Vault that still exists.
      session = null;
      ws = null;
    },

    lock() {
      session = null;
      ws = null;
    },

    personasIdentity() {
      if (!session) return null;
      const { publicKey, privateKey } = session.identity.x25519;
      return { x25519Pub: publicKey.slice(), x25519Priv: privateKey.slice() };
    },

    async createWorkspace(id, name) {
      if (!session) throw new Error(ENGINE_LOCKED);
      ws = await engineCreateWorkspace(e2ee, session, id, {
        ...(name === undefined ? {} : { name }),
        onAdvance: highWater.onAdvance(session, id),
      });
    },

    async readWorkspaceName() {
      if (!session || !ws) throw new Error(ENGINE_NO_ACTIVE_WORKSPACE);
      return engineReadWorkspaceName(e2ee, session, ws);
    },

    async readWorkspaceNameById(id) {
      if (!session) throw new Error(ENGINE_LOCKED);
      // A SEPARATE handle, deliberately never assigned to `ws`: reading a
      // label must not close the Space the person is looking at. selfFounded
      // stays false (TOFU), as openWorkspace's contract requires for a Space
      // this client did not itself create.
      const other = await engineOpenWorkspace(e2ee, session, id, { selfFounded: false, ...(await markOpts(session, id)) });
      return engineReadWorkspaceName(e2ee, session, other);
    },

    async renameWorkspace(name) {
      if (!session || !ws) throw new Error(ENGINE_NO_ACTIVE_WORKSPACE);
      await engineRenameWorkspace(e2ee, session, ws, name);
    },

    async setWorkspaceScope(workspaceId, globalWorkspaceId) {
      await e2ee.putWorkspaceScope(workspaceId, globalWorkspaceId);
    },

    async openWorkspace(id, selfFounded) {
      if (!session) throw new Error(ENGINE_LOCKED);
      // e2ee-core (P2b-log Task 2 fix): `selfFounded` must come from OUR OWN
      // persisted state, never from anything the server returns while
      // opening - see workspace.ts's `openWorkspace` doc comment for why a
      // server-derived value is a forge vector. The store (never this
      // facade) decides the value: true for a workspace this account
      // created, false for one merely discovered/shared (TOFU).
      // The persisted high-water mark is what makes rollback detection
      // survive this fresh handle - see `Workspace.floor` in workspace.ts.
      ws = await engineOpenWorkspace(e2ee, session, id, { selfFounded, ...(await markOpts(session, id)) });
    },

    async listFolder(folderId) {
      if (!session || !ws) throw new Error(ENGINE_NO_ACTIVE_WORKSPACE);
      const state = await engineListFolder(e2ee, session, ws, folderId);
      return [...state.values()].map((e) => ({ id: e.id, name: e.name, kind: e.kind }));
    },

    async uploadFile(folderId, name, bytes) {
      await engineUploadFile(fileDeps(), folderId, name, bytes);
    },

    async downloadFileToSink(folderId, entryId, sink) {
      await engineDownloadFileTo(fileDeps(), folderId, entryId, sink);
    },

    async listMembers() {
      if (!ws) throw new Error(ENGINE_NO_ACTIVE_WORKSPACE);
      return await engineListMembers(e2ee, ws);
    },

    async inviteMember(email) {
      if (!session || !ws) throw new Error(ENGINE_NO_ACTIVE_WORKSPACE);
      await engineGrantAccess(e2ee, session, ws, email);
    },

    async revokeMember(userId, ed25519Pub) {
      if (!session || !ws) throw new Error(ENGINE_NO_ACTIVE_WORKSPACE);
      // P2d Task 3: revokeAccess now ROTATES the workspace key (WK_v1->v2)
      // instead of just appending a remove-entry -- it mutates `ws` IN PLACE
      // (wk/wkVersion/lastSeen) on success, so this facade's closed-over `ws`
      // reference is immediately at v2 for every subsequent call
      // (listFolder/uploadFile/downloadFileToSink) with no re-open needed.
      await engineRevokeAccess(e2ee, session, ws, { userId, ed25519Pub });
    },

    async listMyWorkspaces() {
      return await e2ee.listMyWorkspaces();
    },
  };
}
