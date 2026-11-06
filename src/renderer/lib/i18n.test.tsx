// The renderer's language provider: useT/useLocale re-render in place when the
// language changes, the module-level t follows, and a change goes through the
// main process exactly once. Same createRoot + act style as the other
// component tests here.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, memo, useState } from "react";
import { createPortal } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { I18nProvider, currentDir, formatters, onLocaleChange, t, tPlain, translateExternal, translateIpcError, useDir, useLocale, useT } from "./i18n";
import type { Locale } from "../../i18n/locales";

const setLocaleIpc = vi.fn<(l: Locale) => Promise<void>>();

let api: { setLocale: Locale | null } = { setLocale: null };
let mountCount = 0;

function Label() {
  const tt = useT();
  const [id] = useState(() => ++mountCount);
  return (
    <span data-testid="label" data-mount={id}>
      {tt("common.cancel")}
    </span>
  );
}

// A dialog that is already open when the language changes: portalled out of
// the tree and memoised, so only its own subscription can update it.
const Dialog = memo(function Dialog() {
  const tt = useT();
  return createPortal(<div role="dialog">{tt("common.cancel")}</div>, document.body);
});

let picker: ReturnType<typeof useLocale> | null = null;
function Picker() {
  picker = useLocale();
  return <span data-testid="locale">{picker.locale}</span>;
}

describe("I18nProvider", () => {
  let root: Root | null = null;
  let container: HTMLDivElement;

  beforeAll(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    mountCount = 0;
    api = { setLocale: null };
    setLocaleIpc.mockReset();
    setLocaleIpc.mockImplementation(async (l) => {
      api.setLocale = l;
    });
    (window as unknown as { electronAPI: unknown }).electronAPI = { setLocale: setLocaleIpc };
  });

  afterEach(() => {
    act(() => root?.unmount());
    root = null;
    container.remove();
    document.querySelectorAll("[role=dialog]").forEach((n) => n.remove());
  });

  const mount = async (initial: Locale = "en", initialMessages?: Record<string, string>) => {
    await act(async () => {
      root = createRoot(container);
      root.render(
        <I18nProvider initial={initial} initialMessages={initialMessages}>
          <Label />
          <Dialog />
          <Picker />
        </I18nProvider>,
      );
    });
  };
  const label = () => container.querySelector<HTMLElement>("[data-testid=label]")!;
  const dialog = () => document.querySelector<HTMLElement>("[role=dialog]")!;

  it("renders English, then Turkish after setLocale without remounting", async () => {
    await mount();
    expect(label().textContent).toBe("Cancel");
    expect(label().dataset.mount).toBe("1");

    await act(async () => picker!.setLocale("tr"));
    expect(label().textContent).toBe("İptal");
    expect(label().dataset.mount).toBe("1");
    expect(container.querySelector("[data-testid=locale]")!.textContent).toBe("tr");
  });

  it("updates an open dialog's text in place", async () => {
    await mount();
    const before = dialog();
    expect(before.textContent).toBe("Cancel");
    await act(async () => picker!.setLocale("de"));
    expect(dialog()).toBe(before);
    expect(dialog().textContent).toBe("Abbrechen");
  });

  it("asks the main process once and is a no-op for the current language", async () => {
    await mount();
    await act(async () => picker!.setLocale("fr"));
    expect(setLocaleIpc).toHaveBeenCalledTimes(1);
    expect(setLocaleIpc).toHaveBeenCalledWith("fr");

    await act(async () => picker!.setLocale("fr"));
    expect(setLocaleIpc).toHaveBeenCalledTimes(1);
  });

  it("keeps the old language when the main process refuses", async () => {
    await mount();
    setLocaleIpc.mockRejectedValueOnce(new Error("nope"));
    await act(async () => {
      await picker!.setLocale("tr").catch(() => {});
    });
    expect(label().textContent).toBe("Cancel");
    expect(t("common.cancel")).toBe("Cancel");
  });

  it("starts in the initial language with no English first frame", async () => {
    const tr = (await import("../../i18n/messages/tr.json")).default as Record<string, string>;
    await mount("tr", tr);
    expect(label().textContent).toBe("İptal");
    expect(t("common.cancel")).toBe("İptal");
  });

  it("keeps the module-level t, listeners and formatters on the current language", async () => {
    await mount();
    const seen: Locale[] = [];
    const off = onLocaleChange((l) => seen.push(l));
    const fmt = formatters();
    expect(t("common.cancel")).toBe("Cancel");

    await act(async () => picker!.setLocale("es"));
    expect(t("common.cancel")).toBe("Cancelar");
    expect(seen).toEqual(["es"]);
    expect(document.documentElement.lang).toBe("es");
    // A held formatters() object follows the switch too.
    expect(fmt.formatNumber(1234.5)).toBe(new Intl.NumberFormat("es").format(1234.5));

    off();
    await act(async () => picker!.setLocale("en"));
    expect(seen).toEqual(["es"]);
    expect(t("common.cancel")).toBe("Cancel");
  });

  it("translateExternal follows the current language and leaves unknown text alone", async () => {
    await mount();
    expect(translateExternal("Sync folder not found: /x")).toBe("Sync folder not found: /x");

    await act(async () => picker!.setLocale("tr"));
    expect(translateExternal("Sync folder not found: /x")).toBe("Senkronizasyon klasörü bulunamadı: /x");
    expect(translateExternal("Uploaded invoice-0042.pdf")).toBe("Uploaded invoice-0042.pdf");

    await act(async () => picker!.setLocale("en"));
    expect(translateExternal("Sync folder not found: /x")).toBe("Sync folder not found: /x");
  });

  it("translateIpcError translates the engine's message inside Electron's IPC wrapper", async () => {
    const wrapped = "Error invoking remote method 'sync:add-pair': Error: Sync folder not found: /x";
    await mount();
    expect(translateIpcError(wrapped)).toBe(wrapped);

    await act(async () => picker!.setLocale("tr"));
    expect(translateIpcError(wrapped)).toBe("Senkronizasyon klasörü bulunamadı: /x");
    expect(translateIpcError("Sync folder not found: /x")).toBe("Senkronizasyon klasörü bulunamadı: /x");
    const unknown = "Error invoking remote method 'sync:add-pair': Error: boom";
    expect(translateIpcError(unknown)).toBe(unknown);
  });
});

