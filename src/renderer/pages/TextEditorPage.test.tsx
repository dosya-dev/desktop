// The Markdown/text editor page, driven with a mocked API, a mocked uploader
// and a textarea standing in for CodeMirror (jsdom cannot lay it out).
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const { get, uploadFileInParts, toast } = vi.hoisted(() => ({
  get: vi.fn(),
  uploadFileInParts: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));
vi.mock("@/lib/api-client", () => ({
  api: { get, post: vi.fn(), put: vi.fn(), delete: vi.fn() },
  apiBase: () => "https://api.example.com",
  apiRequest: vi.fn(),
  ApiError: class ApiError extends Error {},
}));
vi.mock("@/lib/upload-in-parts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/upload-in-parts")>()),
  uploadFileInParts,
}));
vi.mock("@/lib/upload-transport", () => ({ uploadTransport: {} }));
vi.mock("sonner", () => ({ toast: Object.assign(vi.fn(), toast) }));
vi.mock("@/components/text-editor/CodeEditor", async () => {
  const React = await import("react");
  const { formatMarkdown } = await import("@/lib/md-format");
  type Handle = import("@/components/text-editor/CodeEditor").EditorHandle;
  type Props = import("@/components/text-editor/CodeEditor").CodeEditorProps;
  function CodeEditor({ ref, initialText, label, phrases, onChange }: Props) {
    const ta = React.useRef<HTMLTextAreaElement>(null);
    // The find bar, as far as the page can see it: open (on which field) or not.
    const [find, setFind] = React.useState<"search" | "replace" | null>(null);
    const findRef = React.useRef(find);
    findRef.current = find;
    React.useImperativeHandle(ref as React.Ref<Handle>, () => ({
      openSearch: (opts) => setFind(opts?.replace ? "replace" : "search"),
      closeSearch: () => {
        if (!findRef.current) return false;
        findRef.current = null;
        setFind(null);
        return true;
      },
      searchOpen: () => findRef.current !== null,
      getText: () => ta.current!.value,
      setText: (text: string) => { ta.current!.value = text; onChange(text); },
      format: (kind) => {
        const el = ta.current!;
        const edit = formatMarkdown(el.value, el.selectionStart, el.selectionEnd, kind);
        let out = el.value;
        for (const c of [...edit.changes].sort((a, b) => b.from - a.from)) out = out.slice(0, c.from) + c.insert + out.slice(c.to);
        el.value = out;
        onChange(out);
      },
      focus: () => ta.current?.focus(),
      scroller: () => ta.current,
    }));
    return (
      <>
        {find && <div data-testid="find-panel" data-field={find}>{phrases?.Find}|{phrases?.["replace all"]}|{phrases?.close}</div>}
        <textarea data-testid="code-editor" aria-label={label} ref={ta} defaultValue={initialText} onChange={(e) => onChange(e.target.value)} />
      </>
    );
  }
  return { CodeEditor };
});

import { TextEditorPage } from "./TextEditorPage";
import { guardNavigation } from "@/lib/nav-guard";
import { saveDraft } from "@/lib/text-drafts";
import { dispatchMenuAction } from "@/lib/menu-bus";

type FileRow = {
  id: string; name: string; size_bytes: number; mime_type: string; lock_mode: string;
  current_version: number; updated_at: number; workspace_id: string; folder_id: string | null;
};
const NOW_SEC = Math.floor(Date.now() / 1000);
let file: FileRow;
let body: string;
/** What GET /api/files/:id answers at save time (the conflict check). */
let latest: FileRow | null;

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  localStorage.clear();
  file = {
    id: "f1", name: "plan.md", size_bytes: 40, mime_type: "text/markdown", lock_mode: "none",
    current_version: 3, updated_at: NOW_SEC - 120, workspace_id: "ws1", folder_id: "d1",
  };
  body = "# Q4 launch plan\n\nShip it.";
  latest = null;
  let opened = false;
  get.mockReset();
  get.mockImplementation(async (path: string) => {
    if (path === "/api/files/f1") {
      if (opened && latest) return { ok: true, file: latest };
      opened = true;
      return { ok: true, file };
    }
    if (path.startsWith("/api/files/f1/versions")) {
      return { ok: true, versions: [{ version_number: 4, uploader_name: "Ada", created_at: NOW_SEC - 60, size_bytes: 1 }] };
    }
    if (path.startsWith("/api/files?")) {
      const q = new URL(`https://x${path}`).searchParams.get("q");
      if (q) return { ok: true, files: [], folders: [] };
      return { ok: true, files: [], folders: [], breadcrumbs: [{ id: "d1", name: "Notes" }] };
    }
    throw new Error(`unexpected GET ${path}`);
  });
  uploadFileInParts.mockReset();
  // A save moves the server's file on, as the real one does.
  uploadFileInParts.mockImplementation(async () => {
    file = { ...file, current_version: file.current_version + 1, updated_at: NOW_SEC };
    return { fileId: "f1", version: file.current_version };
  });
  toast.success.mockClear();
  toast.error.mockClear();
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, text: async () => body })));
});

