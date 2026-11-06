// Drag a file or folder onto another folder to move it, with a confirmation
// before anything moves. These drive the real page with synthetic drag events
// (jsdom has no DataTransfer) and a mocked API.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const { get, put, post } = vi.hoisted(() => ({
  get: vi.fn(),
  put: vi.fn(async () => ({ ok: true })),
  post: vi.fn(async () => ({ ok: true })),
}));
const { readDroppedEntries, createFolderTree } = vi.hoisted(() => ({
  // A dropped folder "Photos" with nothing in it: enough to see where the
  // upload would build its tree, without reading real files.
  readDroppedEntries: vi.fn(async () => ({ entries: [], dirs: ["Photos"], hadDirectory: true, skipped: 0 })),
  createFolderTree: vi.fn(async (_dirs: string[], _root: string | null, _create: unknown) => ({ ids: new Map(), failed: [] })),
}));
vi.mock("@/lib/dropped-entries", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/dropped-entries")>()),
  readDroppedEntries,
  createFolderTree,
}));
vi.mock("@/lib/api-client", () => ({
  api: { get, put, post, delete: vi.fn(async () => ({ ok: true })) },
  apiBase: () => "https://api.example.com",
  apiRequest: vi.fn(),
  ApiError: class ApiError extends Error {},
}));
vi.mock("@/lib/workspace-context", () => ({
  useWorkspace: () => ({ active: { id: "ws1", name: "Team" }, workspaces: [], setActive: () => {} }),
}));
// ShareModal (always mounted by the page) reads the plan from useAuth.
vi.mock("@/lib/auth-context", () => ({
  useAuth: () => ({ user: { id: "u1", name: "Sam", email: "sam@dosya.dev" }, isAuthenticated: true, isLoading: false, logout: vi.fn() }),
}));
vi.mock("@/lib/use-permissions", () => ({
  usePermissions: () => ({ can: () => true, userId: "u1" }),
}));
vi.mock("@/components/files/FilePreviewImage", () => ({
  FilePreviewImage: ({ fallback }: { fallback?: React.ReactNode }) => fallback ?? null,
}));
vi.mock("sonner", () => ({
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() }),
}));

import { FileBrowserPage } from "./FileBrowserPage";
import { DRAG_MOVE_TYPE } from "@/lib/drag-move";

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  // Every bridge call resolves to nothing - the page only needs them not to throw.
  (window as unknown as { electronAPI: unknown }).electronAPI = new Proxy({}, {
    get: () => vi.fn(async () => undefined),
  });
});

const fileRow = (id: string, name: string) => ({
  id, name, size: 10, mime_type: "text/plain", created_at: 1, updated_at: 1, uploaded_by: "u1",
  lock_mode: "none", share_count: 0, current_version: 1, is_hidden: 0, folder_id: null,
});
const folderRow = (id: string, name: string) => ({
  id, name, file_count: 1, created_at: 1, updated_at: 1, lock_mode: "none", is_hidden: 0, origin: null,
});

function listing(breadcrumbs: { id: string; name: string }[]) {
  return {
    ok: true,
    folders: [folderRow("d1", "Docs"), folderRow("d2", "Photos")],
    files: [fileRow("f1", "a.txt"), fileRow("f2", "b.txt")],
    breadcrumbs,
    pagination: { page: 1, per_page: 100, total_files: 2, total_pages: 1 },
    can_lock: true, can_hide: true, folder_view_only: false,
  };
}

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeEach(() => {
  localStorage.clear();
  get.mockReset();
  put.mockClear();
});
afterEach(() => {
  if (root) act(() => root!.unmount());
  container?.remove();
  root = null;
  container = null;
});

async function renderPage(url = "/files", crumbs: { id: string; name: string }[] = []) {
  get.mockImplementation(async (path: string) => {
    if (path.startsWith("/api/files?")) return listing(crumbs);
    return { ok: true, files: [], folders: [] };
  });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root!.render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={[url]}>
          <FileBrowserPage />
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}

