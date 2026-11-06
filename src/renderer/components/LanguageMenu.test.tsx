// The titlebar language menu and the Profile language switch: both list every
// shipped language by its own name (no flags), render in production builds too, and a pick
// goes through useLocale's setLocale.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const setLocale = vi.hoisted(() => vi.fn(async () => {}));
const state = vi.hoisted(() => ({ locale: "en", dir: "ltr" as "ltr" | "rtl" }));
vi.mock("@/lib/i18n", async () => {
  const { makeT } = await import("../../i18n/translator");
  const en = (await import("../../i18n/messages/en.json")).default as Record<string, string>;
  const t = makeT("en", en, en);
  return { useLocale: () => ({ locale: state.locale, setLocale }), useT: () => t, useDir: () => state.dir };
});

import { LanguageMenu } from "./LanguageMenu";
import { LanguageSwitch } from "./LanguageSwitch";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const shipped = JSON.parse(readFileSync(resolve(__dirname, "../../i18n/shipped.json"), "utf8")) as string[];

describe("LanguageMenu", () => {
  let root: Root | null = null;
  let container: HTMLDivElement;

  beforeAll(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(() => {
    // A packaged build: nothing here may depend on the dev server.
    vi.stubEnv("DEV", false);
    vi.stubEnv("PROD", true);
  });

  afterEach(() => {
    state.locale = "en";
    state.dir = "ltr";
    act(() => root?.unmount());
    container.remove();
    setLocale.mockClear();
    vi.unstubAllEnvs();
  });

  const mount = async (node: React.ReactNode = <LanguageMenu />) => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => root!.render(node));
  };
  const trigger = () => container.querySelector<HTMLButtonElement>("button[aria-haspopup]")!;
  const items = () => [...container.querySelectorAll<HTMLButtonElement>("[role=menuitemradio]")];

  it("shows the active language and lists every language by its own name", async () => {
    await mount();
    expect(trigger().textContent).toBe("en");
    expect(trigger().getAttribute("aria-label")).toBe("Language: English");

    await act(async () => trigger().click());
    const { LOCALES, LOCALE_LABELS } = await import("../../i18n/locales");
    // Each row is the language's own name, nothing before it.
    const names = items().map((b) => b.querySelector("span[lang]")?.textContent);
    expect(names).toEqual(LOCALES.map((l) => LOCALE_LABELS[l]));
    // The first languages keep their order; a regional variant sits right after the language it varies.
    expect(names.slice(0, 22)).toEqual([
      "English", "Türkçe", "Deutsch", "Français", "Français (Canada)", "Español", "Español (Latinoamérica)", "Italiano", "Polski",
      "Português (Brasil)", "Português (Portugal)", "Nederlands", "Svenska", "Dansk", "Norsk bokmål", "Suomi", "Čeština", "Română",
      "Magyar", "Ελληνικά", "Bahasa Indonesia", "Tiếng Việt",
    ]);
    for (const name of ["Українська", "Српски", "Русский"]) expect(names).toContain(name);
    expect(names).toContain("简体中文");
    expect(items().map((b) => b.textContent)[names.indexOf("简体中文")]).toBe("简体中文");
    expect(items()[0].getAttribute("aria-checked")).toBe("true");
    // No flags: the only svg in the list is the active row's check mark.
    expect(items().filter((b) => b.getAttribute("aria-checked") !== "true" && b.querySelector("svg")).map((b) => b.textContent)).toEqual([]);
    expect(items()[0].querySelectorAll("svg")).toHaveLength(1);
    expect(trigger().querySelector("svg")).toBeNull();
    expect(container.textContent).not.toContain("preview");
  });

  it("picks a language and closes", async () => {
    await mount();
    await act(async () => trigger().click());
    await act(async () => items()[2].click());
    expect(setLocale).toHaveBeenCalledWith("de");
    expect(items()).toHaveLength(0);
  });

  it("closes on Escape without picking", async () => {
    await mount();
    await act(async () => trigger().click());
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });
    expect(items()).toHaveLength(0);
    expect(setLocale).not.toHaveBeenCalled();
  });

  it("renders the Profile picker as a field naming the language, opening the same list", async () => {
    await mount(<LanguageSwitch />);
    expect(trigger().textContent).toBe("English");
    expect(trigger().getAttribute("data-testid")).toBe("language-field-button");
    expect(container.textContent).not.toContain("packages/i18n");
    expect(container.textContent).not.toContain("preview");
    await act(async () => trigger().click());
    expect(items().length).toBeGreaterThanOrEqual(19);
    await act(async () => items()[1].click());
    expect(setLocale).toHaveBeenCalledWith("tr");
    expect(items()).toHaveLength(0);
  });

  it("caps the open list's height so 19 languages scroll instead of running off the window", async () => {
    await mount();
    await act(async () => trigger().click());
    const menu = container.querySelector("[role=menu]")!;
    expect(menu.className).toContain("overflow-y-auto");
    expect(menu.className).toMatch(/max-h-/);
  });

  it("lists the three right-to-left languages, each label with its own lang and dir, and no flag", async () => {
    await mount();
    await act(async () => trigger().click());
    const row = (name: string) => items().find((b) => b.textContent?.includes(name))!;
    for (const [id, name, dir] of [["ar", "العربية", "rtl"], ["he", "עברית", "rtl"], ["fa", "فارسی", "rtl"], ["de", "Deutsch", "ltr"]] as const) {
      const label = row(name).querySelector<HTMLElement>("span[lang]")!;
      expect(label.textContent).toBe(name);
      expect(label.getAttribute("lang")).toBe(id);
      expect(label.getAttribute("dir")).toBe(dir);
      expect(row(name).querySelector("svg")).toBeNull();
      // Sized to its text, so an rtl name lines up at the inline start with the others.
      expect(label.className).not.toContain("flex-1");
      expect(row(name).textContent).toBe(name);
    }
  });

  describe("align", () => {
    const open = async (node: React.ReactNode) => {
      await mount(node);
      await act(async () => trigger().click());
      return container.querySelector<HTMLElement>("[role=menu]")!;
    };
    // The panel's class string before the logical conversion, for align="left" and "right".
    const OLD = (side: "left-0" | "right-0") =>
      `anim-pop-in absolute top-full z-50 mt-1 max-h-[min(70vh,30rem)] overflow-y-auto rounded-lg border bg-[var(--color-bg)] p-1 shadow-lg ${side} w-52`;

    it('align="start" in en is the old left anchoring, align="end" the old right one', async () => {
      const start = await open(<LanguageMenu align="start" />);
      expect(start.className).toBe(OLD("left-0").replace("left-0", "inset-s-0"));
      expect(start.style.transformOrigin).toBe("top left");
      act(() => root?.unmount());
      container.remove();
      const end = await open(<LanguageMenu align="end" />);
      expect(end.className).toBe(OLD("right-0").replace("right-0", "inset-e-0"));
      expect(end.style.transformOrigin).toBe("top right");
    });

    it('align="end" in ar anchors at the inline end and grows from the left edge', async () => {
      state.locale = "ar";
      state.dir = "rtl";
      const end = await open(<LanguageMenu align="end" />);
      expect(end.className).toContain("inset-e-0");
      expect(end.className).not.toMatch(/\b(left|right)-0\b/);
      expect(end.style.transformOrigin).toBe("top left");
    });
  });
});

