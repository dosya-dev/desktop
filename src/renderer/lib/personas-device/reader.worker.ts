// Ported from apps/web/src/lib/personas-device/reader.worker.ts - keep the two in step.
//
// The on-device face reader: a Web Worker reading one photo per message.
//
// Two readers, the same faces (ort/pipeline.parity.test.ts):
// - ONNX Runtime (ort/): the platform decodes the photo, onnxruntime-web runs
//   YuNet and SFace. About three times faster. Needs createImageBitmap and a
//   2D OffscreenCanvas in workers.
// - tract (face_reader_bg.wasm): decodes and reads inside its own wasm. Used
//   where the platform cannot decode in a worker (older iOS WebViews), or
//   when ONNX Runtime itself cannot start here.
// Every file comes from GET /api/personas/models/<name> and is checked
// against its pinned SHA-256 before use (read-core.ts). Faces only ever go
// back to the page that sent the photo; nothing is logged.
//
// After a wasm trap the reader's memory may be broken and neither runtime can
// be initialised twice in one realm, so the page (reader.ts) replaces the
// whole worker.
import * as glue from '@dosya-dev/face-reader';
import { failureKind, fetchReaderBytes, loadReader, readPhoto, type WorkerReply, type WorkerRequest } from './read-core';
import { chooseReader, type LoadedReader } from './ort/choose';
import { platformDecoder } from './ort/decode';
import { loadOrtReader } from './ort/reader';

let loading: Promise<LoadedReader> | null = null;

function load(modelBase: string): Promise<LoadedReader> {
  loading ??= chooseReader({
    decoder: platformDecoder(),
    loadOrt: (decoder) => loadOrtReader(modelBase, decoder),
    loadTract: async () => loadReader(glue, await fetchReaderBytes(modelBase)),
  }).catch((e) => {
    loading = null; // a failed load is tried again on the next photo
    throw e;
  });
  return loading;
}

const scope = self as unknown as {
  onmessage: ((ev: MessageEvent<WorkerRequest>) => void) | null;
  postMessage(msg: WorkerReply, transfer?: Transferable[]): void;
};

scope.onmessage = async (ev) => {
  const { id, modelBase, photo } = ev.data;
  let loaded: LoadedReader;
  try {
    loaded = await load(modelBase);
  } catch (e) {
    scope.postMessage({ id, ok: false, kind: 'unavailable', message: e instanceof Error ? e.message : String(e) });
    return;
  }
  try {
    const faces = await readPhoto(loaded.reader, photo, { errorsAreThePhotos: !loaded.ort });
    scope.postMessage({ id, ok: true, faces }, faces.map((f) => f.sig.buffer as ArrayBuffer));
  } catch (e) {
    scope.postMessage({ id, ok: false, kind: failureKind(e), message: e instanceof Error ? e.message : String(e) });
  }
};
