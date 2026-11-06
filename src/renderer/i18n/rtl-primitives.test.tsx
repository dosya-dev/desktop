// Shell primitives in a right-to-left language: the titlebar popups, the
// dialog shells, the toaster, the sidebar flyouts, the toggle knob and the
// global stylesheet. Every case also renders English, where the classes and
// props must be what they were before the conversion.
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { act, type ReactNode } from "react";
import { readFileSync } from "node:fs";
import path from "node:path";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderInLocale, type RenderResult } from "../test-utils/rtl";
// @ts-expect-error plain .mjs script without types
import { classify } from "../../../scripts/rtl-codemod.mjs";

const toasterProps = vi.hoisted(() => [] as Record<string, unknown>[]);
vi.mock("sonner", () => {
  const toast = Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), info: vi.fn(), message: vi.fn() });
  return {
    toast,
    Toaster: (props: Record<string, unknown>) => {
      toasterProps.push(props);
      return null;
    },
  };
});
vi.mock("@/lib/notifications-api", () => ({
  fetchSummary: vi.fn(async () => ({ unread: 3 })),
  fetchInbox: vi.fn(async () => ({ items: [], next_before: null })),
  markRead: vi.fn(async () => {}),
  markAllRead: vi.fn(async () => {}),
  dismiss: vi.fn(async () => {}),
}));
vi.mock("@/lib/auth-context", () => ({
  useAuth: () => ({ user: { id: "u1", name: "Test User", email: "test@dosya.dev" }, logout: vi.fn() }),
}));
vi.mock("@/lib/workspace-context", () => ({
  useWorkspace: () => ({ workspaces: [{ id: "w1", name: "Main" }], active: { id: "w1", name: "Main" }, setActive: vi.fn() }),
}));
vi.mock("@/lib/sync-store", () => ({
  useSyncPaused: () => false,
  useWorkspaceSyncSummaryKey: () => "",
  useSyncStore: { getState: () => ({ status: null }) },
}));
vi.mock("@/lib/use-permissions", () => ({ usePermissions: () => ({ can: () => true }) }));
vi.mock("@/lib/use-narrow-window", () => ({ useNarrowWindow: () => false }));
vi.mock("@/lib/ipc", () => ({ ipc: { getPlatform: async () => "darwin" } }));
vi.mock("@/lib/api-client", () => ({
  api: { get: vi.fn(() => new Promise(() => {})), post: vi.fn(), put: vi.fn() },
  ApiError: class ApiError extends Error {},
}));

import { LanguageMenu } from "@/components/LanguageMenu";
import { ThemeMenu } from "@/components/ThemeMenu";
import { NotificationBell } from "@/components/notifications/NotificationBell";
import { FinderLocationToggle } from "@/components/FinderLocationToggle";
import { Modal } from "@/components/files/Modal";
import { ConfirmDialog } from "@/components/text-editor/ConfirmDialog";
import { Notice, VaultButton, VaultCard, VaultInput, VaultLabel } from "@/components/vault/ui";
import { AppToaster } from "@/components/layout/AppToaster";
import { Sidebar } from "@/components/layout/Sidebar";
import { useUiStore } from "@/lib/ui-store";

let view: RenderResult | null = null;

beforeAll(() => {
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    getApiBase: async () => "http://127.0.0.1",
    fileProvider: { status: async () => ({ available: true, enabled: false }), setEnabled: vi.fn(), link: vi.fn(), openSettings: vi.fn() },
  };
});

afterEach(() => {
  view?.unmount();
  view = null;
  useUiStore.setState({ sidebarCollapsed: false });
  toasterProps.length = 0;
});

const shell = (node: ReactNode) => (
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <MemoryRouter initialEntries={["/dashboard"]}>{node}</MemoryRouter>
  </QueryClientProvider>
);

async function render(node: ReactNode, locale: "ar" | "en"): Promise<HTMLElement> {
  view = await renderInLocale(shell(node), locale);
  return view.container;
}

async function click(el: Element | null): Promise<void> {
  expect(el).not.toBeNull();
  await act(async () => (el as HTMLElement).click());
}