/** A stand-in DataTransfer: types come from what was set plus any OS types. */
function dataTransfer(osTypes: string[] = []) {
  const store = new Map<string, string>();
  return {
    get types() { return [...store.keys(), ...osTypes]; },
    setData: (k: string, v: string) => { store.set(k, v); },
    getData: (k: string) => store.get(k) ?? "",
    clearData: () => store.clear(),
    setDragImage: vi.fn(),
    effectAllowed: "all",
    dropEffect: "none",
    files: [] as File[],
    items: [] as DataTransferItem[],
  };
}
type DT = ReturnType<typeof dataTransfer>;

function fire(el: Element, type: string, dt: DT) {
  const ev = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(ev, "dataTransfer", { value: dt });
  act(() => { el.dispatchEvent(ev); });
  return ev;
}

const row = (name: string) =>
  Array.from(container!.querySelectorAll("tbody tr")).find((tr) => tr.textContent?.includes(name))!;
const crumb = (label: string) =>
  Array.from(container!.querySelectorAll("button")).find((b) => b.textContent === label)!;
const heading = () => container!.querySelector("h3")?.textContent ?? null;
const description = () => container!.querySelector("#move-confirm-description")?.textContent ?? null;
const highlighted = (el: Element) => /outline-\[var\(--color-primary\)\]|ring-\[var\(--color-primary\)\]/.test(el.className);

