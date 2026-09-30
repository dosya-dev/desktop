/**
 * Binary SHA-256 Merkle tree over ordered leaves.
 *
 * Domain separation prevents a second-preimage attack where an attacker
 * substitutes an internal node's hash for a leaf (or vice versa) to forge a
 * different tree with the same root:
 *   - leaf hash:     sha256(0x00 ‖ leaf)
 *   - internal node: sha256(0x01 ‖ left ‖ right)
 *
 * Odd-node rule: if a level has an odd number of nodes, the last node is
 * promoted by pairing it with itself - i.e. its parent is
 * sha256(0x01 ‖ last ‖ last) - rather than being carried up unhashed. This
 * keeps every node at a given level produced by the same internal-hash
 * shape, at the cost of the well-known duplicate-leaf ambiguity (a Merkle
 * proof must include the tree's leaf count so an odd count / duplication
 * can't be reinterpreted as a different set of leaves).
 *
 * The empty tree's root is `sha256(empty)` (no domain byte) and a
 * single-leaf tree's root is just that leaf's domain-separated hash
 * (`sha256(0x00 ‖ leaf)`) - there is no internal node to compute.
 */
/** Compute the Merkle root of `leaves`, in order. See module docs for the exact rules. */
export declare function merkleRoot(leaves: Uint8Array[]): Promise<Uint8Array>;