/** Class tokens under `root` that the codemod would convert to a logical form. */
function physicalClasses(root: Element): string[] {
  const out: string[] = [];
  for (const el of [root, ...Array.from(root.querySelectorAll("*"))]) {
    if (el.closest('[dir="ltr"]')) continue;
    for (const c of (el.getAttribute("class") ?? "").split(/\s+/).filter(Boolean)) {
      if (classify(c)?.kind === "convertible") out.push(c);
    }
  }
  return out;
}

describe("titlebar popups", () => {
  // The panels' class strings as they stood before this task, align="end".
  const LANGUAGE_PANEL =
    "anim-pop-in absolute top-full z-50 mt-1 max-h-[min(70vh,30rem)] overflow-y-auto rounded-lg border bg-[var(--color-bg)] p-1 shadow-lg inset-e-0 w-52";
  const THEME_PANEL = "anim-popover absolute top-full z-50 mt-1 w-60 rounded-lg border bg-[var(--color-bg)] p-3 shadow-lg inset-e-0";
  const BELL_PANEL =
    "anim-pop-in absolute inset-e-0 top-full z-50 mt-2 flex max-h-[70vh] w-80 flex-col overflow-hidden rounded-xl border shadow-xl";
  // Before: "absolute right-0.5 top-0.5 ..." and "absolute -right-0.5 -top-0.5 ...", one token now logical.
  const THEME_CHECK = "absolute inset-e-0.5 top-0.5 text-[var(--color-primary)]";
  const BELL_BADGE =
    "absolute -inset-e-0.5 -top-0.5 flex h-3.5 min-w-3.5 items-center justify-center rounded-full px-1 text-[9px] font-bold text-[var(--color-primary-fg)]";

  async function openLanguage(locale: "ar" | "en"): Promise<HTMLElement> {
    const c = await render(<LanguageMenu align="end" />, locale);
    await click(c.querySelector("[data-testid=language-menu-button]"));
    return c.querySelector<HTMLElement>("[role=menu]")!;
  }
  async function openTheme(locale: "ar" | "en"): Promise<HTMLElement> {
    const c = await render(<ThemeMenu align="end" />, locale);
    await click(c.querySelector("button"));
    return c.querySelector<HTMLElement>(".anim-popover")!;
  }
  async function openBell(locale: "ar" | "en"): Promise<HTMLElement> {
    const c = await render(<NotificationBell align="end" />, locale);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    await click(c.querySelector("[data-testid=open-notifications]"));
    return c;
  }

  it("LanguageMenu anchors at the inline end in ar and is unchanged in en", async () => {
    const ar = await openLanguage("ar");
    expect(document.documentElement.dir).toBe("rtl");
    expect(ar.className).toContain("inset-e-0");
    expect(physicalClasses(view!.container)).toEqual([]);
    view!.unmount();
    view = null;
    expect((await openLanguage("en")).className).toBe(LANGUAGE_PANEL);
  });

  it("ThemeMenu panel and its check mark are logical in ar and unchanged in en", async () => {
    const ar = await openTheme("ar");
    expect(ar.className).toContain("inset-e-0");
    expect(ar.querySelector("svg.lucide-check")?.getAttribute("class")).toContain("inset-e-0.5");
    expect(physicalClasses(view!.container)).toEqual([]);
    view!.unmount();
    view = null;
    const en = await openTheme("en");
    expect(en.className).toBe(THEME_PANEL);
    expect(en.querySelector("svg.lucide-check")?.getAttribute("class")).toBe(`lucide lucide-check ${THEME_CHECK}`);
  });

  it("NotificationBell panel and badge are logical in ar and unchanged in en", async () => {
    const ar = await openBell("ar");
    expect(ar.querySelector("[data-testid=notification-dropdown]")!.className).toContain("inset-e-0");
    expect(ar.querySelector("[data-testid=notification-badge]")!.className).toContain("-inset-e-0.5");
    expect(physicalClasses(ar)).toEqual([]);
    view!.unmount();
    view = null;
    const en = await openBell("en");
    expect(en.querySelector("[data-testid=notification-dropdown]")!.className).toBe(BELL_PANEL);
    expect(en.querySelector("[data-testid=notification-badge]")!.className).toBe(BELL_BADGE);
  });

  it("the LanguageMenu field puts its chevron at the inline end, with no physical class", async () => {
    const c = await render(<LanguageMenu variant="field" align="start" />, "ar");
    const button = c.querySelector<HTMLElement>("[data-testid=language-field-button]")!;
    const last = button.lastElementChild!;
    expect(last.getAttribute("class")).toContain("lucide-chevron-down");
    expect(last.getAttribute("class")).toContain("ms-auto");
    expect(physicalClasses(c)).toEqual([]);
    await click(button);
    expect(c.querySelector("[role=menu]")!.className).toContain("inset-s-0");
  });
});

