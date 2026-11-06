// Language switches racing a slow chunk load, and a chunk that fails to load
// at startup. Its own file so the message chunks can be mocked: tr.json waits
// on a gate the test opens, es.json always fails.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { Locale } from "../../i18n/locales";

const gate = vi.hoisted(() => {
  let open!: () => void;
  const promise = new Promise<void>((r) => (open = r));
  return { promise, open };
});
vi.mock("../../i18n/messages/tr.json", async () => {
  await gate.promise;
  return { default: { "common.cancel": "İptal" } };
});
const gateAr = vi.hoisted(() => {
  let open!: () => void;
  const promise = new Promise<void>((r) => (open = r));
  return { promise, open };
});
vi.mock("../../i18n/messages/ar.json", async () => {
  await gateAr.promise;
  return { default: { "common.cancel": "إلغاء" } };
});
vi.mock("../../i18n/messages/he.json", async () => {
  throw new Error("chunk failed");
});
vi.mock("../../i18n/messages/es.json", async () => {
  throw new Error("chunk failed");
});

import { I18nProvider, currentDir, loadStartupMessages, useDir, useLocale, useT } from "./i18n";

const setLocaleIpc = vi.fn<(l: Locale) => Promise<void>>(async () => {});

let picker: ReturnType<typeof useLocale> | null = null;
function Probe() {
  picker = useLocale();
  const t = useT();
  return <span data-testid="label">{t("common.cancel")}</span>;
}

describe("i18n races", () => {
  let root: Root | null = null;
  let container: HTMLDivElement;

  beforeAll(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    setLocaleIpc.mockClear();
    (window as unknown as { electronAPI: unknown }).electronAPI = { setLocale: setLocaleIpc };
  });

  afterEach(() => {
    act(() => root?.unmount());
    root = null;
    container.remove();
  });

  it("a pick of the current language cancels a pending switch and tells main", async () => {
    await act(async () => {
      root = createRoot(container);
      root.render(
        <I18nProvider initial="en">
          <Probe />
        </I18nProvider>,
      );
    });
    let first!: Promise<void>;
    await act(async () => {
      first = picker!.setLocale("tr"); // IPC resolves, the tr chunk waits on the gate
    });
    await act(async () => picker!.setLocale("en"));
    await act(async () => {
      gate.open();
      await first;
    });
    const label = container.querySelector("[data-testid=label]")!;
    expect(label.textContent).toBe("Cancel");
    expect(picker!.locale).toBe("en");
    expect(setLocaleIpc.mock.calls.map((c) => c[0])).toEqual(["tr", "en"]);

    // Nothing pending now: picking the current language is a no-op again.
    await act(async () => picker!.setLocale("en"));
    expect(setLocaleIpc).toHaveBeenCalledTimes(2);
  });

  it("starts in English when the saved language's messages fail to load", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const start = await loadStartupMessages("es");
    expect(start.locale).toBe("en");
    expect(start.messages["common.cancel"]).toBe("Cancel");
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });

  describe("direction", () => {
    const mountEn = async () => {
      await act(async () => {
        root = createRoot(container);
        root.render(
          <I18nProvider initial="en">
            <Probe />
          </I18nProvider>,
        );
      });
    };
    const html = () => [document.documentElement.lang, document.documentElement.dir];

    it("a slow ar load landing after a later en pick leaves lang and dir on en", async () => {
      await mountEn();
      let first!: Promise<void>;
      await act(async () => {
        first = picker!.setLocale("ar"); // IPC resolves, the ar chunk waits on its gate
      });
      expect(html()).toEqual(["en", "ltr"]);
      await act(async () => picker!.setLocale("en"));
      await act(async () => {
        gateAr.open();
        await first;
      });
      expect(html()).toEqual(["en", "ltr"]);
      expect(currentDir()).toBe("ltr");
      expect(container.querySelector("[data-testid=label]")!.textContent).toBe("Cancel");
    });

    it("A then B ends with B's dir", async () => {
      gate.open();
      gateAr.open();
      await mountEn();
      await act(async () => picker!.setLocale("ar"));
      expect(html()).toEqual(["ar", "rtl"]);
      await act(async () => picker!.setLocale("tr"));
      expect(html()).toEqual(["tr", "ltr"]);
      await act(async () => picker!.setLocale("ar"));
      await act(async () => picker!.setLocale("en"));
      expect(html()).toEqual(["en", "ltr"]);
    });

    it("a rejected he loader leaves lang, dir and text unchanged", async () => {
      gateAr.open();
      await mountEn();
      await act(async () => picker!.setLocale("ar"));
      const err = vi.spyOn(console, "error").mockImplementation(() => {});
      await act(async () => {
        await picker!.setLocale("he").catch(() => {});
      });
      expect(html()).toEqual(["ar", "rtl"]);
      expect(container.querySelector("[data-testid=label]")!.textContent).toBe("إلغاء");
      err.mockRestore();
    });

    it("a rejected he loader tells main the old language again, so the menus and the next launch match the window", async () => {
      gateAr.open();
      await mountEn();
      await act(async () => picker!.setLocale("ar"));
      setLocaleIpc.mockClear();
      const err = vi.spyOn(console, "error").mockImplementation(() => {});
      await act(async () => {
        await picker!.setLocale("he").catch(() => {});
      });
      expect(setLocaleIpc.mock.calls.map((c) => c[0])).toEqual(["he", "ar"]);
      err.mockRestore();
    });

    it("boot with ar messages has dir rtl on the first commit", async () => {
      const seen: string[] = [];
      function Spy() {
        seen.push(document.documentElement.dir);
        return null;
      }
      await act(async () => {
        root = createRoot(container);
        root.render(
          <I18nProvider initial="ar" initialMessages={{ "common.cancel": "إلغاء" }}>
            <Spy />
          </I18nProvider>,
        );
      });
      expect(seen[0]).toBe("rtl");
    });

    it("a subscriber called during the switch already sees both lang and dir", async () => {
      gateAr.open();
      const seen: string[][] = [];
      function Watch() {
        useDir();
        seen.push(html());
        return null;
      }
      await act(async () => {
        root = createRoot(container);
        root.render(
          <I18nProvider initial="en">
            <Probe />
            <Watch />
          </I18nProvider>,
        );
      });
      seen.length = 0;
      await act(async () => picker!.setLocale("ar"));
      expect(seen.length).toBeGreaterThan(0);
      for (const s of seen) expect(s).toEqual(["ar", "rtl"]);
    });
  });
});
