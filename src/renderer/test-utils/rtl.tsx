// Renders a component under a chosen UI language, the way main.tsx boots one:
// the locale's messages are loaded first, so the first commit already has the
// right text and document.documentElement.dir.
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { I18nProvider, loadMessages } from "@/lib/i18n";
import type { Locale } from "../../i18n/locales";

export interface RenderResult {
  container: HTMLDivElement;
  rerender(ui: ReactNode): Promise<void>;
  unmount(): void;
}

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

export async function renderInLocale(ui: ReactNode, locale: Locale): Promise<RenderResult> {
  const messages = await loadMessages(locale);
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  const wrap = (node: ReactNode) => (
    <I18nProvider initial={locale} initialMessages={messages}>
      {node}
    </I18nProvider>
  );
  await act(async () => root.render(wrap(ui)));
  return {
    container,
    rerender: async (next) => {
      await act(async () => root.render(wrap(next)));
    },
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}
