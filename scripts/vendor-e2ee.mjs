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
// MONOREPO-ONLY step: reads ../../packages/*/dist (build them first) and writes
// the committed apps/desktop/vendor artifact. Re-run whenever the e2ee packages
// change, then commit vendor/.
import { cpSync, rmSync, existsSync } from 'node:fs';
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
