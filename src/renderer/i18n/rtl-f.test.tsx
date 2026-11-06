// Unit F of the right-to-left programme: the files components render with no
// physical direction class in Arabic, and English renders the same text.
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, type ReactNode } from "react";
import { writeFileSync } from "node:fs";
import { renderInLocale, type RenderResult } from "../test-utils/rtl";
// @ts-expect-error plain .mjs script without types
import { classify } from "../../../scripts/rtl-codemod.mjs";

const get = vi.fn();
vi.mock("@/lib/api-client", () => ({
  api: { get: (...a: unknown[]) => get(...a), post: vi.fn(async () => ({ ok: true })), delete: vi.fn(), put: vi.fn(), patch: vi.fn() },
  apiBase: () => "https://api.test",
  ApiError: class ApiError extends Error {
    status: number;
    constructor(message: string, status: number) { super(message); this.status = status; }
  },
}));
vi.mock("sonner", () => ({ toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), loading: vi.fn(), dismiss: vi.fn() }) }));
vi.mock("@tanstack/react-virtual", () => ({
  defaultRangeExtractor: (r: { startIndex: number; endIndex: number }) =>
    Array.from({ length: r.endIndex - r.startIndex + 1 }, (_, i) => r.startIndex + i),
  useVirtualizer: (opts: { count: number }) => ({
    getTotalSize: () => opts.count * 36,
    getVirtualItems: () => Array.from({ length: opts.count }, (_, i) => ({ key: i, index: i, start: i * 36, size: 36 })),
    scrollToIndex: () => {},
    measure: () => {},
    options: { scrollMargin: 0 },
  }),
}));

import { ArchiveViewer } from "@/components/files/ArchiveViewer";
import { FileViewer, type ViewerFile } from "@/components/files/FileViewer";
import { FileDetailPanel } from "@/components/files/FileDetailPanel";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { FolderPickerModal } from "@/components/files/FolderPickerModal";
import { LibraryGrid } from "@/components/files/LibraryGrid";
import { LockModal } from "@/components/files/LockModal";
import { VCardView } from "@/components/files/VCardView";
import { libraryColumnsFor } from "@/lib/file-columns";

class RO { observe() {} unobserve() {} disconnect() {} }
(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= RO;

let current: RenderResult | null = null;
afterEach(() => {
  current?.unmount();
  current = null;
  get.mockReset();
  vi.unstubAllGlobals();
});

/** Physical on purpose, marked `rtl-ok` in the source: the play triangle always points right. */
const MARKED = new Set(["svg.ml-0.5"]);

/** Class tokens under `root` (outside any dir="ltr" island) the codemod calls physical. */
function physicalClasses(root: HTMLElement): string[] {
  const out: string[] = [];
  for (const el of root.querySelectorAll<HTMLElement>("[class]")) {
    if (el.closest('[dir="ltr"]')) continue;
    const cls = el.getAttribute("class") ?? "";
    const tokens = cls.split(/\s+/).filter(Boolean);
    const centred = tokens.includes("-translate-x-1/2");
    for (const token of tokens) {
      if (centred && token === "left-1/2") continue; // a centring pair, direction-free
      const id = `${el.tagName.toLowerCase()}.${token}`;
      if (classify(token)?.kind === "convertible" && !MARKED.has(id)) out.push(id);
    }
  }
  return out;
}

/** Inline physical style keys (the codemod's class scanner cannot see them). */
function physicalStyles(root: HTMLElement): string[] {
  const out: string[] = [];
  for (const el of root.querySelectorAll<HTMLElement>("[style]")) {
    if (el.closest('[dir="ltr"]')) continue;
    const s = el.getAttribute("style") ?? "";
    for (const m of s.matchAll(/(?:^|;)\s*(padding-left|padding-right|margin-left|margin-right|left|right|text-align:\s*(?:left|right))\s*:?/g)) {
      out.push(`${el.tagName.toLowerCase()} ${m[1]}`);
    }
  }
  return out;
}

const file = (over: Partial<ViewerFile> = {}): ViewerFile => ({
  id: "f1", name: "bundle.zip", size_bytes: 4096, mime_type: "application/zip", extension: "zip",
  region: "weur", created_at: 1, updated_at: 1, current_version: 1, lock_mode: "none", is_hidden: 0,
  uploader_name: null, share_count: 0, comment_count: 0, ...over,
});

const settle = () => act(async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); await new Promise((r) => setTimeout(r, 0)); });

const ARCHIVE = {
  kind: "zip", archiveSize: 4096, totalEntries: 2, truncated: false,
  entries: [
    { i: 4, name: "assets/hero.png", size: 284, csize: 271, method: 8, dir: false, encrypted: false, mtime: null },
    { i: 7, name: "README.md", size: 30, csize: 20, method: 8, dir: false, encrypted: false, mtime: null },
  ],
};
const card = (name: string) => ["BEGIN:VCARD", "VERSION:3.0", `FN:${name}`, "TEL;TYPE=main:+44 3", "EMAIL;TYPE=work:ada@example.com", "END:VCARD"].join("\r\n");
const VCF = [card("Ada Lovelace"), card("Grace Hopper")].join("\r\n");
const item = (id: string, name: string, mime: string, ext: string) => ({
  id, name, size_bytes: 10, mime_type: mime, extension: ext, region: "eu", created_at: 1, updated_at: 1, current_version: 1,
  lock_mode: "none", is_hidden: 0, uploaded_by: "u", uploader_name: null, share_count: 0, comment_count: 0, is_synced: 0,
  origin: null, folder_id: null, taken_at: 1700000000,
});

