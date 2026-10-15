import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installQuickAction } from "./macos-services.ts";

/**
 * The Quick Action is a workflow bundle written into ~/Library/Services. The
 * App Sandbox refuses that write, and pbs cannot be run from a sandboxed app,
 * so the Mac App Store build must not even try: a failed attempt logs an error
 * on every launch and installs nothing.
 */
test("the store build installs no Quick Action", { skip: process.platform !== "darwin" }, () => {
  const servicesDir = mkdtempSync(join(tmpdir(), "services-"));
  try {
    installQuickAction({ distribution: "mas", servicesDir });
    assert.deepEqual(readdirSync(servicesDir), []);
  } finally {
    rmSync(servicesDir, { recursive: true, force: true });
  }
});

test("the direct build writes the workflow bundle", { skip: process.platform !== "darwin" }, () => {
  const servicesDir = mkdtempSync(join(tmpdir(), "services-"));
  try {
    installQuickAction({ distribution: "direct", servicesDir });
    const entries = readdirSync(servicesDir);
    assert.equal(entries.length, 1);
    assert.match(entries[0], /\.workflow$/);
  } finally {
    rmSync(servicesDir, { recursive: true, force: true });
  }
});
