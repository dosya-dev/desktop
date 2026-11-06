// Task 10: names, paths and server text keep their own direction. In Arabic a
// file name is shown in a dir="auto" element (or a <bdi>), a path, a link and
// the LAN room code sit in dir="ltr", engine and server text in a toast sits in
// a dir="auto" span. In English the same screens render the same text as
// before, with no isolate characters. Nothing copied to the clipboard carries
// a bidi control.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, isValidElement, type ReactNode } from "react";
import { createHash } from "node:crypto";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderInLocale, type RenderResult } from "../test-utils/rtl";
import { autoDir, ipcErrorText, namedLine } from "@/lib/bidi-ui";
import { t } from "@/lib/i18n";
import { rejectionsSummary } from "@/lib/policy-error";

const NOW = 1_760_000_000;
const LATIN = "report (1).pdf";
const HEBREW = "גיבוי 2026 (final).zip";
const BIDI = /[‎‏⁦-⁩]/;

const { get, post, toast, syncState } = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn(), loading: vi.fn(), dismiss: vi.fn() }),
  syncState: { status: null as unknown },
}));

vi.mock("@/lib/api-client", () => ({
  api: { get, post, put: vi.fn(async () => ({ ok: true })), patch: vi.fn(async () => ({ ok: true })), delete: vi.fn(async () => ({ ok: true })) },
  apiBase: () => "https://api.example.com",
  apiRequest: vi.fn(),
  ApiError: class ApiError extends Error {},
  isEdgeChallengeError: () => false,
}));
vi.mock("@/lib/workspace-context", () => ({
  useWorkspace: () => ({ active: { id: "ws1", name: "Team", role: "owner" }, workspaces: [{ id: "ws1", name: "Team" }], setActive: () => {} }),
}));
vi.mock("@/lib/use-permissions", () => ({ usePermissions: () => ({ can: () => true, userId: "u1" }) }));
vi.mock("@/lib/auth-context", () => ({
  useAuth: () => ({ user: { id: "u1", name: "Sam", email: "sam@dosya.dev" }, isAuthenticated: true, isLoading: false, logout: vi.fn() }),
}));
vi.mock("@/components/files/FilePreviewImage", () => ({
  FilePreviewImage: ({ fallback }: { fallback?: ReactNode }) => fallback ?? null,
}));
vi.mock("sonner", () => ({ toast, Toaster: () => null }));
vi.mock("@/lib/sync-store", () => {
  const useSyncStore = Object.assign(
    () => ({ status: syncState.status, isLoading: false, loadFailed: false, init: () => () => {}, refresh: async () => {} }),
    { getState: () => ({ status: syncState.status, pairs: [] }), subscribe: () => () => {} },
  );
  return { useSyncPairCardsKey: () => "", useSyncPaused: () => false, useWorkspaceSyncSummaryKey: () => "", useSyncStore };
});
vi.mock("@/lib/root-pairs", () => ({ usePairFolderLabel: () => (p: { remoteFolderName: string }) => p.remoteFolderName }));
vi.mock("@/lib/lan-peer", () => ({
  LanSession: {
    host: vi.fn(async () => ({ roomCode: "482913", close: async () => {} })),
    join: vi.fn(),
  },
}));
vi.mock("@/lib/lan-transport", () => ({ ipcSink: {}, signalTransport: {} }));

import { FileBrowserPage } from "../pages/FileBrowserPage";
import { FileDetailPanel } from "../components/files/FileDetailPanel";
import { SyncPage } from "../pages/SyncPage";
import { LanTransferPage } from "../pages/LanTransferPage";
import { ShareModal } from "../components/files/ShareModal";
import { AboutPage } from "../pages/AboutPage";

let view: RenderResult | null = null;
const writeText = vi.fn(async () => {});

beforeAll(() => {
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  (window as unknown as { electronAPI: unknown }).electronAPI = new Proxy(
    {},
    { get: (_t, key) => (key === "fileProvider" ? undefined : String(key).startsWith("on") ? vi.fn(() => () => {}) : vi.fn(async () => undefined)) },
  );
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
});
beforeEach(() => {
  localStorage.clear();
  writeText.mockClear();
  toast.error.mockClear();
  syncState.status = null;
});
afterEach(() => {
  view?.unmount();
  view = null;
});

