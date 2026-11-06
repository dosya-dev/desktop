import { describe, it, expect, vi, beforeEach } from "vitest";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { currentDir, currentLocale, initMainI18n, onMainLocaleChange, setMainLocale, tMain, tMainPlain, translateExternal } from "./i18n";

let dir: string;
const onDisk = () => JSON.parse(readFileSync(join(dir, "locale.json"), "utf8")).locale;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "main-i18n-"));
  await initMainI18n(dir);
});

describe("setMainLocale", () => {
  it("two calls fired without awaiting end on the second value in memory and file", async () => {
    const a = setMainLocale("de");
    const b = setMainLocale("fr");
    await Promise.all([a, b]);
    expect(currentLocale()).toBe("fr");
    expect(onDisk()).toBe("fr");
    expect(readdirSync(dir)).toEqual(["locale.json"]);
  });

  it("a throwing listener does not stop the next one or reject the call", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const second = vi.fn();
    const off1 = onMainLocaleChange(() => {
      throw new Error("boom");
    });
    const off2 = onMainLocaleChange(second);
    await expect(setMainLocale("es")).resolves.toBeUndefined();
    expect(second).toHaveBeenCalledWith("es");
    expect(currentLocale()).toBe("es");
    expect(onDisk()).toBe("es");
    off1();
    off2();
    err.mockRestore();
  });

  it("an invalid value rejects and leaves memory and file unchanged", async () => {
    await setMainLocale("tr");
    const listener = vi.fn();
    const off = onMainLocaleChange(listener);
    await expect(setMainLocale("xx")).rejects.toThrow();
    await expect(setMainLocale(5)).rejects.toThrow();
    expect(currentLocale()).toBe("tr");
    expect(onDisk()).toBe("tr");
    expect(listener).not.toHaveBeenCalled();
    off();
  });
});

describe("translateExternal", () => {
  it("translates engine text into the current language and follows a switch", async () => {
    await setMainLocale("en");
    expect(translateExternal("Sync folder not found: /x")).toBe("Sync folder not found: /x");
    await setMainLocale("tr");
    expect(translateExternal("Sync folder not found: /x")).toBe("Senkronizasyon klasörü bulunamadı: /x");
    expect(translateExternal("Uploaded invoice-0042.pdf")).toBe("Uploaded invoice-0042.pdf");
    await setMainLocale("en");
    expect(translateExternal("Sync folder not found: /x")).toBe("Sync folder not found: /x");
  });
});

describe("direction", () => {
  it("currentDir follows setMainLocale", async () => {
    await setMainLocale("he");
    expect(currentDir()).toBe("rtl");
    await setMainLocale("de");
    expect(currentDir()).toBe("ltr");
    await setMainLocale("fa");
    expect(currentDir()).toBe("rtl");
    await setMainLocale("en");
    expect(currentDir()).toBe("ltr");
  });

  it("tMain isolates {summary} in ar, tMainPlain does not, and en isolates nothing", async () => {
    await setMainLocale("ar");
    const isolated = tMain("tray.label.syncSummary", { summary: "3 files" });
    expect(isolated).toContain("\u20683 files\u2069");
    expect(tMainPlain("tray.label.syncSummary", { summary: "3 files" })).not.toMatch(/[\u200E\u200F\u2066-\u2069]/);
    // The same Arabic sentence, only without the isolates.
    expect(tMainPlain("tray.label.syncSummary", { summary: "3 files" })).toBe(isolated.replace(/[\u2066-\u2069]/g, ""));
    await setMainLocale("en");
    expect(tMain("tray.label.syncSummary", { summary: "3 files" })).toBe("Sync: 3 files");
  });

  it("translateExternal isolates a captured path in ar and not in en", async () => {
    await setMainLocale("ar");
    expect(translateExternal("Sync folder not found: /x")).toContain("\u2068/x\u2069");
    await setMainLocale("en");
    expect(translateExternal("Sync folder not found: /x")).toBe("Sync folder not found: /x");
  });
});