describe("LanguageMenu names only", () => {
  beforeAll(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  it("renders every shipped language's name, with no svg flag inside the language rows, and the ar row has lang=ar", async () => {
    const { LOCALE_LABELS } = await import("../../i18n/locales");
    const el = document.createElement("div");
    document.body.appendChild(el);
    const r = createRoot(el);
    await act(async () => r.render(<LanguageMenu />));
    await act(async () => el.querySelector<HTMLButtonElement>("button[aria-haspopup]")!.click());
    const rows = [...el.querySelectorAll<HTMLButtonElement>("[role=menuitemradio]")];
    const names = rows.map((b) => b.querySelector("span[lang]")?.textContent);
    for (const code of ["en", ...shipped]) expect(names, code).toContain(LOCALE_LABELS[code as keyof typeof LOCALE_LABELS]);
    expect(rows.filter((b) => b.getAttribute("aria-checked") !== "true" && b.querySelector("svg")).map((b) => b.textContent)).toEqual([]);
    const ar = rows.find((b) => b.textContent === "العربية")!;
    expect(ar.querySelector("span[lang]")!.getAttribute("lang")).toBe("ar");
    expect(ar.querySelector("span[lang]")!.getAttribute("dir")).toBe("rtl");
    act(() => r.unmount());
    el.remove();
  });
});