describe("drag to move on the Files page", () => {
  it("drops a file on a folder row, asks first, and moves only on Move", async () => {
    await renderPage();
    const src = row("a.txt");
    expect(src.getAttribute("draggable")).toBe("true");
    const dt = dataTransfer();
    fire(src, "dragstart", dt);
    expect(dt.types).toEqual([DRAG_MOVE_TYPE]);

    const target = row("Docs");
    fire(target, "dragenter", dt);
    const over = fire(target, "dragover", dt);
    expect(over.defaultPrevented).toBe(true);
    expect(dt.dropEffect).toBe("move");
    expect(highlighted(target)).toBe(true);

    fire(target, "drop", dt);
    expect(highlighted(target)).toBe(false);
    expect(heading()).toBe("Are you sure?");
    expect(description()).toBe("You are moving a.txt to Docs.");
    expect(put).not.toHaveBeenCalled();

    await act(async () => { crumb("Move").click(); });
    expect(put).toHaveBeenCalledWith("/api/files/f1/move", { folder_id: "d1" });
    expect(heading()).toBeNull();
  });

  it("Cancel moves nothing", async () => {
    await renderPage();
    const dt = dataTransfer();
    fire(row("a.txt"), "dragstart", dt);
    fire(row("Docs"), "dragover", dt);
    fire(row("Docs"), "drop", dt);
    await act(async () => { crumb("Cancel").click(); });
    expect(heading()).toBeNull();
    expect(put).not.toHaveBeenCalled();
  });

  it("a folder is not a target for itself", async () => {
    await renderPage();
    const dt = dataTransfer();
    fire(row("Docs"), "dragstart", dt);
    const over = fire(row("Docs"), "dragover", dt);
    expect(over.defaultPrevented).toBe(false);
    expect(highlighted(row("Docs"))).toBe(false);
    // ...but its sibling is.
    fire(row("Photos"), "dragover", dt);
    expect(highlighted(row("Photos"))).toBe(true);
    fire(row("Photos"), "dragleave", dt);
    expect(highlighted(row("Photos"))).toBe(false);
    fire(row("Docs"), "dragend", dt);
  });

  it("a selected item carries the whole selection to a breadcrumb; the current folder is not a target", async () => {
    await renderPage("/files?folder=cur", [{ id: "p", name: "Parent" }, { id: "cur", name: "Current" }]);
    // Select both files through their checkboxes.
    for (const name of ["a.txt", "b.txt"]) {
      const box = row(name).querySelector("input[type=checkbox]") as HTMLInputElement;
      act(() => box.click());
    }
    const dt = dataTransfer();
    fire(row("b.txt"), "dragstart", dt);
    expect(dt.setDragImage).toHaveBeenCalledTimes(1);

    const current = crumb("Current");
    expect(fire(current, "dragover", dt).defaultPrevented).toBe(false);
    expect(highlighted(current)).toBe(false);

    const parent = crumb("Parent");
    expect(fire(parent, "dragover", dt).defaultPrevented).toBe(true);
    expect(highlighted(parent)).toBe(true);
    fire(parent, "drop", dt);
    expect(description()).toBe("You are moving 2 files to Parent.");

    await act(async () => { crumb("Move").click(); });
    expect(put).toHaveBeenCalledWith("/api/files/f1/move", { folder_id: "p" });
    expect(put).toHaveBeenCalledWith("/api/files/f2/move", { folder_id: "p" });
    // Selection cleared like the bulk move does.
    expect((row("a.txt").querySelector("input[type=checkbox]") as HTMLInputElement).checked).toBe(false);
  });

  it("the root crumb takes a drop from inside a folder, named as the breadcrumb names it", async () => {
    await renderPage("/files?folder=cur", [{ id: "cur", name: "Current" }]);
    const dt = dataTransfer();
    fire(row("Docs"), "dragstart", dt);
    fire(crumb("Files"), "dragover", dt);
    fire(crumb("Files"), "drop", dt);
    expect(description()).toBe("You are moving Docs to Files.");
    await act(async () => { crumb("Move").click(); });
    expect(put).toHaveBeenCalledWith("/api/folders/d1/move", { parent_id: null });
  });

  it("files dragged in from the OS light up a folder row and name it in the upload overlay", async () => {
    await renderPage();
    const dt = dataTransfer(["Files"]);
    const over = fire(row("Docs"), "dragover", dt);
    expect(over.defaultPrevented).toBe(true);
    expect(highlighted(row("Docs"))).toBe(true);
    expect(container!.textContent).toContain("Drop files or folders to upload");
    expect(container!.textContent).toContain("to Docs");
  });

  it("files dropped on a folder row upload into that folder, once", async () => {
    readDroppedEntries.mockClear();
    createFolderTree.mockClear();
    await renderPage();
    const dt = dataTransfer(["Files"]);
    fire(row("Docs"), "dragover", dt);
    fire(row("Docs"), "drop", dt);
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    expect(readDroppedEntries).toHaveBeenCalledTimes(1);
    expect(createFolderTree).toHaveBeenCalledWith(["Photos"], "d1", expect.any(Function));
    expect(highlighted(row("Docs"))).toBe(false);
    // No move dialog for an upload.
    expect(heading()).toBeNull();
  });

  it("files dropped on the open area still upload to the open folder", async () => {
    readDroppedEntries.mockClear();
    createFolderTree.mockClear();
    await renderPage();
    const dt = dataTransfer(["Files"]);
    fire(row("a.txt"), "dragover", dt);
    fire(row("a.txt"), "drop", dt);
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    expect(readDroppedEntries).toHaveBeenCalledTimes(1);
    expect(createFolderTree.mock.calls[0]?.[1]).not.toBe("d1");
  });

  it("an in-app move drag never shows the upload overlay", async () => {
    await renderPage();
    const dt = dataTransfer();
    fire(row("a.txt"), "dragstart", dt);
    fire(row("b.txt"), "dragover", dt);
    expect(container!.textContent).not.toContain("Drop files or folders to upload");
  });

  it("grid view: a file tile drops on a folder tile", async () => {
    localStorage.setItem("dosya_files_view", "card");
    await renderPage();
    const tile = (name: string) =>
      Array.from(container!.querySelectorAll("[draggable]")).find((el) => el.textContent?.includes(name))!;
    const src = tile("a.txt");
    expect(src.getAttribute("draggable")).toBe("true");
    const dt = dataTransfer();
    fire(src, "dragstart", dt);
    const target = tile("Photos");
    fire(target, "dragover", dt);
    expect(highlighted(target)).toBe(true);
    fire(target, "drop", dt);
    expect(description()).toBe("You are moving a.txt to Photos.");
  });

  it("nothing is draggable in the trash", async () => {
    await renderPage("/files?deleted=1");
    expect(row("a.txt").getAttribute("draggable")).toBe("false");
    expect(row("Docs").getAttribute("draggable")).toBe("false");
  });
});
