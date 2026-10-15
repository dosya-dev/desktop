import { test } from "node:test";
import assert from "node:assert/strict";
import { collectAcknowledgements, licenseOf } from "./acknowledgements.mjs";

const fs = (files) => (p) => (p in files ? files[p] : null);

test("collects name, version, license and the LICENSE text, sorted by name", () => {
  const read = fs({
    "node_modules/zustand/package.json": JSON.stringify({ version: "5.0.12", license: "MIT" }),
    "node_modules/zustand/LICENSE": "MIT License\n\nCopyright (c) 2019 Paul Henschel\n",
    "node_modules/react/package.json": JSON.stringify({ version: "19.2.5", license: "MIT" }),
    "node_modules/react/LICENSE": "MIT License\n",
  });
  const list = collectAcknowledgements({ dependencies: { zustand: "^5", react: "^19" }, read });
  assert.deepEqual(list.map((a) => a.name), ["react", "zustand"]);
  assert.equal(list[1].version, "5.0.12");
  assert.equal(list[1].license, "MIT");
  assert.equal(list[1].text, "MIT License\n\nCopyright (c) 2019 Paul Henschel");
});

test("first-party packages are excluded and a package that is not installed is skipped", () => {
  const read = fs({
    "node_modules/sonner/package.json": JSON.stringify({ version: "2.0.7", license: "MIT" }),
  });
  const list = collectAcknowledgements({
    dependencies: { "@dosya-dev/shared": "file:../x", sonner: "^2", ghost: "^1" },
    read,
    exclude: ["@dosya-dev/shared"],
  });
  assert.deepEqual(list.map((a) => a.name), ["sonner"]);
});

test("a missing LICENSE file leaves text null but keeps the SPDX id", () => {
  const read = fs({ "node_modules/pmtiles/package.json": JSON.stringify({ version: "4.5.0", license: "BSD-3-Clause" }) });
  const [a] = collectAcknowledgements({ dependencies: { pmtiles: "^4" }, read });
  assert.equal(a.license, "BSD-3-Clause");
  assert.equal(a.text, null);
});

test("licenseOf reads the legacy shapes too", () => {
  assert.equal(licenseOf({ license: "ISC" }), "ISC");
  assert.equal(licenseOf({ license: { type: "MIT", url: "x" } }), "MIT");
  assert.equal(licenseOf({ licenses: [{ type: "MIT" }, { type: "Apache-2.0" }] }), "MIT OR Apache-2.0");
  assert.equal(licenseOf({}), "Unknown");
});