describe("dialog shells", () => {
  it("Modal, ConfirmDialog and the Vault controls render no physical class in ar", async () => {
    const c = await render(
      <>
        <Modal onClose={() => {}}>body</Modal>
        <ConfirmDialog
          id="confirm"
          title="t"
          description="d"
          detail="x"
          actions={[{ label: "a", onClick: () => {} }, { label: "b", onClick: () => {}, tone: "danger" }, { label: "c", onClick: () => {}, tone: "primary" }]}
          onCancel={() => {}}
        />
        <VaultCard>
          <VaultLabel>l</VaultLabel>
          <VaultInput />
          <VaultButton variant="outline" size="sm">b</VaultButton>
          <Notice tone="warn" icon={<span />}>n</Notice>
        </VaultCard>
      </>,
      "ar",
    );
    expect(c.querySelector("[data-testid=confirm]")).not.toBeNull();
    expect(physicalClasses(c)).toEqual([]);
  });
});

describe("toggle knob", () => {
  it("has an rtl twin for both resting positions", async () => {
    const c = await render(<FinderLocationToggle userId="u1" />, "ar");
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    const knob = c.querySelector('[role="switch"] > div')!;
    expect(knob.className).toContain("translate-x-0.5 rtl:-translate-x-0.5");
    expect(knob.className).not.toContain("translate-x-5");
  });
});

describe("toaster", () => {
  it("sits bottom-left with dir rtl in ar", async () => {
    await render(<AppToaster />, "ar");
    const props = toasterProps.at(-1)!;
    expect(props.position).toBe("bottom-left");
    expect(props.dir).toBe("rtl");
  });

  it("keeps the exact props it had in en", async () => {
    await render(<AppToaster />, "en");
    expect(toasterProps.at(-1)).toEqual({
      position: "bottom-right",
      toastOptions: {
        style: { fontFamily: "system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif" },
      },
    });
  });
});

describe("sidebar", () => {
  async function collapsedSidebar(locale: "ar" | "en"): Promise<HTMLElement> {
    useUiStore.setState({ sidebarCollapsed: true });
    return render(<Sidebar />, locale);
  }

  it("opens the Files and workspace flyouts toward the content in ar", async () => {
    const c = await collapsedSidebar("ar");
    await click(c.querySelector("[data-testid=nav-files]"));
    const files = c.querySelector<HTMLElement>("[data-testid=nav-files-flyout]")!;
    expect(files.style.right).not.toBe("");
    expect(files.style.left).toBe("");
    expect(files.style.transformOrigin).toBe("top right");
    await click(c.querySelector("[data-testid=workspace-switcher]"));
    const ws = c.querySelector<HTMLElement>("[data-testid=workspace-menu]")!;
    expect(ws.style.right).not.toBe("");
    expect(ws.style.left).toBe("");
  });

  it("keeps the flyouts' left placement in en", async () => {
    const c = await collapsedSidebar("en");
    await click(c.querySelector("[data-testid=nav-files]"));
    const files = c.querySelector<HTMLElement>("[data-testid=nav-files-flyout]")!;
    expect(files.style.left).toBe("6px");
    expect(files.style.right).toBe("");
    expect(files.style.transformOrigin).toBe("top left");
  });

  it("puts the collapse toggle on the inline end and renders no physical class in ar", async () => {
    const c = await render(<Sidebar />, "ar");
    const toggle = c.querySelector<HTMLElement>("[data-testid=sidebar-collapse-toggle]")!;
    expect(toggle.style.insetInlineEnd).toBe("-12px");
    expect(toggle.style.right).toBe("");
    await click(c.querySelector("[data-testid=nav-files-toggle]"));
    expect(physicalClasses(c)).toEqual([]);
  });
});