interface Screen { name: string; ui: () => ReactNode; setup?: () => void }
const noop = () => {};
const screens: Screen[] = [
  {
    name: "archive viewer",
    setup: () => get.mockImplementation(async (p: string) => (p.startsWith("/api/folders/tree") ? { ok: true, folders: [] } : ARCHIVE)),
    ui: () => <ArchiveViewer file={file()} onDownload={noop} workspaceId="ws_1" />,
  },
  {
    name: "file viewer chrome",
    setup: () => {
      get.mockResolvedValue({ ok: true, current_version: 1, versions: [] });
      vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 502 })));
    },
    ui: () => {
      const f = file({ id: "p1", name: "Photo.png", mime_type: "image/png", extension: "png" });
      return <FileViewer file={f} files={[f, file({ id: "p2", name: "B.png", mime_type: "image/png", extension: "png" })]} onClose={noop} onNavigate={noop} />;
    },
  },
  {
    name: "file detail panel",
    setup: () => get.mockResolvedValue({ ok: true, current_version: 2, versions: [
      { version_number: 2, size_bytes: 3, created_at: 2, uploaded_by: "u", uploader_name: "A" },
      { version_number: 1, size_bytes: 3, created_at: 1, uploaded_by: "u", uploader_name: "A" },
    ], links: [], comments: [] }),
    // In a QueryClientProvider, as the app renders it: the panel prefetches the
    // comment thread once it settles on a file.
    ui: () => (
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <FileDetailPanel file={file({ name: "Notes.txt", mime_type: "text/plain", extension: "txt" })} workspaceId="ws_1" showVersions onClose={noop} onCopy={noop} onDelete={noop} onShare={noop} onView={noop} onRefresh={noop} />
      </QueryClientProvider>
    ),
  },
  {
    name: "lock modal",
    setup: () => get.mockResolvedValue({ ok: true, lock_mode: "none" }),
    ui: () => <LockModal open target={{ id: "f1", name: "Plan.pdf", type: "file", size_bytes: 10, extension: "pdf", lock_mode: "none" }} onClose={noop} onDone={noop} />,
  },
  {
    name: "vcard",
    setup: () => vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, text: async () => VCF }))),
    ui: () => <VCardView file={{ id: "c", name: "Ada.vcf", mime_type: "text/vcard" } as never} rawUrl="https://x/raw" />,
  },
  {
    name: "folder picker",
    ui: () => (
      <FolderPickerModal
        title="Move" actionLabel="Move here" selectedId={null} isPending={false}
        folders={[{ id: "a", name: "A", parent_id: null, file_count: 0 }, { id: "b", name: "B", parent_id: "a", file_count: 0 }]}
        onSelect={noop} onConfirm={noop} onClose={noop}
      />
    ),
  },
  ...(["grid", "list"] as const).map((layout): Screen => ({
    name: `library ${layout}`,
    ui: () => {
      const files = [item("a", "One.mp4", "video/mp4", "mp4"), item("b", "Two.mp4", "video/mp4", "mp4")];
      return (
        <LibraryGrid
          kind="videos" months={[{ key: "2026-10", label: "October 2026", count: 2, files }]} total={2} loaded={2}
          hasMore={false} isLoading={false} isLoadingMore={false} error={null} search=""
          selected={new Set()} favourites={new Set()} unlockedFiles={new Map()} activeId={null}
          tileSize="small" layout={layout} columns={libraryColumnsFor("videos")}
          onLoadMore={noop} onRetry={noop} onUploadClick={noop} onOpen={noop} onToggleSelect={noop}
          onSelectMany={noop} onFavourite={noop} onContextMenu={noop}
        />
      );
    },
  })),
];

async function mountScreen(s: Screen, locale: "ar" | "en") {
  get.mockReset();
  s.setup?.();
  current = await renderInLocale(s.ui(), locale);
  await settle();
  return current.container;
}

describe("files components in Arabic", () => {
  for (const s of screens) {
    it(`${s.name}: no physical direction class or inline style`, async () => {
      const c = await mountScreen(s, "ar");
      expect(document.documentElement.dir).toBe("rtl");
      expect(c.textContent?.length).toBeGreaterThan(0);
      expect(physicalClasses(document.body)).toEqual([]);
      expect(physicalStyles(document.body)).toEqual([]);
    });
  }
});

describe("files components in English", () => {
  for (const s of screens) {
    it(`${s.name}: renders text`, async () => {
      const c = await mountScreen(s, "en");
      expect(document.documentElement.dir).toBe("ltr");
      expect(c.textContent?.length).toBeGreaterThan(0);
      if (process.env.RTL_F_DUMP) writeFileSync(`${process.env.RTL_F_DUMP}/${s.name.replace(/ /g, "_")}.html`, c.innerHTML);
    });
  }
});
