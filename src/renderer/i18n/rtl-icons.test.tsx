// Task 7 of the right-to-left programme: direction icons flip in RTL, the
// file viewer's arrow keys follow the page direction, and the media and book
// keys keep their meaning (left is back in time, the book's own order).
import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { renderInLocale, type RenderResult } from "../test-utils/rtl";

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

import { FileViewer, type ViewerFile } from "@/components/files/FileViewer";
import { BookViewer } from "@/components/files/BookViewer";
import { Waveform } from "@/components/files/audio/Waveform";
import { NotificationIcon } from "@/components/notifications/NotificationIcon";
import { UploadQueueTree, type UploadQueueItem } from "@/components/upload/UploadQueueTree";
import { shortcutSections } from "@/components/ShortcutsDialog";

class RO { observe() {} unobserve() {} disconnect() {} }
(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= RO;

let current: RenderResult | null = null;
afterEach(() => {
  current?.unmount();
  current = null;
  get.mockReset();
  vi.unstubAllGlobals();
});

const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });
const key = (k: string, target: EventTarget = document) =>
  act(async () => { target.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true })); });

const file = (id: string): ViewerFile => ({
  id, name: `${id}.png`, size_bytes: 10, mime_type: "image/png", extension: "png", region: "eu",
  created_at: 1, updated_at: 1, current_version: 1, lock_mode: "none", is_hidden: 0, uploader_name: null,
  share_count: 0, comment_count: 0,
});

async function viewer(locale: "ar" | "en") {
  get.mockResolvedValue({ ok: true, current_version: 1, versions: [] });
  vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 502 })));
  const onNavigate = vi.fn();
  const files = [file("a"), file("b"), file("c")];
  current = await renderInLocale(<FileViewer file={files[1]} files={files} onClose={() => {}} onNavigate={onNavigate} />, locale);
  await settle();
  return onNavigate;
}

describe("file viewer arrow keys", () => {
  it("in Arabic, ArrowLeft opens the next file and ArrowRight the previous one", async () => {
    const onNavigate = await viewer("ar");
    await key("ArrowLeft");
    expect(onNavigate).toHaveBeenLastCalledWith(expect.objectContaining({ id: "c" }));
    await key("ArrowRight");
    expect(onNavigate).toHaveBeenLastCalledWith(expect.objectContaining({ id: "a" }));
  });

  it("in English, ArrowLeft opens the previous file and ArrowRight the next one", async () => {
    const onNavigate = await viewer("en");
    await key("ArrowLeft");
    expect(onNavigate).toHaveBeenLastCalledWith(expect.objectContaining({ id: "a" }));
    await key("ArrowRight");
    expect(onNavigate).toHaveBeenLastCalledWith(expect.objectContaining({ id: "c" }));
  });

  it("in Arabic, the previous and next chevrons flip", async () => {
    await viewer("ar");
    const icons = [...document.querySelectorAll("svg.lucide-chevron-left, svg.lucide-chevron-right")];
    expect(icons.length).toBeGreaterThanOrEqual(2);
    for (const i of icons) expect(i.getAttribute("class")).toContain("rtl:-scale-x-100");
  });
});

describe("the viewer's position counter", () => {
  it("reads 2 / 3 left to right in Arabic, so it never shows as 3 / 2", async () => {
    await viewer("ar");
    const counter = [...document.querySelectorAll("span")].find((s) => s.textContent === "2 / 3");
    expect(counter?.getAttribute("dir")).toBe("ltr");
  });
});

describe("arrow key hints follow the direction", () => {
  it("the viewer footer shows the previous-file key at its start: right arrow in Arabic, left in English", async () => {
    await viewer("ar");
    const ar = [...document.querySelectorAll("[data-testid=file-viewer] kbd")].map((k) => k.textContent).filter((s) => s === "←" || s === "→");
    expect(ar).toEqual(["→", "←"]);
    current?.unmount();
    current = null;
    await viewer("en");
    const en = [...document.querySelectorAll("[data-testid=file-viewer] kbd")].map((k) => k.textContent).filter((s) => s === "←" || s === "→");
    expect(en).toEqual(["←", "→"]);
  });

  it("the shortcuts sheet swaps the previous/next arrows in RTL and keeps English as it was", () => {
    const row = (dir: "ltr" | "rtl") =>
      shortcutSections("darwin", (k: string) => k, dir).flatMap((s) => s.rows).find(([l]) => l === "shortcuts.label.previousNextFile")![1];
    expect(row("ltr")).toBe("← / →");
    expect(row("rtl")).toBe("→ / ←");
  });
});

describe("media and book keys keep their meaning", () => {
  it("Waveform: ArrowLeft in Arabic seeks back 5 s", async () => {
    const onSeek = vi.fn();
    current = await renderInLocale(
      <Waveform peaks={new Float32Array(8)} position={30} duration={60} loop={null} onSeek={onSeek} />, "ar",
    );
    const slider = current.container.querySelector<HTMLElement>("[role=slider]")!;
    await key("ArrowLeft", slider);
    expect(onSeek).toHaveBeenLastCalledWith(25);
    await key("ArrowRight", slider);
    expect(onSeek).toHaveBeenLastCalledWith(35);
  });

  it("BookViewer: ArrowLeft in Arabic still turns to the previous page", async () => {
    vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})));
    current = await renderInLocale(<BookViewer file={{ id: "bk", name: "Book.epub" }} />, "ar");
    await settle();
    const frame = current.container.querySelector<HTMLIFrameElement>("[data-testid=book-frame]")!;
    const win = frame.contentWindow as unknown as Record<string, unknown>;
    const prev = vi.fn();
    const next = vi.fn();
    Object.assign(win, { __dosyaOpen: () => {}, __dosyaPrev: prev, __dosyaNext: next });
    await key("ArrowLeft");
    expect(prev).toHaveBeenCalledTimes(1);
    expect(next).not.toHaveBeenCalled();
    await key("ArrowRight");
    expect(next).toHaveBeenCalledTimes(1);
  });
});

