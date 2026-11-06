// Unit B (browser): the files list and grid, search, shared links, dashboards,
// uploads, duplicates, file requests and notifications in Arabic carry no
// physical direction class outside an LTR island; English still renders the
// same text. The page data is mocked at the API boundary.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, type ReactNode } from "react";
import { createHash } from "node:crypto";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderInLocale, type RenderResult } from "../test-utils/rtl";
// @ts-expect-error plain .mjs script without types
import { classify } from "../../../scripts/rtl-codemod.mjs";

const NOW = 1_760_000_000;
const { get, post } = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(async () => ({ ok: true })) }));

vi.mock("@/lib/api-client", () => ({
  api: { get, post, put: vi.fn(async () => ({ ok: true })), delete: vi.fn(async () => ({ ok: true })) },
  apiBase: () => "https://api.example.com",
  apiRequest: vi.fn(),
  ApiError: class ApiError extends Error {},
}));
vi.mock("@/lib/workspace-context", () => ({
  useWorkspace: () => ({
    active: { id: "ws1", name: "Team" },
    workspaces: [{ id: "ws1", name: "Team" }],
    setActive: () => {},
  }),
}));
// ShareModal (always mounted by the page) reads the plan from useAuth.
vi.mock("@/lib/auth-context", () => ({
  useAuth: () => ({ user: { id: "u1", name: "Sam", email: "sam@dosya.dev" }, isAuthenticated: true, isLoading: false, logout: vi.fn() }),
}));
vi.mock("@/lib/use-permissions", () => ({
  usePermissions: () => ({ can: () => true, userId: "u1" }),
}));
vi.mock("@/components/files/FilePreviewImage", () => ({
  FilePreviewImage: ({ fallback }: { fallback?: ReactNode }) => fallback ?? null,
}));
vi.mock("sonner", () => ({ toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() }) }));
vi.mock("@/lib/sync-store", () => ({
  useSyncPairCardsKey: () => "",
  useSyncPaused: () => false,
  useWorkspaceSyncSummaryKey: () => "",
  useSyncStore: Object.assign(() => ({}), { getState: () => ({ status: null, pairs: [] }), subscribe: () => () => {} }),
}));
vi.mock("@/lib/root-pairs", () => ({ usePairFolderLabel: () => () => "" }));

import { FileBrowserPage } from "../pages/FileBrowserPage";
import { SearchPage } from "../pages/SearchPage";
import { SharedLinksPage } from "../pages/SharedLinksPage";
import { DashboardPage } from "../pages/DashboardPage";
import { WorkspaceDashboardPage } from "../pages/WorkspaceDashboardPage";
import { UploadPage } from "../pages/UploadPage";
import { DuplicatesPage } from "../pages/DuplicatesPage";
import { FileRequestsPage } from "../pages/FileRequestsPage";
import { NotificationsPage } from "../pages/NotificationsPage";
import { UploadQueueTree, type UploadQueueItem } from "../components/upload/UploadQueueTree";
import { resetContentSearchState } from "../lib/ai-search";

let view: RenderResult | null = null;

beforeAll(() => {
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  (window as unknown as { electronAPI: unknown }).electronAPI = new Proxy({}, { get: () => vi.fn(async () => undefined) });
});
beforeEach(() => {
  localStorage.clear();
  resetContentSearchState();
  vi.stubGlobal("fetch", contentFetch);
});
afterEach(() => {
  vi.unstubAllGlobals();
  if (vi.isMockFunction(Date.now)) vi.mocked(Date.now).mockRestore();
  view?.unmount();
  view = null;
});

const AI_LIMITS = { vectorBudget: 1, imagesMax: 2000, documentsMax: 10, docChunksMax: 1, backfillUnits: 5000, monthUnits: 1000 };
/** The content search (raw fetch, not api.get): one hit with a snippet and a page. */
const contentFetch = vi.fn(async () => new Response(JSON.stringify({
  ok: true, partial: false,
  files: [{
    id: "f7", name: "invoice.pdf", size_bytes: 5000, mime_type: "application/pdf", extension: "pdf", region: "eu", folder_id: "d1", uploaded_by: "u1",
    created_at: NOW, lock_mode: null, uploader_name: "Sam", score: 0.9, snippet: "Total due on receipt", page: 2, source: "both",
  }],
}), { status: 200, headers: { "Content-Type": "application/json" } }));
/** Past the content search debounce (CONTENT_DEBOUNCE_MS = 400). */
const waitForContent = async () => {
  await act(async () => { await new Promise((r) => setTimeout(r, 450)); });
  await flush();
};

