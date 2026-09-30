import { create } from "zustand";
import { persist } from "zustand/middleware";
import { toast } from "sonner";
import { ApiError } from "@/lib/api-client";
import { SESSION_RESET_EVENT } from "@/lib/session-reset";
import { defaultEngine, type E2eeEngine, type EncryptedEntry, type WorkspaceMember } from "./engine";
import { getActiveGlobalWorkspaceId } from "./active-workspace";
import { normalizeRecoveryKey } from "./client";

export type { E2eeEngine, EncryptedEntry, WorkspaceMember } from "./engine";

export type E2eeStatus = "locked" | "unlocking" | "unlocked";
/**
 * `globalWorkspaceId` (P2e) is the active global storage workspace this Space
 * was scoped to at creation (or `null` for a legacy/unscoped Space) and
 * `shared` is whether this Space was DISCOVERED (shared with us) rather than
 * created by us - BOTH are DISPLAY-ONLY (server-sourced, for Vault grouping).
 * `selfFounded` remains the security-critical, CLIENT-SOURCED anchor - its
 * semantics are UNCHANGED by P2e (see `E2eeEngine.openWorkspace`'s doc
 * comment and `createWorkspace`/`refreshMyWorkspaces` below).
 */
export type KnownWorkspace = {
  id: string;
  /**
   * What this machine shows. The Space carries its own name now (sealed in
   * its root index); `openWorkspace` reconciles the two.
   */
  name: string;
  selfFounded: boolean;
  globalWorkspaceId: string | null;
  shared: boolean;
  /**
   * True when `name` is a placeholder this machine invented for a Space it
   * discovered rather than created. A placeholder is never written into the
   * Space; a real name is. An entry persisted before this field existed has
   * no `stub`, and is treated as real - which it was.
   */
  stub?: boolean;
};

/** Result of handing decrypted bytes to the main process (see src/main/vault-save.ts). */
export type VaultSaveOutcome = { ok: boolean; canceled?: boolean; path?: string };
export type VaultSaver = (name: string, bytes: Uint8Array) => Promise<VaultSaveOutcome>;

/** Production saver: the main process owns the dialog and the path. */
const ipcSaver: VaultSaver = (name, bytes) => window.electronAPI.vaultSaveBytes(name, bytes);

interface VaultState {
  status: E2eeStatus;
  error: string | null;
  engine: E2eeEngine;
  hasIdentity: boolean | null;
  workspaces: KnownWorkspace[];
  /**
   * The account whose Spaces the persisted `workspaces` list describes. The
   * page calls `bindOwner(user.id)` before `checkIdentity`; a different owner
   * drops the list so account B never sees account A's Space names on a shared
   * machine. Losing an entry this way only ever loses `selfFounded` in the safe
   * direction (a Space rediscovered later opens as trust-on-first-use).
   */
  ownerUserId: string | null;
  activeWorkspaceId: string | null;
  entries: EncryptedEntry[];
  /** The currently-open workspace's members. In-memory only - cleared on lock, never persisted. */
  members: WorkspaceMember[];
  busy: boolean;
  /** The recovery key, shown ONCE right after setup. Never persisted. */
  recoveryKeyOnce: string | null;
  /** Where `downloadEntry` hands decrypted bytes off to trigger a save. Swappable in tests (no DOM). */
  saver: VaultSaver;