const fileRow = (id: string, name: string) => ({
  id, name, size: 1200, size_bytes: 1200, mime_type: "application/octet-stream", extension: name.split(".").pop(), created_at: NOW, updated_at: NOW,
  uploaded_by: "u1", uploader_name: "Sam", lock_mode: "none", share_count: 0, current_version: 1, is_hidden: 0, folder_id: "d9", region: "eu",
  comment_count: 0, is_synced: 0, origin: null,
});

function respond(path: string): unknown {
  if (path.startsWith("/api/files?")) {
    return {
      ok: true, folders: [], files: [fileRow("f1", LATIN), fileRow("f2", HEBREW)],
      breadcrumbs: [{ id: "d9", name: "גיבוי (2)" }], pagination: { page: 1, per_page: 100, total_files: 2, total_pages: 1 },
      can_lock: true, can_hide: true, folder_view_only: false,
    };
  }
  if (path.includes("/versions")) {
    return { ok: true, current_version: 2, versions: [
      { id: "v2", version_number: 2, size_bytes: 3, created_at: NOW, uploaded_by: "u1", uploader_name: "דנה (QA)" },
      { id: "v1", version_number: 1, size_bytes: 3, created_at: NOW, uploaded_by: "u1", uploader_name: "Sam" },
    ] };
  }
  if (path.endsWith("/share")) return { ok: true, links: [{ id: "l1", url: "https://dosya.dev/s/abc", expires_at: null, view_count: 0, download_count: 0 }] };
  if (path.includes("/comments")) {
    return { ok: true, comments: [{ id: "c1", body: "שלום (1) world", user_id: "u2", user_name: "דנה", user_email: "d@x.dev", created_at: NOW, parent_id: null, is_edited: 0 }] };
  }
  return { ok: true, files: [], folders: [] };
}

const flush = async () => {
  for (let i = 0; i < 6; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
};

async function render(node: ReactNode, locale: "ar" | "en", url = "/"): Promise<HTMLElement> {
  get.mockImplementation(async (p: string) => respond(p));
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  view = await renderInLocale(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[url]}>{node}</MemoryRouter>
    </QueryClientProvider>,
    locale,
  );
  await flush();
  return view.container;
}

async function click(el: Element | null | undefined): Promise<void> {
  expect(el).toBeTruthy();
  await act(async () => (el as HTMLElement).click());
  await flush();
}

/** Elements whose own text is exactly `text`. */
function holders(root: Element, text: string): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>("*")).filter((el) =>
    Array.from(el.childNodes).some((n) => n.nodeType === Node.TEXT_NODE && n.textContent?.trim() === text),
  );
}

/** Every element showing `name` takes its own direction: dir="auto" on it, or a <bdi> around it. */
function expectIsolated(root: Element, name: string): void {
  const els = holders(root, name);
  expect(els.length, `"${name}" on screen`).toBeGreaterThan(0);
  for (const el of els) {
    const ok = el.getAttribute("dir") === "auto" || el.tagName === "BDI";
    expect(ok, `${el.outerHTML.slice(0, 160)}`).toBe(true);
    // dir="auto" around a <bdi> resolves LTR: the truncating element holds the text itself.
    if (el.getAttribute("dir") === "auto") expect(el.querySelector("bdi")).toBeNull();
  }
}

const sha = (s: string) => createHash("sha1").update(s).digest("hex").slice(0, 12);

const pair = (over: Record<string, unknown> = {}) => ({
  pairId: "p1", workspaceId: "ws1", workspaceName: "Team", remoteFolderName: "גיבוי", localPath: "/Users/sam/Documents/גיבוי (2)",
  syncMode: "push-safe", status: "error", lastSyncedAt: NOW * 1000, errorMessage: "EACCES: permission denied, open '/Users/sam/a (1).txt'",
  notices: [], fileErrors: [], fileErrorCount: 0, pendingDeletion: null, filesInQueue: 0, totalFilesInBatch: 0, completedFilesInBatch: 0,
  totalBytesInBatch: 0, completedBytesInBatch: 0, batchStartedAt: 0, syncStartedAt: 0, phase: null, scannedFiles: 0, scannedFolders: 0, statusText: "",
  ...over,
});
const syncStatus = () => ({ pairs: [pair()], activeTransfers: [], recentLogs: [], conflictCountByPair: {}, paused: false });

