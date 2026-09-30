import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { buildFileProviderAddon, nodeApiIncludeDir } from "./build-file-provider-addon.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

/** The addon is Swift compiled by swiftc; there is nothing to test without it. */
function toolchain() {
  if (process.platform !== "darwin") return false;
  try {
    execFileSync("xcrun", ["--find", "swiftc"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function sessionSwift() {
  return readFileSync(
    join(here, "..", "native", "macos", "DosyaFileProvider", "Sources", "DosyaFileProviderCore", "Session.swift"),
    "utf8",
  );
}

test("the Node-API headers declare everything the addon calls", () => {
  const include = nodeApiIncludeDir();
  // node_api.h carries the Node-specific surface, js_native_api.h the engine
  // one, and the addon uses both. Checking one representative call from each is
  // enough to catch a headers package that resolved to the wrong thing.
  assert.ok(readFileSync(join(include, "node_api.h"), "utf8").includes("napi_create_async_work"));
  assert.ok(readFileSync(join(include, "js_native_api.h"), "utf8").includes("napi_create_function"));
});

test("the addon builds universal and loads", { skip: !toolchain() }, () => {
  const out = mkdtempSync(join(tmpdir(), "dosya-addon-"));
  try {
    const built = buildFileProviderAddon({ outDir: out });
    assert.ok(built);
    const archs = execFileSync("lipo", ["-archs", built], { encoding: "utf8" }).trim().split(/\s+/).sort();
    assert.deepEqual(archs, ["arm64", "x86_64"]);

    const addon = require(built);
    assert.equal(typeof addon.isSupported, "function");
    assert.equal(addon.isSupported(), true);

    // The keychain contract comes out of Session.swift, so a change there that
    // the extension and the app would disagree about fails here.
    const swift = sessionSwift();
    const declared = (name) => swift.match(new RegExp(`${name}\\s*=\\s*"([^"]+)"`))[1];
    assert.deepEqual(addon.contract(), {
      service: declared("keychainService"),
      account: declared("keychainAccount"),
      accessGroup: declared("accessGroupSuffix"),
      domainIdentifier: "dosya",
      domainDisplayName: "dosya.dev",
    });
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test("the session functions are present and fail honestly without an entitlement", { skip: !toolchain() }, () => {
  const out = mkdtempSync(join(tmpdir(), "dosya-addon-"));
  try {
    const addon = require(buildFileProviderAddon({ outDir: out }));

    for (const name of ["storedUserId", "writeSession", "clearSession"]) {
      assert.equal(typeof addon[name], "function", name);
    }

    // A payload the Swift side cannot decode must be refused at write time: it
    // is the last point that can say so, and the alternative is Finder asking
    // to sign in forever.
    assert.throws(() => addon.writeSession("not json"), /cannot read/i);
    assert.throws(() => addon.writeSession(JSON.stringify({ access: "a" })), /cannot read/i);
    assert.throws(() => addon.writeSession(), /JSON string/i);
    assert.throws(() => addon.writeSession(42), /JSON string/i);

    // This process is unsigned, so the data protection keychain refuses it with
    // errSecMissingEntitlement. The app must hear about that rather than
    // believe the session was stored.
    assert.throws(
      () => addon.writeSession(JSON.stringify({ access: "a", refresh: "r", apiBaseUrl: "http://x", userId: "u" })),
      /keychain/i,
    );

    // Reading is allowed to come up empty; it must never throw.
    assert.equal(addon.storedUserId(), null);
    addon.clearSession();
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test("the domain functions settle their promises", { skip: !toolchain() }, async () => {
  const out = mkdtempSync(join(tmpdir(), "dosya-addon-"));
  try {
    const addon = require(buildFileProviderAddon({ outDir: out }));

    for (const name of ["registerDomain", "removeDomain", "signalChanges"]) {
      assert.equal(typeof addon[name], "function", name);
    }

    // This process is not an app carrying a File Provider extension, so macOS
    // refuses the calls. What is under test is the plumbing: the work runs off
    // the JS thread, every promise settles on it, and nothing crashes.
    for (const name of ["registerDomain", "removeDomain", "signalChanges"]) {
      const result = await Promise.race([
        addon[name]().then(
          (v) => ({ settled: "resolved", v }),
          (e) => ({ settled: "rejected", e: String(e) }),
        ),
        new Promise((r) => setTimeout(() => r({ settled: "hung" }), 20000)),
      ]);
      assert.notEqual(result.settled, "hung", `${name} never settled`);
      if (result.settled === "resolved") assert.equal(typeof result.v, "boolean");
    }
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test("domainEnabled reports approval, and null when there is no domain", { skip: !toolchain() }, async () => {
  const out = mkdtempSync(join(tmpdir(), "dosya-addon-"));
  try {
    const addon = require(buildFileProviderAddon({ outDir: out }));
    assert.equal(typeof addon.domainEnabled, "function");

    // macOS holds a newly added domain DISABLED until the user approves the
    // extension in System Settings, and every sync job then fails with "Sync is
    // not enabled". Without reading this back, the app registers a location that
    // hangs and tells the user nothing.
    const result = await Promise.race([
      addon.domainEnabled().then(
        (v) => ({ settled: "resolved", v }),
        (e) => ({ settled: "rejected", e: String(e) }),
      ),
      new Promise((r) => setTimeout(() => r({ settled: "hung" }), 20000)),
    ]);
    assert.notEqual(result.settled, "hung");
    if (result.settled === "resolved") {
      assert.ok(result.v === null || typeof result.v === "boolean", `got ${String(result.v)}`);
    }
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});
