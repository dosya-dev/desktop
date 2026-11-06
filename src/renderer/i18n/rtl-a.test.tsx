// Unit A of the right-to-left conversion: account, sync and the rest. Two
// checks per screen. In ar, no element outside a [dir="ltr"] island carries a
// class token the codemod classifies as physical. In en, the screen renders
// (and its text is stable across two renders). A source check pins every owned
// file: nothing convertible remains and every skipped line is a marked one.
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { type ReactNode } from "react";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderInLocale, type RenderResult } from "../test-utils/rtl";
// @ts-expect-error plain .mjs script without types
import { classify, convertSource } from "../../../scripts/rtl-codemod.mjs";

vi.mock("sonner", () => {
  const toast = Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), info: vi.fn(), message: vi.fn() });
  return { toast, Toaster: () => null };
});
vi.mock("@/assets/app-icon.png", () => ({ default: "icon.png" }));
vi.mock("@/lib/auth-context", () => ({
  useAuth: () => ({
    user: { id: "u1", name: "Test User", email: "test@dosya.dev" },
    isAuthenticated: false,
    isLoading: false,
    login: vi.fn(),
    logout: vi.fn(),
    refreshUser: vi.fn(),
  }),
}));
vi.mock("@/lib/workspace-context", () => ({
  useWorkspace: () => ({
    workspaces: [{ id: "w1", name: "Main" }],
    active: { id: "w1", name: "Main", role: "owner" },
    setActive: vi.fn(),
  }),
}));
vi.mock("@/lib/use-permissions", () => ({ usePermissions: () => ({ can: () => true }) }));
vi.mock("@/lib/ipc", () => ({ ipc: {} }));
vi.mock("@/lib/api-client", () => ({
  api: { get: vi.fn(() => new Promise(() => {})), post: vi.fn(), put: vi.fn(), patch: vi.fn(), delete: vi.fn() },
  apiRequest: vi.fn(() => new Promise(() => {})),
  ApiError: class ApiError extends Error {},
  isEdgeChallengeError: () => false,
}));

import { LoginPage } from "@/pages/LoginPage";
import { SignUpPage } from "@/pages/SignUpPage";
import { ForgotPasswordPage } from "@/pages/ForgotPasswordPage";
import { TwoFactorPage } from "@/pages/TwoFactorPage";
import { VerifyPage } from "@/pages/VerifyPage";
import { OnboardingPage } from "@/pages/OnboardingPage";
import { TeamPage } from "@/pages/TeamPage";
import { GroupsPage } from "@/pages/GroupsPage";
import { SettingsPage } from "@/pages/SettingsPage";
import { ProfilePage } from "@/pages/ProfilePage";
import { SyncPage } from "@/pages/SyncPage";
import { LanTransferPage } from "@/pages/LanTransferPage";
import { CreateWorkspacePage } from "@/pages/CreateWorkspacePage";
import { AboutPage } from "@/pages/AboutPage";
import { IntegrationsPage } from "@/pages/IntegrationsPage";
import { ShortcutsDialog } from "@/components/ShortcutsDialog";
import { MaintenanceScreen } from "@/components/MaintenanceScreen";
import { ErrorPanel } from "@/components/ErrorPanel";

let view: RenderResult | null = null;

beforeAll(() => {
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  (window as unknown as { electronAPI: unknown }).electronAPI = new Proxy(
    {},
    {
      get: (_t, key) =>
        key === "fileProvider" ? undefined : String(key).startsWith("on") ? vi.fn(() => () => {}) : vi.fn(async () => undefined),
    },
  );
});

afterEach(() => {
  view?.unmount();
  view = null;
});

const shell = (node: ReactNode) => (
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <MemoryRouter initialEntries={["/x"]}>{node}</MemoryRouter>
  </QueryClientProvider>
);

async function render(node: ReactNode, locale: "ar" | "en"): Promise<HTMLElement> {
  view = await renderInLocale(shell(node), locale);
  await new Promise((r) => setTimeout(r, 0));
  return view.container;
}

/** Class tokens under `root`, outside a dir="ltr" island, that the codemod would convert. */
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

const SCREENS: Array<[string, () => ReactNode]> = [
  ["LoginPage", () => <LoginPage />],
  ["SignUpPage", () => <SignUpPage />],
  ["ForgotPasswordPage", () => <ForgotPasswordPage />],
  ["TwoFactorPage", () => <TwoFactorPage />],
  ["VerifyPage", () => <VerifyPage />],
  ["OnboardingPage", () => <OnboardingPage />],
  ["TeamPage", () => <TeamPage />],
  ["GroupsPage", () => <GroupsPage />],
  ["SettingsPage", () => <SettingsPage />],
  ["ProfilePage", () => <ProfilePage />],
  ["SyncPage", () => <SyncPage />],
  ["LanTransferPage", () => <LanTransferPage />],
  ["CreateWorkspacePage", () => <CreateWorkspacePage />],
  ["AboutPage", () => <AboutPage />],
  ["IntegrationsPage", () => <IntegrationsPage />],
  ["ShortcutsDialog", () => <ShortcutsDialog onClose={() => {}} />],
  ["MaintenanceScreen", () => <MaintenanceScreen message="brb" onRetry={async () => false} email="f@x.dev" onSignOut={() => {}} />],
  ["ErrorPanel", () => <ErrorPanel message="m" onRetry={() => {}} />],
];