const detail = (name: string, initialTab?: "comments") => (
  <FileDetailPanel
    initialTab={initialTab}
    file={{ ...fileRow("f1", name), current_version: 2 } as never}
    workspaceId="ws1"
    showVersions
    onClose={() => {}}
    onCopy={() => {}}
    onDelete={() => {}}
    onShare={() => {}}
    onView={() => {}}
    onRefresh={() => {}}
  />
);

describe("file names in Arabic", () => {
  it("the files list shows both names in their own direction", async () => {
    localStorage.setItem("dosya_files_view", "table");
    const c = await render(<FileBrowserPage />, "ar", "/files?folder=d9");
    expectIsolated(c, LATIN);
    expectIsolated(c, HEBREW);
    expectIsolated(c, "גיבוי (2)");
  });

  it("in English a Hebrew file name has no dir attribute (laid out as before); in Arabic it has dir=auto", async () => {
    localStorage.setItem("dosya_files_view", "table");
    let c = await render(<FileBrowserPage />, "en", "/files?folder=d9");
    const en = holders(c, HEBREW);
    expect(en.length).toBeGreaterThan(0);
    for (const el of en) expect(el.hasAttribute("dir")).toBe(false);
    expect(c.querySelectorAll('[dir="auto"]').length).toBe(0);
    view?.unmount();
    view = null;
    c = await render(<FileBrowserPage />, "ar", "/files?folder=d9");
    const ar = holders(c, HEBREW);
    expect(ar.length).toBeGreaterThan(0);
    for (const el of ar) expect(el.getAttribute("dir")).toBe("auto");
  });

  it("no English screen carries dir=auto", async () => {
    for (const node of [detail(HEBREW), detail(HEBREW, "comments")]) {
      const c = await render(node, "en");
      expect(c.querySelectorAll('[dir="auto"]').length).toBe(0);
      view?.unmount();
      view = null;
    }
    syncState.status = syncStatus();
    const c = await render(<SyncPage />, "en", "/sync");
    expect(c.querySelectorAll('[dir="auto"]').length).toBe(0);
  });

  it("the files grid shows both names in their own direction", async () => {
    localStorage.setItem("dosya_files_view", "card");
    const c = await render(<FileBrowserPage />, "ar", "/files?folder=d9");
    expectIsolated(c, LATIN);
    expectIsolated(c, HEBREW);
  });

  it("the detail panel isolates the file name, the uploader and the comment", async () => {
    for (const name of [LATIN, HEBREW]) {
      const c = await render(detail(name), "ar");
      expectIsolated(c, name);
      view?.unmount();
      view = null;
    }
    let c = await render(detail(LATIN), "ar");
    expect(c.querySelector("bdi")?.textContent).toBe("דנה (QA)");
    expect(holders(c, "https://dosya.dev/s/abc")[0]?.getAttribute("dir")).toBe("ltr");
    view?.unmount();
    view = null;
    c = await render(detail(LATIN, "comments"), "ar");
    expect(holders(c, "שלום (1) world")[0]?.getAttribute("dir")).toBe("auto");
    expect(holders(c, "דנה")[0]?.getAttribute("dir")).toBe("auto");
  });

  it("the detail panel's size, type and date line keeps each part whole (a day number never joins the size)", async () => {
    const line = (c: HTMLElement) => Array.from(c.querySelectorAll("p")).find((p) => p.textContent?.includes("application/octet-stream"))!;
    let c = await render(detail(LATIN), "ar");
    expect(Array.from(line(c).children).map((e) => `${e.tagName.toLowerCase()} ${e.getAttribute("dir")}`)).toEqual(["span auto", "span ltr", "span auto"]);
    view?.unmount();
    view = null;
    c = await render(detail(LATIN), "en");
    expect(line(c).children.length).toBe(0);
  });

  it("a card's size and date line keeps each part whole", async () => {
    localStorage.setItem("dosya_files_view", "card");
    const c = await render(<FileBrowserPage />, "ar", "/files?folder=d9");
    const lines = Array.from(c.querySelectorAll("p")).filter((p) => p.textContent?.includes(" \u00b7 ") && p.className.includes("font-mono"));
    expect(lines.length).toBeGreaterThan(0);
    for (const l of lines) expect(Array.from(l.children).map((e) => e.getAttribute("dir"))).toEqual(["auto", "auto"]);
  });

  it("no <bdi> is a direct child of a flex container (it would drop the spaces around it)", async () => {
    const c = await render(detail(LATIN), "ar");
    const bdis = Array.from(c.querySelectorAll("bdi"));
    expect(bdis.length).toBeGreaterThan(0);
    for (const b of bdis) expect(b.parentElement?.className ?? "").not.toMatch(/(^|\s)(inline-)?flex(\s|$)/);
  });
});