describe("disclosure chevrons", () => {
  const queue = (id: string, path: string): UploadQueueItem => ({
    file: new File(["x"], id, { type: "text/plain" }), id, status: "done", progress: 100, bytesUploaded: 1,
    workspaceId: "ws1", folderId: null, relativePath: path,
  });

  it("the upload tree's chevron uses rtl:rotate-180 only while closed, never with a scale", async () => {
    current = await renderInLocale(
      <UploadQueueTree queue={[queue("a.txt", "Photos"), queue("b.txt", "Photos")]} onRetry={() => {}} onRemove={() => {}} />, "ar",
    );
    const chevron = () => current!.container.querySelector("[role=treeitem] svg.lucide-chevron-right")!;
    const open = chevron().getAttribute("class")!.split(/\s+/);
    expect(open).toContain("rotate-90");
    expect(open).not.toContain("rtl:rotate-180");
    expect(open).not.toContain("rtl:-scale-x-100");

    await act(async () => { current!.container.querySelector<HTMLElement>("[role=treeitem]")!.click(); });
    const shut = chevron().getAttribute("class")!.split(/\s+/);
    expect(shut).toContain("rtl:rotate-180");
    expect(shut).not.toContain("rotate-90");
    expect(shut).not.toContain("rtl:-scale-x-100");
  });
});

describe("notification glyphs", () => {
  it("a directional glyph (send) flips, a neutral one (bell) does not", async () => {
    current = await renderInLocale(
      <>
        <NotificationIcon icon="send" category={null} priority={null} />
        <NotificationIcon icon="bell" category={null} priority={null} />
      </>,
      "ar",
    );
    const send = current.container.querySelector("[data-icon=send] svg")!;
    expect(send.getAttribute("class")).toContain("rtl:-scale-x-100");
    const other = current.container.querySelector("[data-icon=bell] svg");
    expect(other).not.toBeNull();
    expect(other!.getAttribute("class") ?? "").not.toContain("rtl:-scale-x-100");
  });

  it("the reply glyph (message-square-reply) flips", async () => {
    current = await renderInLocale(<NotificationIcon icon="message-square-reply" category={null} priority={null} />, "ar");
    const reply = current.container.querySelector("[data-icon=message-square-reply] svg");
    expect(reply).not.toBeNull();
    expect(reply!.getAttribute("class")).toContain("rtl:-scale-x-100");
  });
});

// Every JSX use of a directional lucide icon in the renderer sources carries
// rtl:-scale-x-100 (or, for a rotating disclosure chevron, rtl:rotate-180).
// Media controls stay left-to-right (audio/**), and the swipe arrow sits in a
// dir="ltr" island that points at a physical edge.
const ICON = /<(ChevronLeft|ChevronRight|ChevronsLeft|ChevronsRight|ArrowLeft|ArrowRight|ArrowUpRight|CornerDownRight|Reply|Send|LogOut|LogIn|PanelLeft\w*|PanelRight\w*|Undo\w*|Redo\w*)\b[\s\S]*?\/>/g;
const EXEMPT = [`components${sep}files${sep}audio${sep}`, `lib${sep}use-history-nav.tsx`];

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...sources(p));
    else if (p.endsWith(".tsx") && !/\.test\.tsx$/.test(p)) out.push(p);
  }
  return out;
}

describe("directional icons in the sources", () => {
  it("every directional icon flips in RTL", () => {
    const root = join(__dirname, "..");
    const offenders: string[] = [];
    let seen = 0;
    for (const p of sources(root)) {
      const rel = relative(root, p);
      if (EXEMPT.some((e) => rel.includes(e))) continue;
      const text = readFileSync(p, "utf8");
      for (const m of text.matchAll(ICON)) {
        seen++;
        const el = m[0];
        if (el.includes("rtl:-scale-x-100") || el.includes("rtl:rotate-180")) continue;
        const line = text.slice(0, m.index).split("\n").length;
        offenders.push(`${rel}:${line} ${m[1]}`);
      }
    }
    expect(seen).toBeGreaterThan(30);
    expect(offenders).toEqual([]);
  });

  // A disclosure chevron drawn by hand (an inline SVG, not a lucide icon)
  // rotates 90 degrees when open; while closed it must point inward in RTL.
  it("no rotating disclosure chevron is left pointing right while closed", () => {
    const root = join(__dirname, "..");
    const offenders: string[] = [];
    for (const p of sources(root)) {
      const text = readFileSync(p, "utf8");
      for (const m of text.matchAll(/"rotate-90"\s*:\s*""/g)) {
        offenders.push(`${relative(root, p)}:${text.slice(0, m.index).split("\n").length}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
