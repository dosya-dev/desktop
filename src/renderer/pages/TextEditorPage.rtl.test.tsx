// The editor page in Arabic: Save as copy uploads a file name that is data, so it
// carries no bidi control (an isolate in a saved name is a bug).
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
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
  function CodeEditor({ ref, initialText, label, onChange }: Props) {
    const ta = React.useRef<HTMLTextAreaElement>(null);
    React.useImperativeHandle(ref as React.Ref<Handle>, () => ({
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
      openSearch: () => {},
      closeSearch: () => false,
      searchOpen: () => false,
    }));
    return <textarea data-testid="code-editor" aria-label={label} ref={ta} defaultValue={initialText} onChange={(e) => onChange(e.target.value)} />;
  }
  return { CodeEditor };
});

import { TextEditorPage } from "./TextEditorPage";
import { renderInLocale, type RenderResult } from "@/test-utils/rtl";
import ar from "../../i18n/messages/ar.json";

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

let view: RenderResult | null = null;
afterEach(() => {
  view?.unmount();
  view = null;
  vi.unstubAllGlobals();
});

async function flush() {
  for (let i = 0; i < 6; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}

const editor = () => document.querySelector<HTMLTextAreaElement>('[data-testid="code-editor"]');
const button = (name: string) =>
  Array.from(document.querySelectorAll("button")).find((b) => b.getAttribute("aria-label") === name || b.textContent?.trim() === name);

describe("TextEditorPage in Arabic", () => {
  it("Save as copy uploads a file name free of bidi controls", async () => {
    uploadFileInParts.mockImplementation(async () => ({ fileId: "f2", version: 1 }));
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    view = await renderInLocale(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={["/text-editor/f1"]}>
          <Routes>
            <Route path="/text-editor/:fileId" element={<TextEditorPage />} />
            <Route path="/files" element={<div />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
      "ar",
    );
    await flush();
    expect(document.documentElement.dir).toBe("rtl");
    latest = { ...file, current_version: 4 };
    const el = editor()!;
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
    act(() => {
      setter.call(el, "mine");
      el.dispatchEvent(new Event("input", { bubbles: true }));
    });
    act(() => {
      el.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "s", metaKey: true }));
    });
    await flush();
    const copy = button(ar["editor.action.saveAsCopy" as keyof typeof ar]);
    expect(copy).toBeTruthy();
    act(() => { (copy as HTMLElement).click(); });
    await flush();
    expect(uploadFileInParts).toHaveBeenCalledTimes(1);
    const name = uploadFileInParts.mock.calls[0][0].fileName as string;
    expect(name).toMatch(/^plan .*\.md$/);
    expect(name).not.toMatch(/[\u200E\u200F\u2066-\u2069]/);
  });
});