describe("server text versus translations in an Arabic toast", () => {
  it("autoDir wraps raw text only; t() output with an isolated argument follows the page", async () => {
    await render(<div />, "ar");
    const raw = autoDir("Quota exceeded (1)");
    expect(isValidElement(raw) && (raw as { props: { dir?: string } }).props.dir).toBe("auto");
    const translated = t("files.error.reasonCountFiles", { reason: "Too big", count: "2" });
    expect(BIDI.test(translated)).toBe(true);
    expect(autoDir(translated)).toBe(translated);
    // The multi-file rejection summary is a translation: never wrapped.
    const summary = rejectionsSummary([{ name: "a.exe", reason: "Too big" }, { name: "b.exe", reason: "Too big" }]);
    expect(autoDir(summary)).toBe(summary);
  });

  it("one rejected file: the name is isolated and the translated reason follows the page", async () => {
    const c = await render(<div />, "ar");
    const reason = t("files.error.fileTypeExtensionIsNotAllowedInThisWorkspace", { extension: "exe" });
    const node = namedLine("report (1).exe", reason);
    await view!.rerender(<p data-t="line">{node}</p>);
    const p = c.querySelector('[data-t="line"]')!;
    expect(p.querySelector("bdi")?.textContent).toBe("report (1).exe");
    expect(p.querySelector("[dir]")).toBeNull();
    expect(p.textContent).toBe(`report (1).exe: ${reason}`);
  });

  it("an unknown engine message over IPC takes its own direction; a known one follows the page; none falls back", async () => {
    await render(<div />, "ar");
    const raw = "Error invoking remote method 'sync:x': Error: disk on fire (2)";
    const shown = ipcErrorText(raw, "fallback");
    expect(isValidElement(shown) && (shown as { props: { dir?: string } }).props.dir).toBe("auto");
    expect(ipcErrorText("", "fallback")).toBe("fallback");
    expect(ipcErrorText(undefined, "fallback")).toBe("fallback");
  });

  it("in English every helper returns plain strings", async () => {
    await render(<div />, "en");
    expect(autoDir("Quota exceeded (1)")).toBe("Quota exceeded (1)");
    expect(namedLine("a.exe", "Too big")).toBe("a.exe: Too big");
    expect(ipcErrorText("disk on fire", "x")).toBe("disk on fire");
  });
});

