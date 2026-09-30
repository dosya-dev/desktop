export type SelfTestResult = {
    name: string;
    ok: boolean;
    detail: string;
};
/**
 * Exercises every CryptoBackend method through the package wrappers; a port
 * passes when every result is ok. Never throws: a case that blows up is
 * reported as `ok: false` with the error message in `detail`.
 */
export declare function runBackendSelfTest(): Promise<SelfTestResult[]>;