describe("unit A screens in ar", () => {
  for (const [name, make] of SCREENS) {
    it(`${name}: no physical class outside an ltr island`, async () => {
      const c = await render(make(), "ar");
      expect(c.innerHTML.length).toBeGreaterThan(0);
      expect(physicalClasses(c)).toEqual([]);
    });
  }
});

describe("unit A screens in en", () => {
  for (const [name, make] of SCREENS) {
    it(`${name}: renders the same text twice`, async () => {
      const a = (await render(make(), "en")).textContent;
      view?.unmount();
      view = null;
      const b = (await render(make(), "en")).textContent;
      expect(a).toBe(b);
      expect(a?.length).toBeGreaterThan(0);
    });
  }
});

function owned(): string[] {
  const root = path.resolve(__dirname, "..");
  const walk = (dir: string): string[] =>
    readdirSync(dir).flatMap((n) => {
      const p = path.join(dir, n);
      return statSync(p).isDirectory() ? walk(p) : [p];
    });
  const rel = (p: string) => path.relative(root, p).split(path.sep).join("/");
  const notOwned =
    /^pages\/(MapPage|EditorPage|TextEditorPage|FileBrowserPage|SearchPage|SharedLinksPage|DashboardPage|WorkspaceDashboardPage|UploadPage|DuplicatesPage|FileRequestsPage|NotificationsPage)\.tsx$|^components\/(LanguageMenu|LanguageSwitch|ThemeMenu|FinderLocationToggle)\.tsx$|NotificationBell|^components\/vault\/ui\.tsx$/;
  return [
    ...walk(path.join(root, "pages")),
    ...["vault", "notifications", "sync", "family", "map"].flatMap((d) => walk(path.join(root, "components", d))),
    ...readdirSync(path.join(root, "components")).map((n) => path.join(root, "components", n)).filter((p) => statSync(p).isFile()),
  ]
    .filter((p) => /\.tsx$/.test(p) && !/\.test\.tsx$/.test(p))
    .filter((p) => !notOwned.test(rel(p)));
}

describe("unit A sources", () => {
  it("owns files", () => {
    expect(owned().length).toBeGreaterThan(30);
  });
  for (const file of owned()) {
    it(`${path.basename(file)}: nothing convertible, no unmarked physical token`, () => {
      const text = readFileSync(file, "utf8");
      const { output, skipped } = convertSource(text);
      expect(output === text).toBe(true);
      // SyncPage's menu position (right: ...) is the right-to-left menu task's, not this unit's.
      const reserved = (s: { token: string }) => path.basename(file) === "SyncPage.tsx" && s.token.startsWith("right:");
      expect(
        skipped.filter(
          (s: { reason: string; token: string }) => s.reason !== "marked rtl-ok" && s.reason !== "centering pair" && !reserved(s),
        ),
      ).toEqual([]);
    });
  }
});

describe("hand-converted spots", () => {
  const read = (rel: string) => readFileSync(path.resolve(__dirname, "..", rel), "utf8");

  it("every toggle knob slides both ways", () => {
    for (const rel of ["pages/ProfilePage.tsx", "pages/SettingsPage.tsx", "pages/SyncPage.tsx"]) {
      const text = read(rel);
      expect(text).toContain('"translate-x-5 rtl:-translate-x-5"');
      expect(text).toContain('"translate-x-0.5 rtl:-translate-x-0.5"');
    }
  });

  it("the indeterminate bar has a mirrored twin, the left-to-right one untouched", () => {
    const text = read("pages/SyncPage.tsx");
    expect(text).toContain("@keyframes indeterminate { 0% { transform: translateX(-100%); } 100% { transform: translateX(400%); } }");
    expect(text).toContain("@keyframes indeterminate-rtl { 0% { transform: translateX(100%); } 100% { transform: translateX(-400%); } }");
    expect(text).toContain('[dir="rtl"] .sync-indeterminate { animation-name: indeterminate-rtl !important; }');
    expect(text).toContain('animation: "indeterminate 1.5s ease-in-out infinite"');
  });

  it("the folder tree indent is logical", () => {
    const text = read("pages/SyncPage.tsx");
    expect(text).toContain("paddingInlineStart: `${8 + depth * 16}px`");
    expect(text).not.toContain("paddingLeft");
  });

  it("the integrations hover nudge has its mirrored pair", () => {
    const text = read("pages/IntegrationsPage.tsx");
    expect(text).toContain("-translate-x-1 rtl:translate-x-1");
    expect(text).toContain("group-hover:translate-x-0 rtl:group-hover:translate-x-0");
  });
});
