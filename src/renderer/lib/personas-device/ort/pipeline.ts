// Ported from apps/web/src/lib/personas-device/ort/pipeline.ts - keep the two in step.
//
// The face reader's image work, ported from packages/face-reader/src/lib.rs so
// ONNX Runtime can run the models: letterbox the photo for YuNet, decode
// YuNet's outputs (OpenCV FaceDetectorYN), align each face to SFace's 112x112
// frame (OpenCV FaceRecognizerSF) and L2-normalise the signature.
//
// Faces read here and faces read by the Rust reader land in the same index,
// so this must match it: same constants, same sampling, same order. The
// parity test (pipeline.parity.test.ts) holds the two together. Arithmetic
// that decides which source pixels are used (spans, floors) is done in
// float32 with Math.fround, as Rust does it.
//
// Pure functions over pixels: no DOM, no ONNX Runtime import.

/** YuNet input side; the long side of the photo is resampled to this. */
export const DETECT_SIZE = 320;
/** YuNet confidence floor (lib.rs MIN_SCORE). */
export const MIN_SCORE = 0.89;
/** Faces narrower or shorter than this in the source are dropped. */
export const MIN_FACE_PX = 40;
/** SFace input side. */
export const EMBED_SIZE = 112;
/** SFace feature length. */
export const VECTOR_LEN = 128;
/** Floats per face in readFaces' output: x, y, w, h, score, then the signature. */
export const FACE_STRIDE = 5 + VECTOR_LEN;

const NMS_IOU = 0.3;
const STRIDES = [8, 16, 32] as const;
/** SFace's landmark positions in its 112x112 input (OpenCV FaceRecognizerSF::alignCrop). */
const SFACE_REFERENCE: readonly (readonly [number, number])[] = [
  [38.2946, 51.6963],
  [73.5318, 51.5014],
  [56.0252, 71.7366],
  [41.5493, 92.3655],
  [70.7299, 92.2041],
];
const F32_EPSILON = 1.1920929e-7;
const f = Math.fround;
const MIN_SCORE_F32 = f(MIN_SCORE);

/** 8-bit pixels, RGB (3 channels) or RGBA (4; alpha ignored). */
export interface Pixels {
  px: Uint8Array | Uint8ClampedArray;
  width: number;
  height: number;
  channels: 3 | 4;
}

export interface DetectedFace {
  x: number;
  y: number;
  w: number;
  h: number;
  score: number;
  /** Right eye, left eye, nose tip, right and left mouth corner. */
  landmarks: [number, number][];
}

export function checkPixels(img: Pixels): void {
  if (img.channels !== 3 && img.channels !== 4) throw new Error(`channels must be 3 or 4, got ${img.channels}`);
  if (!(img.width > 0 && img.height > 0)) throw new Error(`empty image ${img.width}x${img.height}`);
  if (img.px.length !== img.width * img.height * img.channels) {
    throw new Error(`pixel buffer is ${img.px.length} bytes, expected ${img.width}x${img.height}x${img.channels}`);
  }
}

/** Bilinear sample with integer pixel centres; outside the image reads 0 (OpenCV warpAffine, INTER_LINEAR + BORDER_CONSTANT). */
function bilinear(img: Pixels, x: number, y: number, c: number): number {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = x - x0;
  const fy = y - y0;
  const { px, width, height, channels } = img;
  const get = (xi: number, yi: number) => (xi < 0 || yi < 0 || xi >= width || yi >= height ? 0 : px[(yi * width + xi) * channels + c]);
  const top = get(x0, y0) * (1 - fx) + get(x0 + 1, y0) * fx;
  const bottom = get(x0, y0 + 1) * (1 - fx) + get(x0 + 1, y0 + 1) * fx;
  return top * (1 - fy) + bottom * fy;
}

/**
 * The photo resampled so its long side is DETECT_SIZE, top-left in a zeroed
 * square, as BGR float planes 0..255 (YuNet's input). Downscaling averages
 * each target pixel's source footprint; upscaling is bilinear.
 */
