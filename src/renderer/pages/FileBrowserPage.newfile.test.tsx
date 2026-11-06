// New > Folder / Markdown file / Text file / Word document: from the toolbar
// dropdown and from a right-click on the listing's empty space. Drives the
// real page with a mocked API and a mocked uploader.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes, useParams } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const { get, post, uploadFileInParts, toast, perms } = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(async () => ({ ok: true })),
  uploadFileInParts: vi.fn(async (_req: { file: File; fileName: string; mimeType: string; folderId?: string | null }) => ({ fileId: "new1" as string | null })),
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
  perms: { denied: new Set<string>() },
}));
vi.mock("@/lib/api-client", () => ({
  api: { get, post, put: vi.fn(async () => ({ ok: true })), delete: vi.fn(async () => ({ ok: true })) },
  apiBase: () => "https://api.example.com",
  apiRequest: vi.fn(),
  ApiError: class ApiError extends Error {},
}));
vi.mock("@/lib/upload-in-parts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/upload-in-parts")>()),
  uploadFileInParts,
}));
vi.mock("@/lib/workspace-context", () => ({
  useWorkspace: () => ({ active: { id: "ws1", name: "Team" }, workspaces: [], setActive: () => {} }),
}));
// ShareModal (always mounted by the page) reads the plan from useAuth.
vi.mock("@/lib/auth-context", () => ({
  useAuth: () => ({ user: { id: "u1", name: "Sam", email: "sam@dosya.dev" }, isAuthenticated: true, isLoading: false, logout: vi.fn() }),
}));
vi.mock("@/lib/use-permissions", () => ({
  usePermissions: () => ({ can: (p: string) => !perms.denied.has(p), userId: "u1" }),
}));
vi.mock("@/components/files/FilePreviewImage", () => ({
  FilePreviewImage: ({ fallback }: { fallback?: React.ReactNode }) => fallback ?? null,
}));
vi.mock("sonner", () => ({ toast: Object.assign(vi.fn(), toast) }));

import { FileBrowserPage } from "./FileBrowserPage";

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  (window as unknown as { electronAPI: unknown }).electronAPI = new Proxy({}, {
    get: () => vi.fn(async () => undefined),
  });
});

const fileRow = (id: string, name: string) => ({
  id, name, size: 10, size_bytes: 10, mime_type: "text/plain", created_at: 1, updated_at: 1, uploaded_by: "u1",
  lock_mode: "none", share_count: 0, current_version: 1, is_hidden: 0, folder_id: "d9",
});
const folderRow = (id: string, name: string) => ({
  id, name, file_count: 1, created_at: 1, updated_at: 1, lock_mode: "none", is_hidden: 0, origin: null,
});

/** What the conflict lookup (`q=`) answers; the plain listing is fixed. */
let searchHits: { files: { name: string }[]; folders: { name: string }[] } = { files: [], folders: [] };

function listing() {
  return {
    ok: true,
    folders: [folderRow("d1", "Docs")],
    files: [fileRow("f1", "a.txt")],
    breadcrumbs: [{ id: "d9", name: "Work" }],
    pagination: { page: 1, per_page: 100, total_files: 1, total_pages: 1 },
    can_lock: true, can_hide: true, folder_view_only: false,
  };
}

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeEach(() => {
  localStorage.clear();
  get.mockReset();
  uploadFileInParts.mockClear();
  uploadFileInParts.mockImplementation(async () => ({ fileId: "new1" }));
  toast.success.mockClear();
  toast.error.mockClear();
  perms.denied = new Set();
  searchHits = { files: [], folders: [] };
});
afterEach(() => {
  if (root) act(() => root!.unmount());
  container?.remove();
  root = null;
  container = null;
});

function EditorStub() {
  const { fileId } = useParams();
  return <div data-testid="editor">{fileId}</div>;
}

function TextEditorStub() {
  const { fileId } = useParams();
  return <div data-testid="text-editor">{fileId}</div>;
}

