/**
 * Durable §6 high-water marks - the caller half of `Workspace.floor`.
 *
 * `openWorkspace` only rejects a rolled-back head across sessions if the
 * caller hands it the mark an earlier session saw. This module is that
 * caller half, shared so web, desktop and mobile store it identically: give
 * it any string key/value store (localStorage, a keychain), and pass
 * `load()` as `opts.highWater` and `onAdvance()` as `opts.onAdvance`.
 *
 * Marks are keyed by the identity's Ed25519 public key + workspace id, so two
 * accounts on one device - or a re-created identity - never share a floor.
 * Writes only ever move a mark forward, and are serialised per key so a slow
 * write can't land after (and overwrite) a newer one.
 */
import type { Session } from "./session.js";
import type { HighWaterMark } from "./workspace.js";
export type HighWaterStore = {
    get(key: string): string | null | Promise<string | null>;
    set(key: string, value: string): void | Promise<void>;
};
export declare function encodeHighWater(mark: HighWaterMark): string;
/** `undefined` for a missing or unreadable entry - which is trust-on-first-use, exactly as before. */
export declare function decodeHighWater(raw: string | null | undefined): HighWaterMark | undefined;
export declare function createHighWaterPersistence(store: HighWaterStore): {
    load(session: Session, workspaceId: string): Promise<HighWaterMark | undefined>;
    onAdvance(session: Session, workspaceId: string): (mark: HighWaterMark) => void;
};
