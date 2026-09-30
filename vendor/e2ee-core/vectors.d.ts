export type VectorResult = {
    name: string;
    ok: boolean;
    expected: string;
    actual: string;
};
export declare function runVectors(): Promise<VectorResult[]>;
