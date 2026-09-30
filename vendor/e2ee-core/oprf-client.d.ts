/** The OPRF suite the E2EE design uses (must match the server). */
export declare const OPRF_SUITE: "ristretto255-SHA512";
export type OprfBlindResult = {
    /** Serialized `EvaluationRequest` - send this to the server's /oprf-evaluate. */
    blindedElement: Uint8Array;
    /**
     * Unblinds the server's serialized evaluated element into the OPRF output.
     * Verifies the DLEQ proof carried in the server's `Evaluation` against the
     * `serverPublicKey` this client was constructed with, and THROWS if the
     * proof is missing or fails verification - a malicious/misconfigured
     * server (or a mismatched public key) cannot silently produce an
     * unverified output.
     */
    finalize: (evaluatedElement: Uint8Array) => Promise<Uint8Array>;
};
/**
 * Blind `input` for VOPRF evaluation against the server identified by
 * `serverPublicKey` (its committed, serialized public key - see spec §5.1).
 * Returns the serialized blinded element to send to the server, plus a
 * `finalize` closure that captures the client's blind state (voprf-ts's
 * `FinalizeData`) so callers only ever pass bytes.
 *
 * `finalize` verifies the server's DLEQ proof against `serverPublicKey`
 * before unblinding, so callers MUST pass the server's real committed public
 * key here - passing the wrong key means a genuine server response will
 * fail proof verification and `finalize` will throw.
 */
export declare function oprfBlind(input: Uint8Array, serverPublicKey: Uint8Array): Promise<OprfBlindResult>;
