/**
 * Wire (de)serialization for e2ee-core's `SignedEntry` (a signed membership
 * log entry - genesis/add/remove, spec §7) -- a stable, server-opaque
 * b64-JSON blob. Mirrors `grant-codec.ts`'s posture exactly: this lives in
 * e2ee-client (not e2ee-core) because it's a wire-format choice, not a
 * crypto primitive. The server (`e2ee_membership_log.entry_blob`) stores and
 * returns this string verbatim, never parsing or opening it (see
 * apps/api/src/pages/api/e2ee/commit.ts and
 * apps/api/src/pages/api/e2ee/membership-log/[workspaceId].ts).
 *
 * `MembershipEntry`'s byte fields (`prevHash`, `subjectPubkey`) plus the
 * `SignedEntry`'s own `actorSig` are b64-encoded; every other field is a
 * plain JSON scalar (`fmt`, `workspaceId`, `seq`, `op`, `subjectId`,
 * `actorId`).
 */
import { type SignedEntry } from "@dosya-dev/e2ee-core";
/** b64-JSON of a `SignedEntry` - a stable, server-opaque blob. */
export declare function serializeSignedEntry(e: SignedEntry): string;
/** Reverse of `serializeSignedEntry`. Throws (JSON/b64 errors) on malformed input - callers see that as a failed replay, same posture as `replayLog`'s own failure modes. */
export declare function deserializeSignedEntry(s: string): SignedEntry;
