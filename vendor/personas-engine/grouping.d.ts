import type { Box, Rec } from './records.js';
import type { IndexState } from './state.js';
/** Regroup the pool after this many new unassigned faces (server ruling R23). */
export declare const REGROUP_EVERY = 200;
/** At most this many pool faces, newest first, per clustering pass (R23). */
export declare const POOL_PASS_MAX = 1000;
/** At most this many personas are matched against per call (R69). */
export declare const CENTROID_SCAN_MAX = 2000;
/** A face this close to a tombstoned position is that position. */
export declare const TOMB_IOU = 0.5;
export declare function iou(a: Box, b: Box): number;
export declare function groupNewFaces(state: IndexState, newFaceIds: string[], now: number, newId: () => string): Rec[];
