// apps/desktop/src/renderer/components/files/ArchiveViewer.test.tsx
//
// The pane's job is to be honest about what is inside, and its Save actions
// must call the API the way the web pane does: entries by INDEX, folders
// created level by level through /api/folders/batch (which answers `folders`),
// progress visible while a run is active and every Save control disabled
// meanwhile. Ported from apps/web's archive-viewer.test.tsx.
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { ViewerFile } from "@/components/files/FileViewer";

const get = vi.fn();
const post = vi.fn();
vi.mock("@/lib/api-client", () => ({
  api: { get: (...a: unknown[]) => get(...a), post: (...a: unknown[]) => post(...a) },
  apiBase: () => "https://api.test",
  // Same (message, status) order as the real class in @/lib/api-client.
  ApiError: class ApiError extends Error {
    status: number;
    constructor(message: string, status: number) { super(message); this.status = status; }
  },
}));

const toastFns = { loading: vi.fn(), success: vi.fn(), error: vi.fn(), dismiss: vi.fn() };
vi.mock("sonner", () => ({ toast: Object.assign(vi.fn(), toastFns) }));

// The picker virtualises its rows against a scroll element jsdom cannot size;
// render every row instead so the destination can be clicked.
vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: (opts: { count: number }) => ({
    getTotalSize: () => opts.count * 36,
    getVirtualItems: () => Array.from({ length: opts.count }, (_, i) => ({ key: i, index: i, start: i * 36 })),
  }),
}));

const { ArchiveViewer } = await import("./ArchiveViewer");

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(() => {
  if (root) act(() => root!.unmount());
  container?.remove();
  root = null;
  container = null;
  get.mockReset();
  post.mockReset();
  for (const f of Object.values(toastFns)) f.mockReset();
});

async function flush(ticks = 20) {
  for (let i = 0; i < ticks; i++) await Promise.resolve();
}

function zipFile(over: Partial<ViewerFile> = {}): ViewerFile {
  return {
    id: "f1", name: "bundle.zip", size_bytes: 4096, mime_type: "application/zip", extension: "zip",
    region: "weur", created_at: 1, updated_at: 1, current_version: 1, lock_mode: "none", is_hidden: 0,
    uploader_name: null, share_count: 0, comment_count: 0, ...over,
  };
}

const INDEX = {
  kind: "zip",
  archiveSize: 4096,
  totalEntries: 3,
  truncated: false,
  entries: [
    { i: 4, name: "assets/hero.png", size: 284, csize: 271, method: 8, dir: false, encrypted: false, mtime: null },
    { i: 7, name: "README.md", size: 30, csize: 20, method: 8, dir: false, encrypted: false, mtime: null },
    { i: 9, name: "secret.psd", size: 10, csize: 10, method: 0, dir: false, encrypted: true, mtime: null },
  ],
};
const TREE = { ok: true, folders: [{ id: "fld_dest", name: "Dest", parent_id: null, file_count: 0 }] };

/** api.get answers the archive index and the folder tree; posts are recorded. */
function wire(index: unknown, onPost: (path: string, body: Record<string, unknown>) => unknown) {
  get.mockImplementation(async (path: string) => (path.startsWith("/api/folders/tree") ? TREE : index));
  const posts: { path: string; body: Record<string, unknown> }[] = [];
  post.mockImplementation(async (path: string, body: Record<string, unknown>) => {
    posts.push({ path, body });
    return onPost(path, body);
  });
  return posts;
}
const batchAnswer = (body: Record<string, unknown>) => ({
  ok: true,
  folders: (body.folders as { name: string; parent_id: string | null }[]).map((f) => ({
    name: f.name, parent_id: f.parent_id, id: `fld_${f.name}`, created: true,
  })),
});

async function render(file: ViewerFile) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(createElement(ArchiveViewer, { file, onDownload: () => {}, workspaceId: "ws_1" }));
    await flush();
  });
}
const click = async (sel: string) => {
  const el = container!.querySelector(sel) as HTMLButtonElement | null;
  if (!el) throw new Error(`no element for ${sel}`);
  await act(async () => { el.click(); await flush(40); });
};
const clickText = async (text: string) => {
  const el = [...container!.querySelectorAll("button")].find((b) => b.textContent?.trim() === text);
  if (!el) throw new Error(`no button "${text}"`);
  await act(async () => { el.click(); await flush(40); });
};
/** Open the picker (already shown), choose Dest, confirm. */
async function pickDest() {
  await clickText("Dest");
  await clickText("Save here");
}

