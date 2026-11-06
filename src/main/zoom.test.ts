import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { clampZoom, createZoomSaver, readZoom, writeZoom, ZOOM_FILE, ZOOM_MAX, ZOOM_MIN } from "./zoom.ts";

test("clampZoom keeps the factor in range and turns junk into 100%", () => {
  assert.equal(clampZoom(1.5), 1.5);
  assert.equal(clampZoom(0.1), ZOOM_MIN);
  assert.equal(clampZoom(12), ZOOM_MAX);
  for (const junk of [NaN, Infinity, -2, 0, "2", null, undefined, {}]) assert.equal(clampZoom(junk), 1);
});

test("the zoom survives a restart, and a missing or broken file means 100%", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dosya-zoom-"));
  assert.equal(readZoom(dir), 1);
  writeZoom(dir, 1.75);
  assert.equal(readZoom(dir), 1.75);
  writeZoom(dir, 9);
  assert.equal(readZoom(dir), ZOOM_MAX);
  await writeFile(join(dir, ZOOM_FILE), "{not json");
  assert.equal(readZoom(dir), 1);
});

test("a pinch's many updates become one write of the last value", async () => {
  const writes: number[] = [];
  const save = createZoomSaver("/unused", 20, (_dir, f) => { writes.push(f); });
  for (const f of [1.1, 1.2, 1.3, 1.4]) save(f);
  assert.deepEqual(writes, []);
  await new Promise((r) => setTimeout(r, 60));
  assert.deepEqual(writes, [1.4]);
});