describe("direction", () => {
  let root: Root | null = null;
  let container: HTMLDivElement;
  let dirSeen: { dir: string; renders: number } = { dir: "", renders: 0 };
  function DirProbe() {
    const dir = useDir();
    dirSeen = { dir, renders: dirSeen.renders + 1 };
    return null;
  }
  const FSI = "\u2068";

  beforeAll(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    dirSeen = { dir: "", renders: 0 };
    (window as unknown as { electronAPI: unknown }).electronAPI = { setLocale: vi.fn(async () => {}) };
  });
  afterEach(() => {
    act(() => root?.unmount());
    root = null;
    container.remove();
  });

  const mount = async (initial: Locale, initialMessages?: Record<string, string>) => {
    await act(async () => {
      root = createRoot(container);
      root.render(
        <I18nProvider initial={initial} initialMessages={initialMessages}>
          <DirProbe />
          <Picker />
        </I18nProvider>,
      );
    });
  };

  it("ar boots rtl, en boots ltr, and html lang and dir agree", async () => {
    const ar = (await import("../../i18n/messages/ar.json")).default as Record<string, string>;
    await mount("ar", ar);
    expect(dirSeen.dir).toBe("rtl");
    expect(currentDir()).toBe("rtl");
    expect(document.documentElement.dir).toBe("rtl");
    expect(document.documentElement.lang).toBe("ar");
    await act(async () => picker!.setLocale("en"));
    expect(document.documentElement.dir).toBe("ltr");
    expect(document.documentElement.lang).toBe("en");
  });

  it("useDir re-renders on a switch", async () => {
    await mount("en");
    expect(dirSeen.dir).toBe("ltr");
    const before = dirSeen.renders;
    await act(async () => picker!.setLocale("he"));
    expect(dirSeen.dir).toBe("rtl");
    expect(dirSeen.renders).toBeGreaterThan(before);
    await act(async () => picker!.setLocale("de"));
    expect(dirSeen.dir).toBe("ltr");
  });

  it("t isolates a plain argument in ar, tPlain never does", async () => {
    const ar = (await import("../../i18n/messages/ar.json")).default as Record<string, string>;
    await mount("ar", ar);
    expect(t("editor.label.copyName", { name: "notes", count: 1 })).toContain(FSI);
    expect(tPlain("editor.label.copyName", { name: "notes", count: 1 })).not.toMatch(/[\u200E\u200F\u2066-\u2069]/);
  });

  it("t in en has no isolate", async () => {
    await mount("en");
    expect(t("editor.label.copyName", { name: "notes", count: 1 })).toBe("notes (copy)");
  });

  it("an ar select argument is not isolated and still picks its branch", async () => {
    const ar = (await import("../../i18n/messages/ar.json")).default as Record<string, string>;
    await mount("ar", ar);
    const out = t("files.error.fileTypeExtensionIsNotInTheAllowedList", { hasExtension: "yes", extension: "png" });
    expect(out).toContain("png");
    expect(out).not.toContain("بلا امتداد");
  });

  it("translateExternal in ar isolates a captured path, en does not", async () => {
    const ar = (await import("../../i18n/messages/ar.json")).default as Record<string, string>;
    await mount("ar", ar);
    expect(translateExternal("Sync folder not found: /x")).toContain(`${FSI}/x\u2069`);
    await mount("en");
    expect(translateExternal("Sync folder not found: /x")).toBe("Sync folder not found: /x");
  });
});
