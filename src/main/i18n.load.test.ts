import { describe, it, expect, vi, beforeEach } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Danish stands in for a language whose chunk will not load (a broken install).
vi.mock("../i18n/loaders", async (importOriginal) => {
  const real = await importOriginal<typeof import("../i18n/loaders")>();
  return { LOADERS: { ...real.LOADERS, da: () => Promise.reject(new Error("chunk missing")) } };
});

const { currentDir, currentLocale, initMainI18n, setMainLocale, tMain } = await import("./i18n");

let dir: string;
const onDisk = () => JSON.parse(readFileSync(join(dir, "locale.json"), "utf8")).locale;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "main-i18n-load-"));
});

describe("main loads one language at a time", () => {
  it("loads the stored language at start and translates with it", async () => {
    writeFileSync(join(dir, "locale.json"), JSON.stringify({ locale: "sv" }));
    await initMainI18n(dir);
    expect(currentLocale()).toBe("sv");
    expect(tMain("menus.label.file.menu")).toBe(JSON.parse(readFileSync(join(__dirname, "../i18n/messages/sv.json"), "utf8"))["menus.label.file.menu"]);
  });

  it("starts in English when the stored language will not load", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    writeFileSync(join(dir, "locale.json"), JSON.stringify({ locale: "da" }));
    await initMainI18n(dir);
    expect(currentLocale()).toBe("en");
    expect(tMain("menus.label.file.menu")).toBe("File");
    err.mockRestore();
  });

  it("refuses a language that will not load and keeps the saved choice", async () => {
    await initMainI18n(dir);
    await setMainLocale("fi");
    await expect(setMainLocale("da")).rejects.toThrow("chunk missing");
    expect(currentLocale()).toBe("fi");
    expect(onDisk()).toBe("fi");
  });

  it("a failing load keeps the previous locale and its direction", async () => {
    await initMainI18n(dir);
    await setMainLocale("he");
    expect(currentDir()).toBe("rtl");
    await expect(setMainLocale("da")).rejects.toThrow("chunk missing");
    expect(currentLocale()).toBe("he");
    expect(currentDir()).toBe("rtl");
    await setMainLocale("fi");
    await expect(setMainLocale("da")).rejects.toThrow("chunk missing");
    expect(currentDir()).toBe("ltr");
  });
});