async function flush() {
  for (let i = 0; i < 4; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}

async function renderPage(url = "/files?folder=d9") {
  get.mockImplementation(async (path: string) => {
    if (path.startsWith("/api/files?")) {
      const q = new URL(`https://x${path}`).searchParams.get("q");
      return q ? { ok: true, ...searchHits } : listing();
    }
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
          <Routes>
            <Route path="/files" element={<FileBrowserPage />} />
            <Route path="/editor/:fileId" element={<EditorStub />} />
            <Route path="/text-editor/:fileId" element={<TextEditorStub />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
  await flush();
}

const buttons = () => Array.from(document.querySelectorAll("button"));
const button = (label: string) => buttons().find((b) => b.textContent?.trim() === label);
const menuItems = () => Array.from(document.querySelectorAll('[role="menu"] button')).map((b) => b.textContent?.trim());
const heading = () => document.querySelector("h3")?.textContent ?? null;
const nameInput = () => document.querySelector<HTMLInputElement>('input[aria-label="Name"]');

function rightClick(el: Element) {
  const ev = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 40, clientY: 50 });
  act(() => { el.dispatchEvent(ev); });
  return ev;
}
function click(el: Element) {
  act(() => { (el as HTMLElement).click(); });
}
function typeInto(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  act(() => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
const listArea = () => container!.querySelector("table")!.parentElement!;
const row = (name: string) =>
  Array.from(container!.querySelectorAll("tbody tr")).find((tr) => tr.textContent?.includes(name))!;

async function openNewFromToolbar(label: string) {
  click(button("New")!);
  click(buttons().find((b) => b.getAttribute("role") === "menuitem" && b.textContent?.trim() === label)!);
  await flush();
}

describe("right-click on empty space", () => {
  it("opens a New menu with a folder and the three files", async () => {
    await renderPage();
    const ev = rightClick(listArea());
    expect(ev.defaultPrevented).toBe(true);
    expect(menuItems()).toEqual(["Folder", "Markdown file", "Text file", "Word document"]);
  });

  it("leaves a row to its own menu", async () => {
    await renderPage();
    rightClick(row("a.txt"));
    expect(menuItems()).toEqual([]);
    expect(button("Rename")).toBeTruthy();
    expect(button("Markdown file")).toBeUndefined();
  });

  it("offers Open in editor for Markdown and text, and opens the text editor", async () => {
    await renderPage();
    rightClick(row("a.txt"));
    click(button("Open in editor")!);
    await flush();
    expect(document.querySelector('[data-testid="text-editor"]')?.textContent).toBe("f1");
  });

  it("does not offer Open in editor without upload permission", async () => {
    perms.denied = new Set(["upload_files"]);
    await renderPage();
    rightClick(row("a.txt"));
    expect(button("Open in editor")).toBeUndefined();
  });

  it("works in the grid, but not on a tile", async () => {
    localStorage.setItem("dosya_files_view", "card");
    await renderPage();
    const grid = Array.from(container!.querySelectorAll("div.flex-1.overflow-auto")).at(-1)!;
    const tile = Array.from(grid.querySelectorAll("div.cursor-pointer")).find((d) => d.textContent?.includes("Docs"))!;
    rightClick(tile);
    expect(button("Markdown file")).toBeUndefined();
    act(() => { document.body.querySelector<HTMLElement>(".fixed.inset-0.z-40")?.click(); });
    rightClick(grid);
    expect(menuItems()).toEqual(["Folder", "Markdown file", "Text file", "Word document"]);
  });

  it("Escape closes it; Folder opens the New folder dialog", async () => {
    await renderPage();
    rightClick(listArea());
    act(() => { document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })); });
    expect(menuItems()).toEqual([]);
    rightClick(listArea());
    click(button("Folder")!);
    expect(heading()).toBe("Create folder");
  });

  it("is not offered in the trash or the Hidden view", async () => {
    await renderPage("/files?deleted=1");
    rightClick(listArea());
    expect(menuItems()).toEqual([]);
    expect(button("New")).toBeUndefined();
    act(() => root!.unmount()); root = null; container!.remove();
    await renderPage("/files?hidden=1");
    rightClick(listArea());
    expect(menuItems()).toEqual([]);
  });

  it("follows permissions: files need upload_files, the folder create_folders", async () => {
    perms.denied = new Set(["upload_files"]);
    await renderPage();
    rightClick(listArea());
    expect(menuItems()).toEqual(["Folder"]);
    act(() => root!.unmount()); root = null; container!.remove();
    perms.denied = new Set(["create_folders"]);
    await renderPage();
    rightClick(listArea());
    expect(menuItems()).toEqual(["Markdown file", "Text file", "Word document"]);
    act(() => root!.unmount()); root = null; container!.remove();
    perms.denied = new Set(["create_folders", "upload_files"]);
    await renderPage();
    rightClick(listArea());
    expect(menuItems()).toEqual([]);
    expect(button("New")).toBeUndefined();
  });
});

describe("toolbar New", () => {
  it("replaces New folder and opens the same four choices", async () => {
    await renderPage();
    expect(button("New folder")).toBeUndefined();
    const trigger = button("New")!;
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    click(trigger);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(menuItems()).toEqual(["Folder", "Markdown file", "Text file", "Word document"]);
  });

  it("closes on Escape and on an outside click", async () => {
    await renderPage();
    click(button("New")!);
    act(() => { document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })); });
    expect(button("New")!.getAttribute("aria-expanded")).toBe("false");
    click(button("New")!);
    act(() => { document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })); });
    expect(button("New")!.getAttribute("aria-expanded")).toBe("false");
  });

  it("moves between items with the arrow keys", async () => {
    await renderPage();
    click(button("New")!);
    const menu = document.querySelector('[role="menu"]')!;
    const items = Array.from(menu.querySelectorAll<HTMLButtonElement>("[role=menuitem]"));
    act(() => { menu.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })); });
    expect(document.activeElement).toBe(items[0]);
    act(() => { menu.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true })); });
    expect(document.activeElement).toBe(items[3]);
  });
});

