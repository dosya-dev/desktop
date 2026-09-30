/**
 * Wire (de)serialization for e2ee-core's `Grant` (the HPKE-sealed workspace
 * key, produced by `sealGrant`/consumed by `openGrant`) -- a stable,
 * server-opaque b64-JSON blob of the type's three byte fields. This lives in
 * e2ee-client (not e2ee-core) because it's a wire-format choice, not a
 * crypto primitive: the server (`e2ee_workspace_grants.sealed_grant`) stores
 * and returns this string verbatim, never parsing or opening it (see
 * apps/api/src/pages/api/e2ee/workspace-grant.ts).
 */
import { type Grant } from "@dosya-dev/e2ee-core";
/** b64-JSON of the three Grant byte fields - a stable, server-opaque blob. */
export declare function serializeGrant(g: Grant): string;
/** Reverse of `serializeGrant`. Throws (JSON/b64 errors) on malformed input - callers see that as a failed open, same posture as `openGrant`'s own failure modes. */
export declare function deserializeGrant(s: string): Grant;
