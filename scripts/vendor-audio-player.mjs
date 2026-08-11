#!/usr/bin/env node
// Vendor packages/audio-player's SOURCE into apps/desktop so the app is fully
// self-contained.
//
// WHY: same reason apps/web/scripts/vendor-audio-player.mjs exists. CI
// (sync-public-repos.yml -> `sync-desktop`) pushes ONLY `apps/desktop/` to the
// public desktop repo, with apps/desktop as the repo ROOT. In that repo there
// is no `../../packages/` sibling, so an electron-vite alias or tsconfig path
// pointing there resolves in the monorepo and fails to resolve anywhere else.
//
// Unlike the e2ee packages this one has no build step - it is plain
// TypeScript with no third-party dependency - so the vendored artifact is
// simply its src/ tree, which Vite compiles as ordinary project source.
//
// This is a MONOREPO-ONLY step. Re-run it whenever packages/audio-player
// changes, then commit vendor/.
import { cpSync, rmSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const deskRoot = resolve(here, '..');
const src = resolve(deskRoot, '../../packages/audio-player/src');

if (!existsSync(src)) {
  console.error(`✖ missing ${src}`);
  process.exit(1);
}

const dest = resolve(deskRoot, 'vendor/audio-player');
rmSync(dest, { recursive: true, force: true });
// Tests stay in the package - vendoring them would put them in the app's
// vitest include and run the same assertions twice.
cpSync(src, dest, { recursive: true, filter: (p) => !p.endsWith('.test.ts') });
console.log('✓ vendored audio-player -> apps/desktop/vendor/audio-player');
