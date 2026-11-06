#!/usr/bin/env node
// Vendor the bundled e2ee package dists INTO apps/desktop so the app is fully
// self-contained.
//
// WHY: CI (.github/workflows/sync-public-repos.yml -> `sync-desktop`) pushes
// ONLY `apps/desktop/` to the public desktop repo, with apps/desktop as the
// repo ROOT. In that repo there is no `../../packages/` sibling, so an
// electron-vite alias or tsconfig path pointing there resolves in the monorepo
// and fails everywhere else. Same reason apps/web/scripts/vendor-e2ee.mjs and
// scripts/vendor-audio-player.mjs exist.
//
// Each package's dist is a single esbuild bundle (all third-party deps and
// e2ee-core inlined) plus emitted .d.ts files; the whole dist is copied so the
// type re-exports (index.d.ts -> ./api.js, e2ee-client -> @dosya-dev/e2ee-core)
// resolve.
//
// On-device Personas rides along, the same way apps/web/scripts/vendor-personas.mjs
// does it:
// - packages/personas-engine/dist -> vendor/personas-engine: the engine as one
//   ESM bundle plus .d.ts. @dosya-dev/e2ee-core stays an EXTERNAL import there,
//   so it resolves to vendor/e2ee-core above and the crypto backend is shared.
//   Build it first: (cd packages/personas-engine && npm run build)
// - packages/face-reader/dist/face_reader.{js,d.ts} -> vendor/face-reader: the
//   wasm-bindgen glue only. The 15 MB face_reader_bg.wasm is NOT vendored; the
//   reader worker fetches it from /api/personas/models/face_reader_bg.wasm and
//   checks its SHA-256 before instantiating it with initSync. The glue's
//   default-init fallback, `new URL('face_reader_bg.wasm', import.meta.url)`,
//   is replaced with a throw so no bundler goes looking for the absent wasm.
//
// MONOREPO-ONLY step: reads ../../packages/*/dist (build them first) and writes
// the committed apps/desktop/vendor artifact. Re-run whenever the e2ee packages,
// the Personas engine or the face reader change, then commit vendor/.
import { cpSync, rmSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const deskRoot = resolve(here, '..');
const packages = ['e2ee-core', 'e2ee-client'];

for (const name of packages) {
  const src = resolve(deskRoot, '../../packages', name, 'dist');
  if (!existsSync(src)) {
    console.error(`✖ missing ${src} - build the package first: (cd packages/${name} && npm run build)`);
    process.exit(1);
  }
  const dest = resolve(deskRoot, 'vendor', name);
  rmSync(dest, { recursive: true, force: true });
  cpSync(src, dest, { recursive: true });
  console.log(`✓ vendored ${name} -> apps/desktop/vendor/${name}`);
}

// The Personas engine.
const engineDist = resolve(deskRoot, '../../packages/personas-engine/dist');
if (!existsSync(resolve(engineDist, 'index.js'))) {
  console.error(`✖ missing ${engineDist} - build it first: (cd packages/personas-engine && npm run build)`);
  process.exit(1);
}
const engineDest = resolve(deskRoot, 'vendor', 'personas-engine');
rmSync(engineDest, { recursive: true, force: true });
cpSync(engineDist, engineDest, { recursive: true });
console.log('✓ vendored personas-engine -> apps/desktop/vendor/personas-engine');

// The face reader glue.
const readerDist = resolve(deskRoot, '../../packages/face-reader/dist');
const readerDest = resolve(deskRoot, 'vendor', 'face-reader');
const FALLBACK = "module_or_path = new URL('face_reader_bg.wasm', import.meta.url);";
const glue = readFileSync(resolve(readerDist, 'face_reader.js'), 'utf8');
if (glue.split(FALLBACK).length !== 2) {
  console.error('✖ face_reader.js: the default-init wasm URL is not there exactly once; update this script');
  process.exit(1);
}
rmSync(readerDest, { recursive: true, force: true });
mkdirSync(readerDest, { recursive: true });
writeFileSync(
  resolve(readerDest, 'face_reader.js'),
  glue.replace(FALLBACK, "throw new Error('face_reader: pass the verified wasm module to initSync');"),
);
cpSync(resolve(readerDist, 'face_reader.d.ts'), resolve(readerDest, 'face_reader.d.ts'));
console.log('✓ vendored face-reader glue -> apps/desktop/vendor/face-reader');
