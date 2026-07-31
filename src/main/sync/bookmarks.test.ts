import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { acquireFolderAccess, setElectronApp } from "./bookmarks";

// Electron types `process.mas` as a required boolean; a non-MAS build simply
// never sets it. Go through a structural view so it can be removed as well as
// assigned.
const proc = process as unknown as { mas?: boolean };
const original = proc.mas;

function setMas(v: boolean | undefined): void {
  if (v === undefined) delete proc.mas;
  else proc.mas = v;
}

afterEach(() => {
  setMas(original);
  setElectronApp(null);
});

describe("acquireFolderAccess outside a store build", () => {
  beforeEach(() => setMas(undefined));

  it("succeeds with a no-op release, because plain paths already work", () => {
    const res = acquireFolderAccess(undefined);
    expect(res.ok).toBe(true);
    if (res.ok) expect(() => res.release()).not.toThrow();
  });
});

describe("acquireFolderAccess in a store build", () => {
  beforeEach(() => setMas(true));

  it("reports no-bookmark when the pair was saved before bookmarks existed", () => {
    expect(acquireFolderAccess(undefined)).toEqual({ ok: false, reason: "no-bookmark" });
  });

  it("reports stale when macOS refuses to resolve the bookmark", () => {
    setElectronApp({
      startAccessingSecurityScopedResource: () => {
        throw new Error("bad bookmark");
      },
    });
    expect(acquireFolderAccess("Ym9va21hcms=")).toEqual({ ok: false, reason: "stale" });
  });

  it("returns the stop function macOS handed back", () => {
    const stop = vi.fn();
    setElectronApp({ startAccessingSecurityScopedResource: () => stop });
    const res = acquireFolderAccess("Ym9va21hcms=");
    expect(res.ok).toBe(true);
    if (res.ok) {
      res.release();
      expect(stop).toHaveBeenCalledTimes(1);
    }
  });

  it("releases only once even if called twice", () => {
    const stop = vi.fn();
    setElectronApp({ startAccessingSecurityScopedResource: () => stop });
    const res = acquireFolderAccess("Ym9va21hcms=");
    if (res.ok) {
      res.release();
      res.release();
    }
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it("swallows a throw from the stop function so teardown never crashes", () => {
    setElectronApp({
      startAccessingSecurityScopedResource: () => () => {
        throw new Error("already gone");
      },
    });
    const res = acquireFolderAccess("Ym9va21hcms=");
    expect(res.ok).toBe(true);
    if (res.ok) expect(() => res.release()).not.toThrow();
  });
});
