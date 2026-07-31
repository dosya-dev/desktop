import { describe, it, expect, afterEach } from "vitest";
import { isMasBuild } from "./mas";

// Electron's types declare `process.mas` as a required boolean, so a plain
// `delete process.mas` does not typecheck. Go through a structural view where
// the property is optional - that is what a non-MAS build actually looks like
// at runtime, where Electron never sets it at all.
const proc = process as unknown as { mas?: boolean };
const original = proc.mas;

afterEach(() => {
  if (original === undefined) delete proc.mas;
  else proc.mas = original;
});

describe("isMasBuild", () => {
  it("is false in a normal build, where Electron never sets process.mas", () => {
    delete proc.mas;
    expect(isMasBuild()).toBe(false);
  });

  it("is true when Electron marks the build as Mac App Store", () => {
    proc.mas = true;
    expect(isMasBuild()).toBe(true);
  });
});