const fileRow = (id: string, name: string, mime = "text/plain") => ({
  id, name, size: 1200, size_bytes: 1200, mime_type: mime, extension: name.split(".").pop(), created_at: NOW, updated_at: NOW,
  uploaded_by: "u1", uploader_name: "Sam", lock_mode: "none", share_count: 1, current_version: 1, is_hidden: 0, folder_id: "d9", region: "eu",
});
const folderRow = (id: string, name: string) => ({
  id, name, file_count: 3, created_at: NOW, updated_at: NOW, lock_mode: "none", is_hidden: 0, origin: null, parent_id: null,
});
const share = (id: string, status: string) => ({
  link_id: id, token: `tok${id}`, expires_at: NOW + 99999, view_count: 4, download_count: 2, is_revoked: 0, shared_at: NOW,
  is_password_protected: 1, file_id: "f1", file_name: "report.pdf", size_bytes: 5000, extension: "pdf", region: "eu",
  folder_name: null, sharer_name: "Sam", status, display_name: "report.pdf", url: `https://dosya.dev/s/tok${id}`, is_mine: true,
});

function respond(path: string): unknown {
  if (path.startsWith("/api/files?")) {
    return {
      ok: true, folders: [folderRow("d1", "Docs")], files: [fileRow("f1", "a.txt"), fileRow("f2", "b.pdf", "application/pdf")],
      breadcrumbs: [{ id: "d9", name: "Work" }], pagination: { page: 1, per_page: 100, total_files: 2, total_pages: 1 },
      can_lock: true, can_hide: true, folder_view_only: false,
    };
  }
  if (path.startsWith("/api/search")) {
    return {
      ok: true, query: "re", files: [fileRow("f1", "report.pdf", "application/pdf")], folders: [folderRow("d1", "Reports")],
      shared: [{ link_id: "l1", token: "t", file_name: "report.pdf", size_bytes: 5000, extension: "pdf", region: "eu", sharer_name: "Sam", status: "active", shared_at: NOW }],
      file_requests: [{ id: "r1", title: "Receipts", message: "Send them", created_by_name: "Sam", created_at: NOW }],
    };
  }
  if (path.startsWith("/api/shares")) {
    return { ok: true, links: [share("1", "active"), share("2", "expired")], stats: { total: 2, active: 1, expiring: 0, total_views: 8 } };
  }
  if (path.startsWith("/api/dashboard")) {
    return {
      ok: true, user_name: "Sam",
      stats: { total_files: 40, files_this_week: 3, shared_externally: 2, total_bytes: 5e6, trash_bytes: 1e3, storage_cap_bytes: 1e9 },
      storage_breakdown: [{ name: "Images", bytes: 3e6, color: "#22c55e" }, { name: "Documents", bytes: 2e6, color: "#3b82f6" }],
      recent_files: [{ id: "f1", name: "a.txt", size_bytes: 1200, extension: "txt", created_at: NOW, share_count: 1 }],
      activity: [{ id: "a1", action: "file.upload", entity_type: "file", metadata: null, created_at: NOW, user_name: "Sam", meta: {} }],
      team_stats: [{ user_id: "u1", name: "Sam", file_count: 3, total_bytes: 3e6 }],
    };
  }
  if (path.startsWith("/api/workspace-dashboard")) {
    return {
      ok: true, total: { limit_bytes: 1e10, used_bytes: 3e9, free_bytes: 7e9 },
      sources: [{ kind: "plan", label: "Pro", bytes: 1e10, meta: {} }],
      owned: [{ id: "ws1", name: "Team", icon_initials: "T", icon_color: "#3b82f6", icon_image_url: null, used_bytes: 3e9, share_pct: 100 }],
      shared: [{ id: "ws2", name: "Other", icon_initials: "O", icon_color: "#22c55e", icon_image_url: null, role_id: "editor", owner_name: "Lee" }],
    };
  }
  // AI search: the dashboard card (on, one budget full so the pause notice
  // shows), the account pool with the donut, and the per-row lines.
  if (path === "/api/workspaces/ws1/ai-search") {
    return {
      ok: true, can_edit: true, can_enable: true, settings: { enabled: true, index_existing: true, excluded_folders: [] },
      status: {
        files_total: 40, indexed: 30, pending: 4, partial: 0, unsupported: 0, capped: 0, failed: 0, images: 20, documents: 10, chunks: 40,
        limits: AI_LIMITS, backfill_units_remaining: 10, month_units_remaining: 10, month_reset_at: null, estimated_finish_at: null, paused: false,
      },
    };
  }
  if (path === "/api/me/ai-search") {
    return {
      ok: true,
      pool: {
        limits: AI_LIMITS, backfill_units_remaining: 4000, backfill_units_total: 5000, month_units_remaining: 750, month_units_total: 1000,
        month_reset_at: NOW, payer_is_family: true, paused: false,
      },
      workspaces: [{ id: "ws1", name: "Team", enabled: true, indexed: 30, pending: 0, images: 20, documents: 10, images_max: 2000, documents_max: 10, paused_reason: "limit" }],
    };
  }
  if (path.startsWith("/api/folders/tree")) {
    return { ok: true, folders: [{ id: "d1", name: "Docs", parent_id: null }, { id: "d2", name: "Deep", parent_id: "d1" }] };
  }
  if (path.startsWith("/api/duplicates")) {
    const f = (id: string, name: string) => ({
      id, name, folder_id: "d1", folder_path: "Docs/Deep", created_at: NOW, uploaded_by: "u1", uploader_name: "Sam", mime_type: "text/plain", extension: "txt",
    });
    return {
      ok: true, groups: [{ content_hash: "h", size_bytes: 1200, count: 2, wasted_bytes: 1200, files: [f("a", "a.txt"), f("b", "a copy.txt")] }],
      total_groups: 1, total_wasted_bytes: 1200, scanning: { pending: 0 },
    };
  }
  if (path === "/api/file-requests" || path.startsWith("/api/file-requests?")) {
    return {
      ok: true,
      requests: [{
        id: "r1", token: "tk", title: "Receipts", message: "Send them", is_password_protected: 1, expires_at: NOW + 99999,
        allowed_extensions: "pdf", max_file_size_bytes: 1e6, max_files: 5, upload_count: 1, is_revoked: 0, created_at: NOW,
        folder_id: null, created_by_name: "Sam", folder_name: "Work", url: "https://dosya.dev/r/tk",
      }],
    };
  }
  if (path.includes("/uploads")) return { ok: true, uploads: [] };
  if (path.includes("/recipients")) return { ok: true, recipients: [] };
  if (path.startsWith("/api/notifications")) {
    return {
      ok: true, nextBefore: null,
      items: [{
        id: "n1", kind: "personal", type: "share", category: "sharing", priority: "normal", title: "Sam shared a file", body: "report.pdf",
        icon: null, link_path: null, actions: null, actor_name: "Sam", created_at: NOW, read_at: null, dismissed_at: null,
      }],
    };
  }
  return { ok: true, files: [], folders: [] };
}

