// Ported from apps/web/src/lib/personas-device/ort/choose.ts - keep the two in step.
//
// Which reader a worker runs (reader.worker.ts): ONNX Runtime where the
// platform can decode photos in a worker, else tract. ONNX Runtime failing to
// start for any reason but a download or SHA-256 failure falls back to tract;
// a download failure is the reader being unavailable, since tract would fetch
// from the same place.
import { IntegrityError, type PhotoReader } from '../read-core';
import type { Decoder } from './decode';

export interface LoadedReader {
  reader: PhotoReader;
  /** The ONNX Runtime reader: its errors other than an undecodable photo are failed reads. */
  ort: boolean;
}

export interface ReaderLoaders {
  decoder: Decoder | null;
  loadOrt(decoder: Decoder): Promise<PhotoReader>;
  loadTract(): Promise<PhotoReader>;
}

export const isFetchFailure = (e: unknown): boolean => e instanceof IntegrityError || (e instanceof Error && e.message.startsWith('face reader file '));

export async function chooseReader(l: ReaderLoaders): Promise<LoadedReader> {
  if (l.decoder) {
    try {
      return { reader: await l.loadOrt(l.decoder), ort: true };
    } catch (e) {
      if (isFetchFailure(e)) throw e;
    }
  }
  return { reader: await l.loadTract(), ort: false };
}
