export interface Acknowledgement {
  name: string;
  version: string;
  license: string;
  text: string | null;
}

export function collectAcknowledgements(opts: {
  dependencies: Record<string, string>;
  read: (relPath: string) => string | null;
  exclude?: string[];
}): Acknowledgement[];

export function licenseOf(manifest: unknown): string;