let root: Root | null = null;
let container: HTMLDivElement | null = null;
afterEach(() => {
  if (root) act(() => root!.unmount());
  container?.remove();
  root = null;
  container = null;
  vi.unstubAllGlobals();
});

function Where() {
  const loc = useLocation();
  return <div data-testid="where">{loc.pathname + loc.search}</div>;
}

async function flush() {
  for (let i = 0; i < 6; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}

async function render(id = "f1") {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root!.render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={[`/text-editor/${id}`]}>
          <Routes>
            <Route path="/text-editor/:fileId" element={<><TextEditorPage /><Where /></>} />
            <Route path="/files" element={<Where />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
  await flush();
}

const editor = () => document.querySelector<HTMLTextAreaElement>('[data-testid="code-editor"]');
const where = () => document.querySelector('[data-testid="where"]')?.textContent;
const text = () => document.body.textContent ?? "";
const button = (name: string) =>
  Array.from(document.querySelectorAll("button")).find((b) => b.getAttribute("aria-label") === name || b.textContent?.trim() === name);
const dot = () => document.querySelector('[data-testid="unsaved-dot"]');

function type(value: string) {
  const el = editor()!;
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
  act(() => {
    setter.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
/** jsdom's Blob has no text(). */
function readBlob(b: Blob): Promise<string> {
  return new Promise((resolve) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result as string);
    fr.readAsText(b);
  });
}
function click(el: Element | null | undefined) {
  expect(el).toBeTruthy();
  act(() => { (el as HTMLElement).click(); });
}
function key(init: KeyboardEventInit, target: EventTarget = editor() ?? window) {
  act(() => { target.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init })); });
}

