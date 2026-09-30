/**
 * Fixed cross-build interop vectors (known-answer tests).
 *
 * These pin the exact byte output of this package's primitives for fixed
 * inputs, so that ports of this library to other languages/runtimes (Rust,
 * Swift, Kotlin, ...) can validate they produce byte-identical results.
 *
 * Values were computed once from this package's own implementation (not
 * hand-derived) and then frozen here as the reference. Do not "fix" a
 * mismatch by regenerating these values unless the encoding/algorithm
 * genuinely changed on purpose.
 */
export declare const VECTORS: {
    readonly argon2id: {
        readonly password_utf8: "correct horse battery staple";
        readonly salt_hex: "11111111111111111111111111111111";
        readonly out_len: 32;
        readonly expected_key_hex: "9df000103aca06f0b0c745a33d1451a60d24f3ce3263862f9ec148cc169a29a0";
    };
    readonly aead: {
        readonly key_hex: "0707070707070707070707070707070707070707070707070707070707070707";
        readonly nonce_hex: "090909090909090909090909090909090909090909090909";
        readonly ad_utf8: "dosya.chunk.v1";
        readonly plaintext_utf8: "vector-plaintext";
        readonly expected_ciphertext_hex: "c81781fe13d85412987361521c167f9fa1f991e15c8257c463ec83bfe6fe501c";
    };
    readonly ed25519: {
        readonly seed_hex: "4242424242424242424242424242424242424242424242424242424242424242";
        readonly message_utf8: "dosya.mlog.v1|add|subject";
        readonly expected_pubkey_hex: "2152f8d19b791d24453242e15f2eab6cb7cffa7b6a5ed30097960e069881db12";
        readonly expected_sig_hex: "daf309fc445c209623996a036b92efd2591f25c5ce74f25a33c33339d0469afe3c23abf928390f05ecdfc83411e7f0138c5ea12d806abbdac26701eadb0f5b0e";
    };
    readonly ad_chunk: {
        readonly fmt: 1;
        readonly workspace_id: "ws1";
        readonly dek_id: "dek1";
        readonly expected_ad_hex: "0000000e646f7379612e6368756e6b2e76310000000400000001000000037773310000000464656b31";
    };
    readonly ad_file_manifest: {
        readonly fmt: 1;
        readonly workspace_id: "ws1";
        readonly file_id: "file1";
        readonly version: 3;
        readonly parent_folder_id: "folder1";
        readonly wk_version: 2;
        readonly expected_ad_hex: "0000000d646f7379612e6d6574612e76310000000400000001000000037773310000000566696c6531000000040000000300000007666f6c646572310000000400000002";
    };
    readonly ad_folder_index: {
        readonly fmt: 1;
        readonly workspace_id: "ws1";
        readonly folder_id: "folder1";
        readonly index_version: 5;
        readonly wk_version: 2;
        readonly expected_ad_hex: "0000000f646f7379612e666f6c6465722e763100000004000000010000000377733100000007666f6c6465723100000004000000050000000400000002";
    };
    readonly ad_root_manifest: {
        readonly fmt: 1;
        readonly workspace_id: "ws1";
        readonly manifest_version: 7;
        readonly prev_root_hash_hex: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
        readonly folder_merkle_root_hex: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
        readonly membership_head_hash_hex: "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
        readonly min_client_version: 1;
        readonly expected_ad_hex: "0000000d646f7379612e726f6f742e7631000000040000000100000003777331000000040000000700000020aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa00000020bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb00000020cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc0000000400000001";
    };
    readonly ad_grant: {
        readonly fmt: 1;
        readonly workspace_id: "ws1";
        readonly wk_version: 2;
        readonly grantee_id: "user2";
        readonly grantee_pubkey_hex: "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd";
        readonly granter_id: "user1";
        readonly expected_ad_hex: "0000000e646f7379612e6772616e742e7631000000040000000100000003777331000000040000000200000005757365723200000020dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd000000057573657231";
    };
    readonly ad_membership_entry: {
        readonly fmt: 1;
        readonly workspace_id: "ws1";
        readonly seq: 9;
        readonly prev_entry_hash_hex: "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
        readonly op: "add";
        readonly subject_id: "user2";
        readonly subject_pubkey_hex: "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff";
        readonly actor_id: "user1";
        readonly expected_ad_hex: "0000000d646f7379612e6d6c6f672e7631000000040000000100000003777331000000040000000900000020eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee0000000361646400000005757365723200000020ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff000000057573657231";
    };
    readonly ad_user_keys: {
        readonly fmt: 1;
        readonly user_id: "user1";
        readonly source: "passphrase";
        readonly expected_ad_hex: "00000011646f7379612e757365726b6579732e763100000004000000010000000575736572310000000a70617373706872617365";
    };
};