  checkIdentity(): Promise<void>;
  setup(passphrase: string): Promise<void>;
  unlock(passphrase: string): Promise<void>;
  /** Unlock with the recovery key from setup. A failure is reported generically, like `unlock`. */
  unlockWithRecoveryKey(recoveryKey: string): Promise<void>;
  /**
   * Destroy the Vault identity and return to first-time setup. Resolves true
   * on success; on refusal `error` carries the server's sentence (wrong
   * password, missing 2FA code) and the identity is untouched.
   */
  destroyIdentity(password: string, totpCode?: string): Promise<boolean>;
  lock(): void;
  /**
   * Drops `workspaces` when the signed-in account differs from the last one
   * this Vault store was bound to, then records the new owner. See
   * `ownerUserId`'s doc comment above.
   */
  bindOwner(userId: string): void;
  createWorkspace(name: string): Promise<void>;
  openWorkspace(id: string): Promise<void>;
  /** Make this machine's label and the Space's own name agree. Best effort. */
  reconcileWorkspaceName(id: string): Promise<void>;
  /**
   * Fill in the labels for Spaces this machine only knows as placeholders, so
   * a list of them is not a column of identical rows.
   */
  resolveSpaceNames(): Promise<void>;
  /** Set (or with `null` clear) a Space's name, everywhere. */
  renameWorkspace(id: string, name: string): Promise<void>;
  /**
   * Discover every workspace this account is a member of (P2c), extended by
   * P2e's scope metadata, and merge any not already known - a
   * `createdByMe:false` entry as `{shared:true, selfFounded:false}`, a
   * `createdByMe:true` entry as `{shared:false, selfFounded:false}` - NEVER
   * touching an already-known entry (esp. never downgrading/upgrading its
   * `selfFounded`). `selfFounded` is `false` for EVERY discovered entry,
   * regardless of `createdByMe`: only `createWorkspace` (this client's own
   * act of creation) is allowed to set it `true` - see the CRITICAL security
   * invariant in this module's `openWorkspace`/`E2eeEngine` doc comments.
   */
  refreshMyWorkspaces(): Promise<void>;
  /**
   * This account's OWN Spaces scoped to the active global workspace
   * (`getActiveGlobalWorkspaceId()`) - never-shared entries whose
   * `globalWorkspaceId` matches the active id, plus a legacy/unscoped
   * (`globalWorkspaceId == null`) fallback so pre-P2e Spaces don't vanish.
   */
  mySpacesForActiveWorkspace(): KnownWorkspace[];
  /** Every Space shared WITH this account (`shared:true`), regardless of the active global workspace. */
  sharedSpaces(): KnownWorkspace[];
  refreshFolder(folderId?: string): Promise<void>;
  uploadFiles(files: FileList | File[], folderId?: string): Promise<void>;
  downloadEntry(entryId: string, name: string, folderId?: string): Promise<void>;
  /** Refresh `members` from the currently-open workspace. */
  refreshMembers(): Promise<void>;
  /** Invite a dosya user (by email) into the currently-open workspace, then refresh `members`. */
  inviteMember(email: string): Promise<void>;
  /** Revoke a member's access to the currently-open workspace, then refresh `members`. */
  revokeMember(userId: string, ed25519Pub: string): Promise<void>;
  dismissRecoveryKey(): void;
  /** Test seam: swap in a fake `E2eeEngine`. */
  __setEngine(engine: E2eeEngine): void;
  /** Test seam: swap in a fake saver (production default is the real IPC-backed `ipcSaver`). */
  __setSaver(saver: VaultSaver): void;
}

/**
 * The API's 412 `e2ee_scope_required` as it reaches the store: e2ee-client's
 * transport throws `e2ee: <route> request failed (<status>)` for any non-2xx
 * (apart from the 409 it treats as a CAS conflict), so the status code in
 * that text is the only signal available here.
 */
function isScopeRequired(e: unknown): boolean {
  return e instanceof Error && /\(412\)/.test(e.message);
}

function errorMessage(e: unknown, fallback: string): string {
  return e instanceof Error && e.message ? e.message : fallback;
}

/**
 * The API answers DELETE /api/e2ee/user-keys with a CODE in `error` for the
 * one case the client has to act on (400 `2fa_required`); the rest are already
 * sentences ("Incorrect password", "Incorrect code"). The code is the contract,
 * the sentence is presentation.
 */
function describeDestroyError(e: unknown): string {
  if (e instanceof ApiError && e.message === "2fa_required") return "Enter your two-factor code to continue.";
  return errorMessage(e, "Could not destroy the Vault.");
}