export function letterbox(img: Pixels): { input: Float32Array; scale: number } {
  const s = DETECT_SIZE;
  const scale = f(s / Math.max(img.width, img.height));
  const nw = Math.min(s, Math.max(1, Math.round(f(img.width * scale))));
  const nh = Math.min(s, Math.max(1, Math.round(f(img.height * scale))));
  const out = new Float32Array(3 * s * s);
  const plane = s * s;
  const { px, width, channels } = img;

  if (scale < 1) {
    const span = (t: number, len: number): [number, number] => {
      const a = Math.min(Math.floor(f(t / scale)), len - 1);
      const b = Math.min(Math.max(Math.floor(f((t + 1) / scale)), a + 1), len);
      return [a, b];
    };
    const xs: [number, number][] = [];
    for (let tx = 0; tx < nw; tx++) xs.push(span(tx, img.width));
    for (let ty = 0; ty < nh; ty++) {
      const [y0, y1] = span(ty, img.height);
      for (let tx = 0; tx < nw; tx++) {
        const [x0, x1] = xs[tx];
        let r = 0;
        let g = 0;
        let b = 0;
        for (let y = y0; y < y1; y++) {
          let p = (y * width + x0) * channels;
          for (let x = x0; x < x1; x++, p += channels) {
            r += px[p];
            g += px[p + 1];
            b += px[p + 2];
          }
        }
        const n = (y1 - y0) * (x1 - x0);
        const o = ty * s + tx;
        out[o] = b / n;
        out[plane + o] = g / n;
        out[2 * plane + o] = r / n;
      }
    }
  } else {
    for (let ty = 0; ty < nh; ty++) {
      const sy = Math.min(Math.max((ty + 0.5) / scale - 0.5, 0), img.height - 1);
      for (let tx = 0; tx < nw; tx++) {
        const sx = Math.min(Math.max((tx + 0.5) / scale - 0.5, 0), img.width - 1);
        const o = ty * s + tx;
        out[o] = bilinear(img, sx, sy, 2);
        out[plane + o] = bilinear(img, sx, sy, 1);
        out[2 * plane + o] = bilinear(img, sx, sy, 0);
      }
    }
  }
  return { input: out, scale };
}

function iou(a: DetectedFace, b: DetectedFace): number {
  const ix = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const iy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  if (ix <= 0 || iy <= 0) return 0;
  const inter = ix * iy;
  return inter / (a.w * a.h + b.w * b.h - inter);
}

const clamp01 = (v: number) => Math.min(Math.max(v, 0), 1);

/**
 * One anchor cell's candidate in detector pixels, or null below the score
 * floor or for any non-finite value (lib.rs decode_cell).
 */
export function decodeCell(cls: number, obj: number, bbox: ArrayLike<number>, kps: ArrayLike<number>, row: number, col: number, stride: number): DetectedFace | null {
  // In float32, as lib.rs compares it: a score a hair under 0.89 in float64
  // can be >= 0.89f32.
  const score = f(Math.sqrt(f(clamp01(f(cls)) * clamp01(f(obj)))));
  if (!(score >= MIN_SCORE_F32)) return null;
  const cx = (col + bbox[0]) * stride;
  const cy = (row + bbox[1]) * stride;
  const w = Math.exp(bbox[2]) * stride;
  const h = Math.exp(bbox[3]) * stride;
  const landmarks: [number, number][] = [];
  for (let n = 0; n < 5; n++) landmarks.push([(kps[2 * n] + col) * stride, (kps[2 * n + 1] + row) * stride]);
  const finite = [cx, cy, w, h, ...landmarks.flat()].every(Number.isFinite);
  return finite ? { x: cx - w / 2, y: cy - h / 2, w, h, score, landmarks } : null;
}

/** YuNet's twelve outputs by name: cls_/obj_/bbox_/kps_ for strides 8, 16 and 32. */
export type YunetOutputs = Record<string, ArrayLike<number>>;

/** YuNet's outputs to faces in source pixels, best score first (lib.rs detect). */
export function decodeYunet(outs: YunetOutputs, scale: number, width: number, height: number): DetectedFace[] {
  const s = DETECT_SIZE;
  const found: DetectedFace[] = [];
  for (const stride of STRIDES) {
    const cls = outs[`cls_${stride}`];
    const obj = outs[`obj_${stride}`];
    const bbox = outs[`bbox_${stride}`];
    const kps = outs[`kps_${stride}`];
    const cols = s / stride;
    const cells = cols * cols;
    if (!cls || !obj || !bbox || !kps || cls.length !== cells || obj.length !== cells || bbox.length !== cells * 4 || kps.length !== cells * 10) {
      throw new Error(`YuNet stride ${stride} output sizes do not match a ${s}px input`);
    }
    for (let idx = 0; idx < cells; idx++) {
      const b = Array.prototype.slice.call(bbox, idx * 4, idx * 4 + 4) as number[];
      const k = Array.prototype.slice.call(kps, idx * 10, idx * 10 + 10) as number[];
      const face = decodeCell(cls[idx], obj[idx], b, k, Math.floor(idx / cols), idx % cols, stride);
      if (face) found.push(face);
    }
  }
  // Stable, like Rust's sort_by: equal scores keep their cell order.
  found.sort((a, b) => b.score - a.score);
  const kept: DetectedFace[] = [];
  for (const face of found) if (kept.every((k) => iou(k, face) <= NMS_IOU)) kept.push(face);

  const out: DetectedFace[] = [];
  for (const k of kept) {
    const x0 = Math.min(Math.max(k.x / scale, 0), width);
    const y0 = Math.min(Math.max(k.y / scale, 0), height);
    const x1 = Math.min(Math.max((k.x + k.w) / scale, 0), width);
    const y1 = Math.min(Math.max((k.y + k.h) / scale, 0), height);
    const w = x1 - x0;
    const h = y1 - y0;
    if (w < MIN_FACE_PX || h < MIN_FACE_PX) continue;
    out.push({ x: x0, y: y0, w, h, score: k.score, landmarks: k.landmarks.map(([x, y]) => [x / scale, y / scale]) });
  }
  return out;
}

