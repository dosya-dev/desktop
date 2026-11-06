// @vitest-environment node
// Ported from apps/web/src/lib/personas-device/ort/choose.test.ts - keep the two in step.
//
import { describe, expect, it, vi } from 'vitest';
import { IntegrityError, type PhotoReader } from '../read-core';
import { chooseReader } from './choose';
import type { Decoder } from './decode';

const decoder = {} as Decoder;
const ortReader: PhotoReader = { read: async () => new Float32Array() };
const tractReader: PhotoReader = { read: () => new Float32Array() };

describe('chooseReader', () => {
  it('runs ONNX Runtime where the platform can decode in a worker', async () => {
    const loadTract = vi.fn(async () => tractReader);
    expect(await chooseReader({ decoder, loadOrt: async () => ortReader, loadTract })).toEqual({ reader: ortReader, ort: true });
    expect(loadTract).not.toHaveBeenCalled();
  });

  it('runs tract where it cannot', async () => {
    const loadOrt = vi.fn(async () => ortReader);
    expect(await chooseReader({ decoder: null, loadOrt, loadTract: async () => tractReader })).toEqual({ reader: tractReader, ort: false });
    expect(loadOrt).not.toHaveBeenCalled();
  });

  it('falls back to tract when ONNX Runtime cannot start here', async () => {
    const r = await chooseReader({ decoder, loadOrt: async () => { throw new WebAssembly.CompileError('bad'); }, loadTract: async () => tractReader });
    expect(r).toEqual({ reader: tractReader, ort: false });
  });

  it('a download or SHA-256 failure is the reader being unavailable, not a reason to fetch tract', async () => {
    const loadTract = vi.fn(async () => tractReader);
    await expect(chooseReader({ decoder, loadOrt: async () => { throw new IntegrityError('x', 'a', 'b'); }, loadTract })).rejects.toBeInstanceOf(IntegrityError);
    await expect(chooseReader({ decoder, loadOrt: async () => { throw new Error('face reader file x: HTTP 503'); }, loadTract })).rejects.toThrow(/HTTP 503/);
    expect(loadTract).not.toHaveBeenCalled();
  });
});