describe("TextEditorPage", () => {
  it("loads the file into the editor with breadcrumb and status", async () => {
    await render();
    expect(editor()?.value).toBe(body);
    expect(fetch).toHaveBeenCalledWith("https://api.example.com/api/files/f1/raw", expect.objectContaining({ credentials: "include", cache: "no-cache" }));
    const crumbs = document.querySelector('[data-testid="editor-breadcrumb"]')!.textContent;
    expect(crumbs).toContain("Files");
    expect(crumbs).toContain("Notes");
    expect(crumbs).toContain("plan.md");
    expect(text()).toContain("Markdown");
    expect(text()).toContain("5 words");
    expect(text()).toContain("v3 saved 2m ago");
    expect(dot()).toBeNull();
    expect(text()).not.toContain("Unsaved changes");
    // Split view: source and preview side by side.
    expect(document.querySelector('[data-testid="md-preview"] h1')?.textContent).toBe("Q4 launch plan");
  });

  it("typing marks the file as changed", async () => {
    await render();
    type(body + " Now.");
    expect(dot()).not.toBeNull();
    expect(text()).toContain("Unsaved changes");
    type(body); // back to what is saved
    expect(dot()).toBeNull();
  });

  it("⌘S saves a new version of the same file and clears the changed state", async () => {
    await render();
    type("# Q4\n\nNew text");
    key({ key: "s", metaKey: true });
    await flush();
    expect(uploadFileInParts).toHaveBeenCalledTimes(1);
    const req = uploadFileInParts.mock.calls[0][0];
    expect(req.fileId).toBe("f1");
    expect(req.fileName).toBe("plan.md");
    expect(req.workspaceId).toBe("ws1");
    expect(req.mimeType).toBe("text/markdown");
    expect(await readBlob(req.file as Blob)).toBe("# Q4\n\nNew text");
    expect(toast.success).toHaveBeenCalledWith("Saved as a new version");
    expect(dot()).toBeNull();
    expect(text()).toContain("v4 saved just now");
  });

  it("Ctrl+S works too, and the Save button", async () => {
    await render();
    type("x");
    key({ key: "s", ctrlKey: true });
    await flush();
    expect(uploadFileInParts).toHaveBeenCalledTimes(1);
    type("y");
    click(button("Save"));
    await flush();
    expect(uploadFileInParts).toHaveBeenCalledTimes(2);
  });

  it("a file that changed since opening asks first; Overwrite saves anyway", async () => {
    await render();
    latest = { ...file, current_version: 4, updated_at: NOW_SEC - 60 };
    type("mine");
    key({ key: "s", metaKey: true });
    await flush();
    expect(uploadFileInParts).not.toHaveBeenCalled();
    const dialog = document.querySelector('[data-testid="conflict-dialog"]')!;
    expect(dialog.textContent).toContain("Are you sure?");
    expect(dialog.textContent).toContain("This file changed since you opened it.");
    expect(dialog.textContent).toContain("Ada saved version 4");
    click(button("Overwrite"));
    await flush();
    expect(uploadFileInParts).toHaveBeenCalledTimes(1);
    expect(uploadFileInParts.mock.calls[0][0].fileId).toBe("f1");
    expect(document.querySelector('[data-testid="conflict-dialog"]')).toBeNull();
  });

  it("Save as copy makes a new file beside it and opens that", async () => {
    uploadFileInParts.mockImplementation(async () => ({ fileId: "f2", version: 1 }));
    await render();
    latest = { ...file, current_version: 4 };
    type("mine");
    key({ key: "s", metaKey: true });
    await flush();
    click(button("Save as copy"));
    await flush();
    const req = uploadFileInParts.mock.calls[0][0];
    expect(req.fileId).toBeFalsy();
    expect(req.fileName).toBe("plan (copy).md");
    expect(req.folderId).toBe("d1");
    expect(await readBlob(req.file as Blob)).toBe("mine");
    expect(where()).toBe("/text-editor/f2");
  });

  it("Cancel in the conflict dialog saves nothing", async () => {
    await render();
    latest = { ...file, current_version: 4 };
    type("mine");
    key({ key: "s", metaKey: true });
    await flush();
    click(button("Cancel"));
    expect(uploadFileInParts).not.toHaveBeenCalled();
    expect(dot()).not.toBeNull();
  });

  it("closing with unsaved changes asks; Keep editing stays, Discard changes leaves", async () => {
    await render();
    type("changed");
    click(button("Close"));
    const dialog = () => document.querySelector('[data-testid="leave-dialog"]');
    expect(dialog()?.textContent).toContain("Are you sure?");
    expect(dialog()?.textContent).toContain("You have unsaved changes. They will be lost if you leave.");
    click(button("Keep editing"));
    expect(dialog()).toBeNull();
    expect(where()).toBe("/text-editor/f1");
    key({ key: "Escape" });
    expect(dialog()).not.toBeNull();
    click(button("Discard changes"));
    await flush();
    expect(where()).toBe("/files?folder=d1");
  });

  it("closing with nothing changed just leaves", async () => {
    await render();
    click(button("Close"));
    await flush();
    expect(where()).toBe("/files?folder=d1");
  });

  it("app-level navigation (menu, back, deep links) is held while there are changes", async () => {
    await render();
    const proceed = vi.fn();
    guardNavigation(proceed);
    expect(proceed).toHaveBeenCalledTimes(1); // clean: straight through
    type("changed");
    act(() => guardNavigation(proceed));
    expect(proceed).toHaveBeenCalledTimes(1);
    click(button("Discard changes"));
    expect(proceed).toHaveBeenCalledTimes(2);
  });

  it("keystrokes in the editor do not reach app-level shortcut handlers", async () => {
    await render();
    const onDoc = vi.fn();
    document.addEventListener("keydown", onDoc);
    key({ key: "a", metaKey: true });
    key({ key: "Delete" });
    document.removeEventListener("keydown", onDoc);
    expect(onDoc).not.toHaveBeenCalled();
  });

  it("the toolbar formats the selection", async () => {
    body = "hello";
    await render();
    act(() => { editor()!.setSelectionRange(0, 5); });
    click(button("Bold (⌘B)") ?? button("Bold (Ctrl+B)"));
    expect(editor()!.value).toBe("**hello**");
    expect(dot()).not.toBeNull();
  });

  it("switches between split, edit and preview", async () => {
    await render();
    const pane = () => editor()!.closest('[data-testid="source-pane"]')!;
    const preview = () => document.querySelector('[data-testid="md-preview"]');
    click(button("Preview"));
    expect(pane().className).toContain("hidden");
    expect(preview()).not.toBeNull();
    click(button("Edit"));
    expect(pane().className).not.toContain("hidden");
    expect(preview()).toBeNull();
    click(button("Split"));
    expect(preview()).not.toBeNull();
    expect(editor()?.value).toBe(body); // the editor was never remounted
  });

  it("a plain text file gets one pane: no toolbar, preview or view switch", async () => {
    file = { ...file, name: "todo.txt", mime_type: "text/plain" };
    body = "buy milk";
    await render();
    expect(editor()?.value).toBe("buy milk");
    expect(document.querySelector('[role="toolbar"]')).toBeNull();
    expect(document.querySelector('[data-testid="md-preview"]')).toBeNull();
    expect(button("Split")).toBeUndefined();
    expect(text()).toContain("Plain text");
    expect(text()).toContain("2 words");
  });

  it("offers an unsaved draft from earlier; Restore puts it back", async () => {
    saveDraft(localStorage, { workspaceId: "ws1", fileId: "f1", version: 3 }, "draft text", Date.now());
    await render();
    expect(text()).toContain("You have unsaved changes from earlier.");
    click(button("Restore"));
    expect(editor()!.value).toBe("draft text");
    expect(dot()).not.toBeNull();
    expect(text()).not.toContain("You have unsaved changes from earlier.");
  });

  it("Discard drops the draft for good", async () => {
    saveDraft(localStorage, { workspaceId: "ws1", fileId: "f1", version: 3 }, "draft text", Date.now());
    await render();
    click(button("Discard"));
    expect(text()).not.toContain("You have unsaved changes from earlier.");
    expect(localStorage.length).toBe(0);
    expect(editor()!.value).toBe(body);
  });

  it("keeps a draft while editing and clears it on save", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    try {
      await act(async () => { const p = render(); await vi.runAllTimersAsync(); await p; });
      type("work in progress");
      await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
      expect(localStorage.getItem("dosya_text_draft:ws1:f1:v3")).toContain("work in progress");
      key({ key: "s", metaKey: true });
      await act(async () => { await vi.runAllTimersAsync(); });
      expect(localStorage.length).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("refuses a password-locked file without fetching it", async () => {
    file = { ...file, lock_mode: "full_lock" };
    await render();
    expect(fetch).not.toHaveBeenCalled();
    expect(editor()).toBeNull();
    expect(text()).toContain("Locked with a password");
  });

  it("refuses a file over 2 MB", async () => {
    file = { ...file, size_bytes: 3 * 1024 * 1024 };
    await render();
    expect(fetch).not.toHaveBeenCalled();
    expect(editor()).toBeNull();
  });

  // ── Find / replace ───────────────────────────────────────────

  it("⌘F opens the find bar from anywhere on the page, labelled in the app's language", async () => {
    await render();
    const findPanel = () => document.querySelector('[data-testid="find-panel"]');
    expect(findPanel()).toBeNull();
    // Focus on the toolbar, not the text.
    key({ key: "f", metaKey: true }, button("Bold (⌘B)") ?? button("Bold (Ctrl+B)")!);
    expect(findPanel()?.getAttribute("data-field")).toBe("search");
    expect(findPanel()?.textContent).toBe("Find|Replace all|Close find");
    expect(where()).toBe("/text-editor/f1"); // not the app-wide search
  });

  it("Ctrl+F works too, and ⌘⌥F / Ctrl+Alt+F opens straight on Replace", async () => {
    await render();
    key({ key: "f", ctrlKey: true });
    expect(document.querySelector('[data-testid="find-panel"]')?.getAttribute("data-field")).toBe("search");
    key({ key: "ƒ", code: "KeyF", metaKey: true, altKey: true });
    expect(document.querySelector('[data-testid="find-panel"]')?.getAttribute("data-field")).toBe("replace");
  });

  it("Escape closes the find bar first, even with unsaved changes; the next Escape asks to leave", async () => {
    await render();
    type("changed");
    key({ key: "f", metaKey: true });
    key({ key: "Escape" });
    expect(document.querySelector('[data-testid="find-panel"]')).toBeNull();
    expect(document.querySelector('[data-testid="leave-dialog"]')).toBeNull();
    expect(where()).toBe("/text-editor/f1");
    key({ key: "Escape" });
    expect(document.querySelector('[data-testid="leave-dialog"]')).not.toBeNull();
  });

  it("Edit > Find in the app menu opens the editor's find bar, bringing the source back from Preview", async () => {
    await render();
    click(button("Preview"));
    act(() => { expect(dispatchMenuAction({ kind: "simple", id: "find" })).toBe(true); });
    await flush();
    expect(editor()!.closest('[data-testid="source-pane"]')!.className).not.toContain("hidden");
    expect(document.querySelector('[data-testid="find-panel"]')).not.toBeNull();
    expect(where()).toBe("/text-editor/f1");
  });

  it("a plain text file gets find too", async () => {
    file = { ...file, name: "todo.txt", mime_type: "text/plain" };
    body = "buy milk";
    await render();
    key({ key: "f", metaKey: true });
    expect(document.querySelector('[data-testid="find-panel"]')).not.toBeNull();
  });

  // ── Quitting with unsaved changes ────────────────────────────

  describe("quitting the app", () => {
    let askQuit: (() => void) | null;
    let setEditorDirty: ReturnType<typeof vi.fn>;
    let answerQuitConfirm: ReturnType<typeof vi.fn>;
    beforeEach(() => {
      askQuit = null;
      setEditorDirty = vi.fn();
      answerQuitConfirm = vi.fn();
      (window as unknown as { electronAPI: unknown }).electronAPI = {
        setEditorDirty,
        answerQuitConfirm,
        onQuitConfirmRequested: (cb: () => void) => {
          askQuit = cb;
          return () => { askQuit = null; };
        },
      };
    });
    afterEach(() => {
      delete (window as unknown as { electronAPI?: unknown }).electronAPI;
    });
    const quitDialog = () => document.querySelector('[data-testid="quit-dialog"]');

    it("tells main whether there are unsaved changes, and clears it on save and on leaving", async () => {
      await render();
      expect(setEditorDirty).toHaveBeenLastCalledWith(false);
      type("changed");
      expect(setEditorDirty).toHaveBeenLastCalledWith(true);
      key({ key: "s", metaKey: true });
      await flush();
      expect(setEditorDirty).toHaveBeenLastCalledWith(false);
      type("again");
      expect(setEditorDirty).toHaveBeenLastCalledWith(true);
      act(() => root!.unmount());
      root = null;
      expect(setEditorDirty).toHaveBeenLastCalledWith(false);
    });

    it("asks before a quit loses the changes; Keep editing calls the quit off", async () => {
      await render();
      type("changed");
      act(() => askQuit!());
      expect(answerQuitConfirm).toHaveBeenCalledWith("shown");
      expect(quitDialog()?.textContent).toContain("Are you sure?");
      expect(quitDialog()?.textContent).toContain("You have unsaved changes in plan.md. They won't be saved to dosya if you quit.");
      click(button("Keep editing"));
      expect(answerQuitConfirm).toHaveBeenLastCalledWith("cancel");
      expect(quitDialog()).toBeNull();
      expect(editor()!.value).toBe("changed");
    });

    it("Quit anyway lets the quit go", async () => {
      await render();
      type("changed");
      act(() => askQuit!());
      click(button("Quit anyway"));
      expect(answerQuitConfirm).toHaveBeenLastCalledWith("quit");
      expect(quitDialog()).toBeNull();
    });

    it("Escape in the quit dialog keeps editing, and does not start the leave flow", async () => {
      await render();
      type("changed");
      act(() => askQuit!());
      key({ key: "Escape" }, window);
      expect(answerQuitConfirm).toHaveBeenLastCalledWith("cancel");
      expect(quitDialog()).toBeNull();
      expect(document.querySelector('[data-testid="leave-dialog"]')).toBeNull();
    });

    it("the quit question replaces an open leave dialog", async () => {
      await render();
      type("changed");
      click(button("Close"));
      expect(document.querySelector('[data-testid="leave-dialog"]')).not.toBeNull();
      act(() => askQuit!());
      expect(document.querySelector('[data-testid="leave-dialog"]')).toBeNull();
      expect(quitDialog()).not.toBeNull();
    });

    it("nothing unsaved by the time main asks: the quit goes ahead without a dialog", async () => {
      await render();
      act(() => askQuit!());
      expect(answerQuitConfirm).toHaveBeenCalledWith("quit");
      expect(quitDialog()).toBeNull();
    });
  });
});