/** Least-squares similarity transform taking src onto dst: u = a*x - b*y + tx, v = b*x + a*y + ty. */
export function similarity(src: readonly (readonly [number, number])[], dst: readonly (readonly [number, number])[]): [number, number, number, number] {
  const n = src.length;
  const mean = (p: readonly (readonly [number, number])[]) => {
    let sx = 0;
    let sy = 0;
    for (const q of p) {
      sx += q[0];
      sy += q[1];
    }
    return [sx / n, sy / n];
  };
  const ms = mean(src);
  const md = mean(dst);
  let numA = 0;
  let numB = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    const sx = src[i][0] - ms[0];
    const sy = src[i][1] - ms[1];
    const dx = dst[i][0] - md[0];
    const dy = dst[i][1] - md[1];
    numA += sx * dx + sy * dy;
    numB += sx * dy - sy * dx;
    den += sx * sx + sy * sy;
  }
  den = Math.max(den, F32_EPSILON);
  const a = numA / den;
  const b = numB / den;
  return [a, b, md[0] - (a * ms[0] - b * ms[1]), md[1] - (b * ms[0] + a * ms[1])];
}

/** The face warped to SFace's 112x112 frame, as RGB float planes 0..255 (SFace's input). */
export function alignInput(img: Pixels, landmarks: readonly (readonly [number, number])[]): Float32Array {
  const e = EMBED_SIZE;
  const [a, b, tx, ty] = similarity(landmarks, SFACE_REFERENCE);
  const det = Math.max(a * a + b * b, F32_EPSILON);
  const plane = e * e;
  const input = new Float32Array(3 * plane);
  for (let v = 0; v < e; v++) {
    for (let u = 0; u < e; u++) {
      const du = u - tx;
      const dv = v - ty;
      const sx = (a * du + b * dv) / det;
      const sy = (-b * du + a * dv) / det;
      const o = v * e + u;
      for (let c = 0; c < 3; c++) input[c * plane + o] = bilinear(img, sx, sy, c);
    }
  }
  return input;
}

/** The feature divided by its length. */
export function l2Normalize(feat: ArrayLike<number>): Float32Array {
  if (feat.length !== VECTOR_LEN) throw new Error(`SFace returned ${feat.length} floats`);
  let sum = 0;
  for (let i = 0; i < feat.length; i++) sum += feat[i] * feat[i];
  const norm = Math.max(Math.sqrt(sum), F32_EPSILON);
  const out = new Float32Array(VECTOR_LEN);
  for (let i = 0; i < VECTOR_LEN; i++) out[i] = feat[i] / norm;
  return out;
}

/** The two models, however they are run. */
export interface FaceModels {
  /** YuNet on a 1x3x320x320 BGR input; outputs by name. */
  detect(input: Float32Array): Promise<YunetOutputs>;
  /** SFace on `n` faces at once (n x 3 x 112 x 112 RGB); n x 128 raw floats. */
  embed(input: Float32Array, n: number): Promise<ArrayLike<number>>;
}

/** Faces per SFace run: a photo of a crowd goes through in runs of this many. */
export const EMBED_BATCH = 16;

/**
 * Every face in the photo, FACE_STRIDE floats each (x, y, w, h, score, then
 * the L2-normalised signature), boxes multiplied by `toSource` so they are in
 * the encoded image's pixels - the Rust reader's output format.
 */
export async function readFaces(img: Pixels, models: FaceModels, toSource: [number, number] = [1, 1]): Promise<Float32Array> {
  checkPixels(img);
  const { input, scale } = letterbox(img);
  const faces = decodeYunet(await models.detect(input), scale, img.width, img.height);
  const out = new Float32Array(faces.length * FACE_STRIDE);
  const [sx, sy] = toSource;
  const one = 3 * EMBED_SIZE * EMBED_SIZE;
  for (let start = 0; start < faces.length; start += EMBED_BATCH) {
    const group = faces.slice(start, start + EMBED_BATCH);
    const batch = new Float32Array(group.length * one);
    group.forEach((face, i) => batch.set(alignInput(img, face.landmarks), i * one));
    const feats = await models.embed(batch, group.length);
    if (feats.length !== group.length * VECTOR_LEN) throw new Error(`SFace returned ${feats.length} floats for ${group.length} faces`);
    group.forEach((face, i) => {
      const sig = l2Normalize(Array.prototype.slice.call(feats, i * VECTOR_LEN, (i + 1) * VECTOR_LEN) as number[]);
      const o = (start + i) * FACE_STRIDE;
      out.set([face.x * sx, face.y * sy, face.w * sx, face.h * sy, face.score], o);
      out.set(sig, o + 5);
    });
  }
  return out;
}