export const useVault = create<VaultState>()(
  persist(
    (set, get) => ({
      status: "locked",
      error: null,
      engine: defaultEngine(),
      hasIdentity: null,
      workspaces: [],
      ownerUserId: null,
      activeWorkspaceId: null,
      entries: [],
      members: [],
      busy: false,
      recoveryKeyOnce: null,
      saver: ipcSaver,

      async checkIdentity() {
        try {
          const hasIdentity = await get().engine.hasIdentity();
          set({ hasIdentity, error: null });
        } catch (e) {
          // We genuinely don't know whether an identity exists - do NOT set
          // `false` here. That would route a transient network blip into the
          // first-time Setup flow, and `setup()` unconditionally upserts new
          // identity keys, silently orphaning any real encrypted workspaces.
          // Leave `hasIdentity` as `null` (unknown) and surface `error` so the
          // gate shows a retry banner instead of Setup.
          set({ hasIdentity: null, error: errorMessage(e, "Could not check encryption status.") });
        }
      },

      async setup(passphrase) {
        set({ busy: true, error: null });
        try {
          const { recoveryKeyHex } = await get().engine.setup(passphrase);
          set({
            status: "unlocked",
            hasIdentity: true,
            recoveryKeyOnce: recoveryKeyHex,
            busy: false,
            error: null,
          });
        } catch (e) {
          set({ busy: false, error: errorMessage(e, "Could not set up encryption.") });
        }
      },

      async unlock(passphrase) {
        set({ status: "unlocking", error: null, busy: true });
        try {
          await get().engine.unlock(passphrase);
          set({ status: "unlocked", hasIdentity: true, busy: false, error: null });
        } catch {
          // The engine throws one opaque error for every failure mode (wrong
          // passphrase, no identity, corrupt record) - surface a single
          // generic message here too, never the engine's own text.
          set({
            status: "locked",
            busy: false,
            error: "Incorrect passphrase or no identity found.",
          });
        }
      },

      async unlockWithRecoveryKey(recoveryKey) {
        set({ status: "unlocking", error: null, busy: true });
        try {
          // The spacing and dashes belong to however the key was pasted, not
          // to the key - normalised once here, at the boundary every caller
          // (the unlock gate today) goes through.
          await get().engine.unlockWithRecoveryKey(normalizeRecoveryKey(recoveryKey));
          set({ status: "unlocked", hasIdentity: true, busy: false, error: null });
        } catch (e) {
          // Same opacity rule as `unlock`: one generic sentence, never the
          // engine's own text - except when the build has no recovery path at
          // all, which is a product state the user should be told about.
          const unavailable = e instanceof Error && e.message.includes("recovery unlock unavailable");
          set({
            status: "locked",
            busy: false,
            error: unavailable
              ? "Recovery key unlock is not available in this version yet. Please try again after the next update."
              : "That recovery key did not unlock your Vault.",
          });
        }
      },

      async destroyIdentity(password, totpCode) {
        set({ busy: true, error: null });
        try {
          await get().engine.destroyIdentity(password, totpCode);
          // Everything the old identity described is gone with it: the
          // persisted Spaces list would otherwise point at grants that no
          // longer exist. hasIdentity=false routes the gate to Setup.
          set({
            status: "locked",
            hasIdentity: false,
            workspaces: [],
            activeWorkspaceId: null,
            entries: [],
            members: [],
            recoveryKeyOnce: null,
            busy: false,
            error: null,
          });
          return true;
        } catch (e) {
          set({ busy: false, error: describeDestroyError(e) });
          return false;
        }
      },

      lock() {
        get().engine.lock();
        set({ status: "locked", entries: [], activeWorkspaceId: null, members: [], error: null });
      },

      bindOwner(userId) {
        const prev = get().ownerUserId;
        if (prev === userId) return;
        // A different account: nothing the previous one left in memory may
        // survive - not its Space names, not its one-time recovery key, and
        // not its answer to "does an identity exist" (the gate re-asks).
        set(prev == null
          ? { ownerUserId: userId }
          : { ownerUserId: userId, workspaces: [], activeWorkspaceId: null, entries: [], members: [], recoveryKeyOnce: null, hasIdentity: null });
      },

      async createWorkspace(name) {
        set({ busy: true, error: null });
        const gw = getActiveGlobalWorkspaceId();
        const id = crypto.randomUUID();
        try {
          await get().engine.createWorkspace(id, name);
          // P2e: record the workspace→global-workspace association right
          // after creation - plaintext metadata, not crypto (see
          // `setWorkspaceScope`'s doc comment). This is DISPLAY-ONLY: it
          // never feeds `selfFounded` below.
          if (gw) await get().engine.setWorkspaceScope(id, gw);
          set((s) => ({
            // SECURITY: this account created `id` - it is hard-anchored,
            // selfFounded:true, forever (persisted below via `partialize`).
            // A later `refreshMyWorkspaces()` must never downgrade this.
            workspaces: [...s.workspaces, { id, name, selfFounded: true, shared: false, globalWorkspaceId: gw, stub: false }],
            activeWorkspaceId: id,
            busy: false,
          }));
        } catch (e) {
          set({ busy: false, error: errorMessage(e, "Could not create Space.") });
        }
      },

      async openWorkspace(id) {
        set({ busy: true, error: null });
        try {
          // SECURITY: `selfFounded` comes ONLY from our own persisted
          // `workspaces` list (client-authored - created via createWorkspace,
          // or merged in as false by refreshMyWorkspaces) - NEVER from
          // the server. Default false (safe) for an id we don't recognize at
          // all: a genuinely-shared workspace we haven't discovered yet via
          // refreshMyWorkspaces should still open as TOFU, not founder.
          const known = get().workspaces.find((w) => w.id === id);
          await get().engine.openWorkspace(id, known?.selfFounded ?? false);
          set({ activeWorkspaceId: id, members: [], busy: false });
          void get().reconcileWorkspaceName(id);
        } catch (e) {
          set({ busy: false, error: errorMessage(e, "Could not open Space.") });
        }
      },

      /**
       * Both directions, and neither worth an error message:
       *
       *  - the Space has a name -> show it, which is what stops a Space made
       *    on a phone reading as "Space" here.
       *  - the Space has none and this machine holds a real one -> write it
       *    in, so a Space made before names existed acquires one without
       *    anybody retyping anything.
       *
       * Deliberately not awaited by `openWorkspace`: it is housekeeping, and
       * somebody waiting to see their files should not wait on a label.
       */
      async reconcileWorkspaceName(id) {
        try {
          const remote = await get().engine.readWorkspaceName();
          if (get().activeWorkspaceId !== id) return;
          const known = get().workspaces.find((w) => w.id === id);
          if (!known) return;

          if (remote !== null) {
            if (remote === known.name && known.stub !== true) return;
            set((st) => ({
              workspaces: st.workspaces.map((w) => (w.id === id ? { ...w, name: remote, stub: false } : w)),
            }));
            return;
          }

          if (known.stub === true) return;
          await get().engine.renameWorkspace(known.name);
        } catch {
          // A label is not worth an error over a Space that opened.
        }
      },

      async resolveSpaceNames() {
        // Only the placeholders, and only once each: every one costs a grant
        // fetch, a head fetch and a decrypt. Sequential on purpose - this is
        // background work behind a list that already rendered.
        const pending = get().workspaces.filter((w) => w.stub === true);
        for (const w of pending) {
          try {
            const name = await get().engine.readWorkspaceNameById(w.id);
            if (name === null) continue;
            set((st) => ({
              workspaces: st.workspaces.map((x) => (x.id === w.id ? { ...x, name, stub: false } : x)),
            }));
          } catch {
            // Leave the placeholder. A label is not worth an error.
          }
        }
      },

      async renameWorkspace(id, name) {
        set({ busy: true, error: null });
        try {
          if (get().activeWorkspaceId !== id) await get().openWorkspace(id);
          await get().engine.renameWorkspace(name);
          set((st) => ({
            workspaces: st.workspaces.map((w) => (w.id === id ? { ...w, name, stub: false } : w)),
            busy: false,
          }));
        } catch (e) {
          set({ busy: false, error: errorMessage(e, "Could not rename Space.") });
        }
      },

      async refreshMyWorkspaces() {
        try {
          const mine = await get().engine.listMyWorkspaces();
          set((s) => {
            const known = new Set(s.workspaces.map((w) => w.id));
            // SECURITY: `selfFounded` is ALWAYS `false` here, regardless of
            // the server's `createdByMe` - a discovered entry (one this
            // client did not itself `createWorkspace`) is TOFU, never the
            // hard-anchored founder. `createdByMe`/`globalWorkspaceId` are
            // DISPLAY-ONLY (they drive `shared` + the active-workspace
            // grouping below) - see this module's top-level doc comments and
            // the CRITICAL security invariant in the P2e plan. Do NOT wire
            // `createdByMe` into `selfFounded`.
            const discovered: KnownWorkspace[] = mine
              .filter((m) => !known.has(m.workspaceId))
              .map((m) => ({
                id: m.workspaceId,
                // A placeholder, and marked as one: this machine has never
                // seen the Space's real name. Opening it reads the name the
                // Space itself carries and replaces this.
                name: m.createdByMe ? "Space" : "Shared Space",
                globalWorkspaceId: m.globalWorkspaceId,
                shared: !m.createdByMe,
                selfFounded: false,
                stub: true,
              }));
            return discovered.length > 0 ? { workspaces: [...s.workspaces, ...discovered] } : {};
          });
          // The list is already on screen; the labels arrive behind it.
          void get().resolveSpaceNames();
        } catch (e) {
          set({ error: errorMessage(e, "Could not check for shared Spaces.") });
        }
      },

      mySpacesForActiveWorkspace() {
        const activeId = getActiveGlobalWorkspaceId();
        return get().workspaces.filter(
          (w) => !w.shared && (w.globalWorkspaceId === activeId || w.globalWorkspaceId == null),
        );
      },

      sharedSpaces() {
        return get().workspaces.filter((w) => w.shared);
      },

      async refreshFolder(folderId = "") {
        set({ busy: true, error: null });
        try {
          const entries = await get().engine.listFolder(folderId);
          set({ entries, busy: false });
        } catch (e) {
          set({ busy: false, error: errorMessage(e, "Could not load folder.") });
        }
      },

      async uploadFiles(files, folderId = "") {
        set({ busy: true, error: null });
        try {
          for (const file of Array.from(files)) {
            const bytes = new Uint8Array(await file.arrayBuffer());
            try {
              await get().engine.uploadFile(folderId, file.name, bytes);
            } catch (e) {
              // A Space with no storage workspace cannot take bytes (the API
              // answers 412 `e2ee_scope_required` from chunk-upload-url or
              // commit). Pre-P2e Spaces and Spaces whose workspace was since
              // deleted are in that state; attach this one to the active
              // global workspace - where the Vault UI already lists it - and
              // retry once. e2ee-client surfaces only the status code in its
              // error text, so the status is what is matched.
              const spaceId = get().activeWorkspaceId;
              const gw = getActiveGlobalWorkspaceId();
              if (!isScopeRequired(e) || !spaceId || !gw) throw e;
              await get().engine.setWorkspaceScope(spaceId, gw);
              set((s) => ({
                workspaces: s.workspaces.map((w) => (w.id === spaceId ? { ...w, globalWorkspaceId: gw } : w)),
              }));
              await get().engine.uploadFile(folderId, file.name, bytes);
            }
          }
          await get().refreshFolder(folderId);
          set({ busy: false });
          toast.success("Uploaded", {
            description: files.length === 1 ? Array.from(files)[0].name : `${files.length} files`,
          });
        } catch (e) {
          set({ busy: false, error: errorMessage(e, "Could not upload file.") });
          toast.error("Upload failed", { description: errorMessage(e, "Could not upload file.") });
        }
      },

      async downloadEntry(entryId, name, folderId = "") {
        set({ busy: true, error: null });
        try {
          const bytes = await get().engine.downloadFile(folderId, entryId);
          // Decryption is the busy part. The save dialog that follows is the
          // user's time, not ours: keep the grid on screen while it is open.
          set({ busy: false });
          const outcome = await get().saver(name, bytes);
          if (outcome.ok) toast.success("Saved", { description: outcome.path ? `Saved to ${outcome.path}` : name });
          // A cancelled dialog is neither: the user changed their mind.
        } catch (e) {
          set({ busy: false, error: errorMessage(e, "Could not download file.") });
          toast.error("Download failed", { description: errorMessage(e, "Could not download file.") });
        }
      },

      async refreshMembers() {
        set({ busy: true, error: null });
        try {
          const members = await get().engine.listMembers();
          set({ members, busy: false });
        } catch (e) {
          set({ busy: false, error: errorMessage(e, "Could not load members.") });
        }
      },

      async inviteMember(email) {
        set({ busy: true, error: null });
        try {
          await get().engine.inviteMember(email);
          await get().refreshMembers();
          set({ busy: false });
          toast.success("Invited", { description: email });
        } catch (e) {
          // The engine's directory-lookup failure is worded for a developer
          // ("that user has no E2EE identity"); surface a friendly,
          // user-facing message instead of leaking that phrasing verbatim.
          const message =
            e instanceof Error && e.message.includes("no E2EE identity")
              ? "That user hasn't set up encryption yet"
              : errorMessage(e, "Could not invite that user.");
          set({ busy: false, error: message });
          toast.error("Invite failed", { description: message });
        }
      },

      async revokeMember(userId, ed25519Pub) {
        set({ busy: true, error: null });
        try {
          await get().engine.revokeMember(userId, ed25519Pub);
          await get().refreshMembers();
          set({ busy: false });
          toast.success("Access revoked");
        } catch (e) {
          set({ busy: false, error: errorMessage(e, "Could not revoke that member.") });
          toast.error("Revoke failed", { description: errorMessage(e, "Could not revoke that member.") });
        }
      },

      dismissRecoveryKey() {
        set({ recoveryKeyOnce: null });
      },

      __setEngine(engine) {
        set({ engine });
      },

      __setSaver(saver) {
        set({ saver });
      },
    }),
    {
      name: "dosya_vault",
      // The KEK/Session/private keys/recovery key live in memory ONLY -
      // never write them (or the engine instance itself) to localStorage.
      // Persist ONLY the non-secret workspace id+name+selfFounded+
      // globalWorkspaceId+shared hints (selfFounded is itself the
      // client-authored anchor `openWorkspace` relies on - see its doc
      // comment above - so it MUST persist here; globalWorkspaceId/shared
      // are P2e's DISPLAY-ONLY grouping hints, equally non-secret - plain
      // ids, no key material). `members` is likewise in-memory only (cleared
      // on lock/workspace switch) and deliberately excluded: this is an
      // ALLOWLIST, so it drops anything not named here regardless.
      // `ownerUserId` is the account the list belongs to - an id, not a secret.
      partialize: (state) => ({ workspaces: state.workspaces, ownerUserId: state.ownerUserId }),
    },
  ),
);

// Logout and 401-detected expiry tear the account down (session-reset.ts).
// The Vault session is per-account memory, so it goes with it - including a
// recovery key still waiting to be dismissed, which must never outlive the
// account that generated it.
if (typeof window !== "undefined") {
  window.addEventListener(SESSION_RESET_EVENT, () => {
    useVault.getState().lock();
    // The next account re-asks whether an identity exists; answering from the
    // previous account's result would paint its card for a frame.
    useVault.setState({ recoveryKeyOnce: null, hasIdentity: null });
  });
}
