/**
 * Passphrase unlock / identity setup (spec §5.3 VOPRF->Argon2id->KEK,
 * §5.4/§5.8 identity bundle). Composes e2ee-core's primitives against the
 * injected `ApiClient` - never re-implements any crypto here.
 */
import { type IdentityBundle } from "@dosya-dev/e2ee-core";
import type { ApiClient } from "./api.js";
export type Session = {
    kek: Uint8Array;
    identity: IdentityBundle;
};
/**
 * First-time setup: generates a fresh identity bundle and a random recovery
 * key, derives the KEK via VOPRF+Argon2id, wraps the bundle both ways
 * (passphrase KEK + recovery key), and stores everything except the
 * KEK/private keys/recovery key via `putUserKeys`.
 *
 * The recovery key is returned ONCE here - the caller must show it to the
 * user now (e.g. "save this recovery code"); it is never recoverable from
 * the server afterward.
 */
export declare function setupIdentity(api: ApiClient, passphrase: string): Promise<{
    session: Session;
    recoveryKey: Uint8Array;
}>;
/**
 * Unlock on any device: fetch the stored salt + wrapped bundle, re-derive
 * the KEK via VOPRF+Argon2id, and unwrap. Throws the SAME
 * `"e2ee: unlock failed"` error for every failure mode (wrong passphrase, no
 * identity set up yet, or a corrupt/tampered record) so a caller can never
 * distinguish "no such identity" from "wrong passphrase" by error message.
 */
export declare function unlock(api: ApiClient, passphrase: string): Promise<Session>;
/**
 * "Lost my passphrase" unlock. Fetches the stored recovery-wrapped identity
 * bundle + salt and unwraps it with the recovery KEY the user saved at setup,
 * WITHOUT the passphrase or any OPRF round-trip (the recovery wrap is derived
 * from the random recovery key alone - see e2ee-core's keys.ts).
 *
 * `recoveryKey` is the user-facing string the setup UI displayed: lowercase hex
 * of the 32 raw bytes. It is accepted whitespace/dash-insensitive and
 * case-insensitive, so a value copied with grouping spaces or dashes still
 * works.
 *
 * Returns a `Session` whose `identity` is byte-identical to the one
 * `setupIdentity` produced. Its `kek` is the recovery-derived key (NOT the
 * passphrase KEK, which recovery cannot reconstruct); it is a real 32-byte KEK
 * and nothing in the engine reads it during folder/file operations, but a
 * caller that recovers this way should have the user set a NEW passphrase
 * afterwards rather than treat this KEK as the passphrase one.
 *
 * Throws the SAME `"e2ee: unlock failed"` as `unlock` for every failure mode
 * (no identity, no recovery wrap stored, malformed key, wrong key, tampered
 * record) so a caller can never tell them apart by message.
 */
export declare function unlockWithRecoveryKey(api: ApiClient, recoveryKey: string): Promise<Session>;
