// Ported from apps/web/src/lib/heic.worker.ts - keep in sync with the web copy.
/// <reference lib="webworker" />

import { decodeHeicToRgba } from './heic-decode';

interface DecodeRequest {
  id: number;
  url: string;
  maxDim: number;
}

async function toBitmap(blob: Blob): Promise<ImageBitmap> {
  try {
    // Safari decodes HEIC natively, so it never pays for the WASM at all.
    return await createImageBitmap(blob);
  } catch {
    // Everyone else: ~1.4MB of real-WASM libheif, fetched only now - i.e.
    // only when a HEIC is actually on screen in a browser that can't decode
    // it natively.
    const { data, width, height } = await decodeHeicToRgba(await blob.arrayBuffer());
    // `ImageData` requires a `Uint8ClampedArray<ArrayBuffer>` specifically
    // (not the wider ArrayBufferLike that a bare `Uint8ClampedArray` type
    // resolves to). `data` is always backed by a real ArrayBuffer (freshly
    // allocated in decodeHeicToRgba), so this is a type-only cast, not a
    // copy - copying here would double peak transient memory for a full-size
    // RGBA buffer (a 12MP photo is ~48MB) for no runtime benefit.
    const imageData = new ImageData(data as Uint8ClampedArray<ArrayBuffer>, width, height);
    // Can't drawImage() an ImageData directly; round-trip it through a bitmap.
    return await createImageBitmap(imageData);
  }
}

async function decode(url: string, maxDim: number): Promise<Blob> {
  const res = await fetch(url, { credentials: 'include' });
  if (!res.ok) throw new Error(`Failed to fetch HEIC: HTTP ${res.status}`);

  const bitmap = await toBitmap(await res.blob());
  try {
    const scale = Math.min(1, maxDim / Math.max(bitmap.width, bitmap.height));
    const w = Math.max(1, Math.round(bitmap.width * scale));
    const h = Math.max(1, Math.round(bitmap.height * scale));

    const canvas = new OffscreenCanvas(w, h);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('OffscreenCanvas 2D context unavailable');
    ctx.drawImage(bitmap, 0, 0, w, h);

    // Downscale before encoding: a full-size 12MP RGBA bitmap is ~48MB, and a
    // grid can hold dozens. Only the small JPEG is ever handed back.
    return await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.85 });
  } finally {
    bitmap.close();
  }
}

self.onmessage = async (e: MessageEvent<DecodeRequest>) => {
  const { id, url, maxDim } = e.data;
  try {
    const blob = await decode(url, maxDim);
    self.postMessage({ id, blob });
  } catch (err) {
    self.postMessage({ id, error: err instanceof Error ? err.message : String(err) });
  }
};