describe("naming a new file", () => {
  it("prefills Untitled.md with only the base name selected", async () => {
    await renderPage();
    await openNewFromToolbar("Markdown file");
    expect(heading()).toBe("New Markdown file");
    const input = nameInput()!;
    expect(input.value).toBe("Untitled.md");
    expect(document.activeElement).toBe(input);
    expect([input.selectionStart, input.selectionEnd]).toEqual([0, 8]);
  });

  it("titles and names follow the kind", async () => {
    await renderPage();
    await openNewFromToolbar("Word document");
    expect(heading()).toBe("New Word document");
    expect(nameInput()!.value).toBe("Untitled.docx");
    click(button("Cancel")!);
    expect(nameInput()).toBeNull();
    await openNewFromToolbar("Text file");
    expect(heading()).toBe("New text file");
    expect(nameInput()!.value).toBe("Untitled.txt");
  });

  it("Escape cancels", async () => {
    await renderPage();
    await openNewFromToolbar("Text file");
    act(() => { nameInput()!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
    expect(nameInput()).toBeNull();
  });

  it("refuses a name a loaded row already uses, and stays open", async () => {
    await renderPage();
    await openNewFromToolbar("Text file");
    typeInto(nameInput()!, "A"); // -> "A.txt", same as a.txt ignoring case
    click(button("Create")!);
    await flush();
    expect(document.body.textContent).toContain("A file with this name already exists.");
    expect(nameInput()).not.toBeNull();
    expect(uploadFileInParts).not.toHaveBeenCalled();
  });

  it("refuses a name a folder uses", async () => {
    await renderPage();
    await openNewFromToolbar("Markdown file");
    typeInto(nameInput()!, "docs.md");
    searchHits = { files: [], folders: [{ name: "Docs.MD" }] };
    click(button("Create")!);
    await flush();
    expect(document.body.textContent).toContain("A file with this name already exists.");
    expect(uploadFileInParts).not.toHaveBeenCalled();
  });

  it("asks the API about rows the page has not loaded", async () => {
    await renderPage();
    await openNewFromToolbar("Markdown file");
    searchHits = { files: [{ name: "plan.md" }], folders: [] };
    typeInto(nameInput()!, "Plan.md");
    click(button("Create")!);
    await flush();
    const lookup = get.mock.calls.map(([p]) => p as string).find((p) => p.includes("q="))!;
    const params = new URL(`https://x${lookup}`).searchParams;
    expect(params.get("workspace_id")).toBe("ws1");
    expect(params.get("folder_id")).toBe("d9");
    expect(params.get("q")).toBe("Plan.md");
    expect(params.get("per_page")).toBe("100");
    expect(document.body.textContent).toContain("A file with this name already exists.");
    expect(nameInput()).not.toBeNull();
    expect(uploadFileInParts).not.toHaveBeenCalled();
  });

  it("Create uploads an empty file with the right name and type into the open folder", async () => {
    await renderPage();
    await openNewFromToolbar("Markdown file");
    typeInto(nameInput()!, "notes"); // the extension comes back
    act(() => { nameInput()!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); });
    await flush();
    expect(uploadFileInParts).toHaveBeenCalledTimes(1);
    const req = uploadFileInParts.mock.calls[0][0];
    expect(req.fileName).toBe("notes.md");
    expect(req.mimeType).toBe("text/markdown");
    expect(req.folderId).toBe("d9");
    expect(req.file).toBeInstanceOf(File);
    expect(req.file.size).toBe(0);
    expect(req.file.type).toBe("text/markdown");
    expect(toast.success).toHaveBeenCalledWith("Created notes.md");
    expect(nameInput()).toBeNull();
    // Opens straight in the text editor, the way a Word document opens in its own.
    expect(document.querySelector('[data-testid="text-editor"]')?.textContent).toBe("new1");
  });

  it("a text file opens in the text editor too", async () => {
    await renderPage();
    await openNewFromToolbar("Text file");
    click(button("Create")!);
    await flush();
    expect(uploadFileInParts.mock.calls[0][0].fileName).toBe("Untitled.txt");
    expect(document.querySelector('[data-testid="text-editor"]')?.textContent).toBe("new1");
  });

  it("a Word document is a real docx and opens in the editor", async () => {
    await renderPage();
    rightClick(listArea());
    click(button("Word document")!);
    await flush();
    click(button("Create")!);
    await flush();
    const req = uploadFileInParts.mock.calls[0][0];
    expect(req.fileName).toBe("Untitled.docx");
    expect(req.file.type).toBe("application/vnd.openxmlformats-officedocument.wordprocessingml.document");
    expect(req.file.size).toBe(1735);
    expect(document.querySelector('[data-testid="editor"]')?.textContent).toBe("new1");
  });

  it("an upload failure toasts the server's reason and keeps the dialog", async () => {
    uploadFileInParts.mockImplementation(async () => { throw new Error("Storage quota exceeded"); });
    await renderPage();
    await openNewFromToolbar("Text file");
    click(button("Create")!);
    await flush();
    expect(toast.error).toHaveBeenCalledWith("File could not be created", { description: "Storage quota exceeded" });
    expect(toast.success).not.toHaveBeenCalled();
    expect(nameInput()).not.toBeNull();
  });

  it("an invalid name is refused before anything is sent", async () => {
    await renderPage();
    await openNewFromToolbar("Text file");
    typeInto(nameInput()!, "a/b");
    click(button("Create")!);
    await flush();
    expect(document.querySelector('[role="alert"]')?.textContent).toBeTruthy();
    expect(get.mock.calls.some(([p]) => (p as string).includes("q="))).toBe(false);
    expect(uploadFileInParts).not.toHaveBeenCalled();
  });
});