describe("the share modal's email chip", () => {
  async function addEmail(): Promise<HTMLElement> {
    const input = document.body.querySelector<HTMLInputElement>('input[type="email"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "dana@example.com");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    const chip = holders(document.body, "dana@example.com")[0];
    expect(chip).toBeTruthy();
    return chip;
  }

  it("in Arabic the chip follows the page and only the address is ltr", async () => {
    await render(<ShareModal open target={{ kind: "file", fileIds: ["f1"] }} name="a.pdf" onClose={() => {}} />, "ar");
    const holder = await addEmail();
    expect(holder.tagName).toBe("SPAN");
    expect(holder.getAttribute("dir")).toBe("ltr");
    const chip = holder.parentElement!;
    expect(chip.className).toMatch(/inline-flex/);
    expect(chip.hasAttribute("dir")).toBe(false);
  });

  it("in English the chip holds the address directly, as before", async () => {
    await render(<ShareModal open target={{ kind: "file", fileIds: ["f1"] }} name="a.pdf" onClose={() => {}} />, "en");
    const chip = await addEmail();
    expect(chip.className).toMatch(/inline-flex/);
    expect(chip.hasAttribute("dir")).toBe(false);
  });
});

describe("paths, codes and links in Arabic", () => {
  it("a sync pair's local path is dir=ltr and its engine error dir=auto", async () => {
    syncState.status = syncStatus();
    const c = await render(<SyncPage />, "ar", "/sync");
    const paths = holders(c, "/Users/sam/Documents/גיבוי (2)");
    expect(paths.length).toBeGreaterThan(0);
    for (const p of paths) expect(p.getAttribute("dir")).toBe("ltr");
    const errors = holders(c, "EACCES: permission denied, open '/Users/sam/a (1).txt'");
    expect(errors.length).toBeGreaterThan(0);
    for (const e of errors) expect(e.getAttribute("dir")).toBe("auto");
  });

  it("the LAN room code is dir=ltr and copies without bidi controls", async () => {
    const c = await render(<LanTransferPage />, "ar");
    await click(c.querySelector("button"));
    const code = holders(c, "482913")[0];
    expect(code?.getAttribute("dir")).toBe("ltr");
    // The copy button sits next to the code.
    await click(code?.parentElement?.querySelector("button"));
    expect(writeText).toHaveBeenCalledWith("482913");
  });

  it("an engine error in a LAN toast sits in dir=auto, plain in English", async () => {
    const { LanSession } = await import("@/lib/lan-peer");
    for (const locale of ["ar", "en"] as const) {
      toast.error.mockClear();
      const c = await render(<LanTransferPage />, locale);
      await click(c.querySelector("button"));
      const session = await (LanSession.host as unknown as { mock: { results: Array<{ value: Promise<{ onError?: (m: string, raw: boolean) => void }> }> } }).mock.results.at(-1)!.value;
      // A translated message follows the page: never dir="auto".
      act(() => session.onError?.("translated", false));
      expect(toast.error.mock.calls.at(-1)?.[0]).toBe("translated");
      act(() => session.onError?.("ICE failed (1): no route", true));
      const arg = toast.error.mock.calls.at(-1)?.[0];
      if (locale === "ar") {
        expect(isValidElement(arg)).toBe(true);
        const el = arg as { props: { dir?: string; children?: unknown } };
        expect(el.props.dir).toBe("auto");
        expect(el.props.children).toBe("ICE failed (1): no route");
      } else {
        expect(arg).toBe("ICE failed (1): no route");
      }
      view?.unmount();
      view = null;
    }
  });

  it("a created share link is dir=ltr and copies without bidi controls", async () => {
    post.mockResolvedValue({ ok: true, link: { url: "https://dosya.dev/s/xyz" } });
    await render(<ShareModal open target={{ kind: "file", fileIds: ["f1"] }} name={HEBREW} onClose={() => {}} />, "ar");
    expectIsolated(document.body, HEBREW);
    // Tabs: email, link. Then the submit button is the last one in the dialog.
    const tabs = Array.from(document.body.querySelectorAll("button"));
    await click(tabs[1]);
    const buttons = Array.from(document.body.querySelectorAll("button"));
    await click(buttons[buttons.length - 1]);
    const link = holders(document.body, "https://dosya.dev/s/xyz")[0];
    expect(link?.getAttribute("dir")).toBe("ltr");
    expect(writeText).toHaveBeenCalledWith("https://dosya.dev/s/xyz");
    for (const call of writeText.mock.calls as unknown as string[][]) expect(BIDI.test(call[0])).toBe(false);
  });

  it("About's copied details carry no bidi controls although the screen shows isolated values", async () => {
    const api = (window as unknown as { electronAPI: Record<string, unknown> }).electronAPI;
    const saved = api;
    (window as unknown as { electronAPI: unknown }).electronAPI = new Proxy(
      {},
      {
        get: (_t, key) =>
          key === "getAboutInfo"
            ? async () => ({ version: "3.1.4", distribution: "direct", platform: "darwin", arch: "arm64", electron: "38.1.0", chrome: "140.0.1" })
            : (saved as Record<string | symbol, unknown>)[key],
      },
    );
    try {
      const c = await render(<AboutPage />, "ar");
      // On screen the version is a t() argument, isolated in Arabic.
      const shown = c.querySelector('[data-testid="about-version"]')?.textContent ?? "";
      expect(shown).toContain("3.1.4");
      expect(BIDI.test(shown)).toBe(true);
      const copy = Array.from(c.querySelectorAll("button")).find((b) => b.textContent === t("about.action.copyDetails"));
      await click(copy);
      expect(writeText).toHaveBeenCalledTimes(1);
      const copied = (writeText.mock.calls as unknown as string[][])[0][0];
      expect(copied).toContain("3.1.4");
      expect(BIDI.test(copied)).toBe(false);
    } finally {
      (window as unknown as { electronAPI: unknown }).electronAPI = saved;
    }
  });
});

/** sha1 of the English textContent at the base commit (2b6ee1e7a), before this task. */
const EN_SCREENS: Array<{ name: string; node: () => ReactNode; url?: string; setup?: () => void; hash: string }> = [
  { name: "files list", node: () => <FileBrowserPage />, url: "/files?folder=d9", setup: () => localStorage.setItem("dosya_files_view", "table"), hash: "79b3b9fb93ac" },
  { name: "files grid", node: () => <FileBrowserPage />, url: "/files?folder=d9", setup: () => localStorage.setItem("dosya_files_view", "card"), hash: "9bfd6c49ad6d" },
  { name: "detail panel", node: () => detail(HEBREW), hash: "1e42708b6e82" },
  { name: "sync", node: () => <SyncPage />, url: "/sync", setup: () => { syncState.status = syncStatus(); }, hash: "3e3d5844444a" },
  { name: "lan transfer", node: () => <LanTransferPage />, hash: "1013c56571a6" },
];

describe.each(EN_SCREENS)("English $name", (s) => {
  it("renders the same text as before, with no isolate characters", async () => {
    s.setup?.();
    const c = await render(s.node(), "en", s.url ?? "/");
    const text = c.textContent ?? "";
    expect(text.length).toBeGreaterThan(10);
    expect(BIDI.test(text)).toBe(false);
    expect(c.querySelectorAll("bdi").length).toBe(0);
    if (!s.hash) console.log(`EN-HASH ${s.name} ${sha(text)}`);
    else expect(sha(text)).toBe(s.hash);
  });
});

describe("the About window's back button", () => {
  async function backButton(locale: "en" | "ar"): Promise<HTMLElement> {
    const c = await render(<AboutPage />, locale);
    const ack = Array.from(c.querySelectorAll("button")).find((b) => b.textContent === t("about.label.acknowledgements"));
    await click(ack);
    const back = Array.from(c.querySelectorAll("button")).find((b) => b.textContent?.includes(t("common.back")));
    expect(back).toBeTruthy();
    return back!;
  }
  afterEach(() => { delete document.documentElement.dataset.osDir; });

  it("in English it clears the traffic lights on the left, as before (left-20)", async () => {
    const b = await backButton("en");
    expect(b.style.left).toBe("5rem");
    expect(b.style.right).toBe("");
  });

  it("in Arabic it sits at the inline start (right), away from the lights", async () => {
    const b = await backButton("ar");
    expect(b.style.right).toBe("1rem");
    expect(b.style.left).toBe("");
    expect(b.querySelector("svg")?.getAttribute("class")).toContain("rtl:-scale-x-100");
  });

  it("in Arabic under a right-to-left OS it clears the lights on the right", async () => {
    document.documentElement.dataset.osDir = "rtl";
    const b = await backButton("ar");
    expect(b.style.right).toBe("5rem");
  });
});
