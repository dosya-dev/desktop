// Ported from apps/web/src/lib/personas-device/ort/reader.ts - keep the two in step.
//
// The ONNX Runtime face reader as a PhotoReader: decode with the platform
// (decode.ts), run YuNet and SFace on onnxruntime-web (models.ts), with the
// image work ported from the Rust reader (pipeline.ts). Every file comes from
// the models route and is checked against its pinned SHA-256 first.
import { fetchPinned, ORT_FILES, type PhotoReader } from '../read-core';
import { decodePhoto, type Decoder } from './decode';
import { loadOrtModels } from './models';
import { readFaces } from './pipeline';

export async function loadOrtReader(modelBase: string, decoder: Decoder, fetchFn: typeof fetch = fetch): Promise<PhotoReader> {
  // One after the other, as for the tract reader: the embedder alone is ~19 MB.
  const wasm = await fetchPinned(modelBase, ORT_FILES.wasm, fetchFn);
  const detector = await fetchPinned(modelBase, ORT_FILES.detector, fetchFn);
  const embedder = await fetchPinned(modelBase, ORT_FILES.embedder, fetchFn);
  const models = await loadOrtModels({ wasm, detector, embedder });
  return {
    async read(photo) {
      const { pixels, toSource } = await decodePhoto(photo, decoder);
      return readFaces(pixels, models, toSource);
    },
  };
}
