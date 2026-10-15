#!/usr/bin/env node
// Runs the store-bundle verifier against an already-built .app from the command
// line, so CI can check the bundle at a point of its own choosing rather than
// only inside electron-builder's own hook:
//
//   node scripts/verify-store-bundle-cli.mjs release/mas-universal/dosya.app
//
// Every problem is printed as its own ::error:: line, which is what makes them
// show up on the job summary and annotated in the diff instead of buried in a
// log, and the exit code fails the step.
import { verifyStoreBundle } from "./verify-store-bundle.mjs";

const appPath = process.argv[2];
if (!appPath) {
  console.error("::error::usage: node scripts/verify-store-bundle-cli.mjs <path/to/dosya.app>");
  process.exit(1);
}

const problems = verifyStoreBundle({ appPath });
if (problems.length > 0) {
  for (const problem of problems) console.error(`::error::${problem}`);
  process.exit(1);
}
console.log(`[store-bundle] verified ${appPath}`);