const flush = async () => {
  for (let i = 0; i < 5; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
};

async function render(node: ReactNode, locale: "ar" | "en", url: string): Promise<HTMLElement> {
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

/** Inline-style properties that are physical and not on a line the source marks. */
function physicalStyles(root: Element): string[] {
  const out: string[] = [];
  for (const el of [root, ...Array.from(root.querySelectorAll<HTMLElement>("[style]"))]) {
    if (el.closest('[dir="ltr"]')) continue;
    const s = (el as HTMLElement).style;
    if (!s) continue;
    for (const p of ["paddingLeft", "paddingRight", "marginLeft", "marginRight"] as const) if (s[p]) out.push(p);
  }
  return out;
}

const queue = (id: string, path: string, status: UploadQueueItem["status"]): UploadQueueItem => ({
  file: new File(["x"], id, { type: "text/plain" }), id, status, progress: status === "done" ? 100 : 40, bytesUploaded: 1, workspaceId: "ws1",
  folderId: null, relativePath: path, ...(status === "error" ? { error: "boom" } : {}),
});

interface Screen {
  name: string;
  node: () => ReactNode;
  url?: string;
  setup?: () => void;
  /** sha1 of the English textContent before the conversion; "" = not recorded. */
  hash: string;
  /** Opens a dialog or panel after the first render. */
  after?: () => Promise<void>;
}
/** Clicks the nth button of the page; position, not label, so Arabic works too. */
async function clickNth(n: number): Promise<void> {
  const b = document.querySelectorAll("button")[n];
  expect(b, `button ${n}`).toBeTruthy();
  await act(async () => (b as HTMLElement).click());
  await flush();
}

const SCREENS: Screen[] = [
  { name: "files list", node: () => <FileBrowserPage />, url: "/files?folder=d9", setup: () => localStorage.setItem("dosya_files_view", "table"), hash: "b34b00c54eb2" },
  { name: "files grid", node: () => <FileBrowserPage />, url: "/files?folder=d9", setup: () => localStorage.setItem("dosya_files_view", "card"), hash: "38db444a9255" },
  { name: "search", node: () => <SearchPage />, url: "/search?q=re", after: waitForContent, hash: "8ebb5a9555b7" },
  { name: "shared links", node: () => <SharedLinksPage />, hash: "c020bf649c77" },
  { name: "dashboard", node: () => <DashboardPage />, hash: "9aad8b870af4" },
  { name: "workspace dashboard", node: () => <WorkspaceDashboardPage />, hash: "9537ec5db1d1" },
  { name: "upload page", node: () => <UploadPage />, hash: "904fb4351311" },
  {
    name: "upload queue tree",
    node: () => (
      <UploadQueueTree
        queue={[queue("a.txt", "Photos/2024", "done"), queue("b.txt", "Photos/2024/Raw", "uploading"), queue("c.txt", "", "error")]}
        onRetry={() => {}}
        onRemove={() => {}}
      />
    ),
    hash: "886bd6e4bad4",
  },
  { name: "duplicates", node: () => <DuplicatesPage />, hash: "8454e6e9d78c" },
  { name: "file requests", node: () => <FileRequestsPage />, hash: "d4b97d844f24" },
  { name: "file request details", node: () => <FileRequestsPage />, after: () => clickNth(1), hash: "7fb7083ace63" },
  { name: "file request create", node: () => <FileRequestsPage />, after: () => clickNth(0), hash: "3a1fe3c625cb" },
  { name: "upload folder picker", node: () => <UploadPage />, after: () => clickNth(2), hash: "2e6bb4fd3bbd" },
  // The day heading and the row's age ("{days}d") are read against the clock,
  // so a real clock changed this hash every day: the old "ee8fb4295490" was
  // this same text as "Earlier" and "377d", the day it was recorded. Pinned
  // two hours after the fixture's NOW, it reads "Today" and "2h" for good.
  {
    name: "notifications",
    node: () => <NotificationsPage />,
    setup: () => { vi.spyOn(Date, "now").mockReturnValue((NOW + 2 * 3600) * 1000); },
    hash: "759402aa88d2",
  },
];

describe.each(SCREENS)("$name", (s) => {
  it("has no physical direction class or inline style in Arabic", async () => {
    s.setup?.();
    const c = await render(s.node(), "ar", s.url ?? "/");
    await s.after?.();
    expect(c.querySelectorAll("*").length).toBeGreaterThan(15);
    expect(physicalClasses(c)).toEqual([]);
    expect(physicalStyles(c)).toEqual([]);
    expect(document.documentElement.dir).toBe("rtl");
  });
  it("renders the same English text", async () => {
    s.setup?.();
    const c = await render(s.node(), "en", s.url ?? "/");
    await s.after?.();
    const text = c.textContent ?? "";
    expect(text.length).toBeGreaterThan(10);
    const hash = createHash("sha1").update(text).digest("hex").slice(0, 12);
    if (!s.hash) console.log(`EN-HASH ${s.name} ${hash}`);
    else expect(hash).toBe(s.hash);
  });
});

// The sweep above only proves something if the AI search parts rendered.
describe("AI search parts are in the sweep", () => {
  it("search shows the content section", async () => {
    const c = await render(<SearchPage />, "ar", "/search?q=re");
    await waitForContent();
    expect(c.querySelector("[data-content-results]")?.textContent).toContain("invoice.pdf");
  });
  it("dashboard shows the AI search card", async () => {
    const c = await render(<DashboardPage />, "ar", "/");
    expect(c.querySelector('[data-testid="dashboard-ai-search"] [role="status"]')).not.toBeNull();
  });
  it("workspace dashboard shows the donut, the meters and the row line", async () => {
    const c = await render(<WorkspaceDashboardPage />, "ar", "/");
    expect(c.querySelector('[data-testid="workspaces-ai-search"] [data-testid="ai-donut-slice"]')).not.toBeNull();
    expect(c.querySelectorAll('[data-testid="workspaces-ai-search"] [role="progressbar"]')).toHaveLength(2);
    expect(c.querySelector('[data-testid="ws-ai-state"]')).not.toBeNull();
  });
});

describe("upload queue tree indent", () => {
  it("indents nested rows from the inline start", async () => {
    const c = await render(
      <UploadQueueTree queue={[queue("a.txt", "Photos/2024", "done")]} onRetry={() => {}} onRemove={() => {}} />,
      "ar",
      "/",
    );
    const styled = Array.from(c.querySelectorAll<HTMLElement>("[style]")).filter((e) => e.style.paddingInlineStart);
    expect(styled.length).toBeGreaterThan(0);
    expect(c.querySelectorAll("[style*='padding-left']").length).toBe(0);
  });
});