describe("ArchiveViewer", () => {
  it("opens a disk image and labels it as one", async () => {
    wire({ ...INDEX, kind: "iso" }, () => ({}));
    await render(zipFile({ name: "disc.iso", extension: "iso", mime_type: "application/x-iso9660-image" }));
    expect(container!.querySelector('[data-testid="archive-kind"]')?.textContent).toBe("disk image");
  });

  it("labels a zip as an archive", async () => {
    wire(INDEX, () => ({}));
    await render(zipFile());
    expect(container!.querySelector('[data-testid="archive-kind"]')?.textContent).toBe("archive");
  });

  it("shows the API sentence when a .img is not an ISO image, under a heading that names disk images", async () => {
    const { ApiError } = await import("@/lib/api-client");
    get.mockRejectedValue(new ApiError("This file is not an ISO 9660 disk image. Raw disk images (FAT, ext4, NTFS) are not supported yet.", 422));
    await render(zipFile({ name: "floppy.img", extension: "img" }));
    expect(container!.textContent).toContain("This file isn't a valid disk image");
    expect(container!.textContent).toContain("Raw disk images");
  });

  it("offers Save beside Download for the selected entry, and never for an encrypted one", async () => {
    wire(INDEX, () => ({}));
    await render(zipFile());
    await click('[data-testid="archive-entry-7"]');
    expect(container!.querySelector('[data-testid="archive-save-entry"]')?.getAttribute("data-index")).toBe("7");
    await click('[data-testid="archive-entry-9"]');
    expect(container!.querySelector('[data-testid="archive-save-entry"]')?.getAttribute("data-index")).toBe("7");
  });

  it("saves the selected entry into the picked folder with the tree's cleaned name, and reports the saved name", async () => {
    const posts = wire(INDEX, () => ({ ok: true, file_id: "file_9", name: "README (2).md", size_bytes: 30 }));
    await render(zipFile());
    await click('[data-testid="archive-entry-7"]');
    await click('[data-testid="archive-save-entry"]');
    expect(container!.textContent).toContain("Save to folder");
    await pickDest();
    expect(posts).toEqual([{ path: "/api/files/f1/archive/save", body: { i: 7, folder_id: "fld_dest", name: "README.md" } }]);
    expect(toastFns.success).toHaveBeenCalledWith("Saved to dosya", expect.objectContaining({ description: "README (2).md" }));
  });

  it("saves a folder: creates it through /api/folders/batch, then its files, with a progress toast", async () => {
    const posts = wire(INDEX, (path, body) =>
      path === "/api/folders/batch" ? batchAnswer(body) : { ok: true, file_id: "file_x", name: "hero.png", size_bytes: 1 });
    await render(zipFile());
    await click('[data-testid="archive-save-dir-assets"]');
    await pickDest();
    expect(posts[0]).toEqual({
      path: "/api/folders/batch",
      body: { workspace_id: "ws_1", folders: [{ name: "assets", parent_id: "fld_dest" }] },
    });
    expect(posts[1]).toEqual({ path: "/api/files/f1/archive/save", body: { i: 4, folder_id: "fld_assets", name: "hero.png" } });
    expect(toastFns.loading).toHaveBeenCalled();
    expect(toastFns.success).toHaveBeenCalledWith("Saved 1 file", expect.anything());
  });

  it("offers Save all in the header and names the archive for the wrapping folder", async () => {
    const posts = wire(INDEX, (path, body) =>
      path === "/api/folders/batch" ? batchAnswer(body) : { ok: true, file_id: "file_x", name: "x", size_bytes: 1 });
    await render(zipFile({ name: "bundle.zip" }));
    await click('[data-testid="archive-save-all"]');
    await pickDest();
    expect((posts[0]!.body.folders as { name: string }[])[0]!.name).toBe("bundle");
    expect(posts.filter((p) => p.path.endsWith("/archive/save"))).toHaveLength(2);
    expect(toastFns.success).toHaveBeenCalledWith("Saved 2 files, 1 skipped", expect.anything());
  });

  it("disables every Save control while a folder save is running", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    wire(INDEX, async (path, body) => {
      if (path === "/api/folders/batch") return batchAnswer(body);
      await gate;
      return { ok: true, file_id: "file_x", name: "hero.png", size_bytes: 1 };
    });
    await render(zipFile());
    await click('[data-testid="archive-save-dir-assets"]');
    await pickDest();
    expect((container!.querySelector('[data-testid="archive-save-dir-assets"]') as HTMLButtonElement).disabled).toBe(true);
    expect((container!.querySelector('[data-testid="archive-save-all"]') as HTMLButtonElement).disabled).toBe(true);
    await act(async () => { release(); await flush(40); });
    expect((container!.querySelector('[data-testid="archive-save-dir-assets"]') as HTMLButtonElement).disabled).toBe(false);
  });

  it("refuses a folder over the cap before any request", async () => {
    const many = {
      kind: "zip", archiveSize: 1, totalEntries: 501, truncated: false,
      entries: Array.from({ length: 501 }, (_, i) => ({
        i, name: `big/f${i}.txt`, size: 1, csize: 1, method: 0, dir: false, encrypted: false, mtime: null,
      })),
    };
    const posts = wire(many, () => ({ ok: true }));
    await render(zipFile());
    await click('[data-testid="archive-save-dir-big"]');
    expect(container!.textContent).not.toContain("Save to folder");
    expect(posts).toHaveLength(0);
    expect(toastFns.error).toHaveBeenCalledWith("Too many files to save at once", expect.objectContaining({ description: expect.stringContaining("501 files") }));
  });
});
