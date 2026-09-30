import { type Argon2Params, type Argon2Tiers } from "./backend.js";
export type { Argon2Params, Argon2Tiers } from "./backend.js";
export declare const KDF_SALTBYTES = 16;
export declare const ARGON2_TIERS: Argon2Tiers;
export declare function loadArgon2Tiers(): Promise<void>;
export declare function deriveKey(password: Uint8Array, salt: Uint8Array, params: Argon2Params, outLen?: number): Promise<Uint8Array>;