describe("global stylesheet", () => {
  const css = readFileSync(path.resolve(__dirname, "../styles/index.css"), "utf8");
  const flat = css.replace(/\s+/g, " ");

  it.each([
    '[dir="rtl"] :is(pre, code, kbd, samp):not([dir="auto"]) { direction: ltr; unicode-bidi: isolate; }',
    '[dir="rtl"] input:is([type=email], [type=url], [type=tel], [type=password], [type=number]) { direction: ltr; text-align: right; }',
    '[dir="rtl"] :is(input:not([type]), input[type=text], input[type=search], textarea) { unicode-bidi: plaintext; }',
    '[dir="rtl"] :is(.dp-report, .dp-keys-panel) { direction: rtl; }',
    ".ltr-value { direction: ltr; unicode-bidi: isolate; }",
    '[dir="rtl"] .ltr-value { text-align: right; }',
    "html:lang(ar) { --font-sans:",
    "html:lang(fa) { --font-sans:",
    "html:lang(he) { --font-sans:",
    '[dir="rtl"] .auth-step { animation-name: auth-step-fwd-rtl; }',
    '[dir="rtl"] [data-auth-dir="back"] .auth-step { animation-name: auth-step-back-rtl; }',
    "@keyframes auth-step-fwd-rtl { from { opacity: 0; transform: translate3d(-16px, 0, 0); }",
    "@keyframes auth-step-back-rtl { from { opacity: 0; transform: translate3d(16px, 0, 0); }",
    "@keyframes theme-sweep-rtl { from { clip-path: inset(0 0 0 100%); }",
    ".md-preview ul, .md-preview ol { margin: 0 0 10px; padding-inline-start: 22px; }",
    "border-inline-start: 3px solid var(--color-border);",
    "text-align: start;",
  ])("contains %s", (rule) => {
    expect(flat).toContain(rule);
  });

  it("puts the Latin-only inputs in the base layer", () => {
    expect(flat).toMatch(/@layer base \{ \[dir="rtl"\] input:is\(\[type=email\]/);
  });

  it("resets letter-spacing for Arabic and Persian outside left-to-right islands", () => {
    expect(flat).toContain(':root:is([lang|="ar"], [lang|="fa"]) *:not([dir="ltr"], [dir="ltr"] *)');
    expect(flat).toContain(':root:is([lang|="ar"], [lang|="fa"]) *:not([dir="ltr"], [dir="ltr"] *)::before');
    expect(flat).toMatch(/\*:not\(\[dir="ltr"\], \[dir="ltr"\] \*\)::after \{ letter-spacing: normal; \}/);
  });

  it("names the platform faces for the three scripts", () => {
    for (const face of ['"SF Arabic"', '"Geeza Pro"', '"Noto Sans Arabic"', '"SF Hebrew"', '"Arial Hebrew"', '"Noto Sans Hebrew"', '"Segoe UI"']) {
      expect(flat).toContain(face);
    }
  });

  it("theme sweep clips from the right in rtl", () => {
    expect(flat).toContain('html[dir="rtl"][data-theme-sweep]::view-transition-new(root) { animation-name: theme-sweep-rtl; }');
  });

  it("no longer uses physical list padding, blockquote border or text-align in the Markdown preview", () => {
    const md = css.slice(css.indexOf(".md-preview {"), css.indexOf("/* ── Accessibility"));
    expect(md).not.toMatch(/padding-left|margin-left|border-left|text-align:\s*left/);
  });
});
