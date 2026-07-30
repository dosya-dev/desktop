import { lazy, Suspense } from "react";
import { HashRouter, Routes, Route, Navigate } from "react-router-dom";
import { QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "sonner";
import { queryClient } from "./lib/query-client";
import { AuthProvider, useAuth } from "./lib/auth-context";
import { WorkspaceProvider, useWorkspace } from "./lib/workspace-context";

// Auth entry points stay eager so first paint after launch is instant.
import { LoginPage } from "./pages/LoginPage";
import { OnboardingPage } from "./pages/OnboardingPage";

// Layout (needed by every protected page - keep eager)
import { AppShell } from "./components/layout/AppShell";

// Everything else is code-split into its own chunk and loaded on demand.
// This keeps the initial bundle small - the heavy pages (FileBrowser, Sync,
// Profile, Upload, Settings) only download when the user navigates to them.
// Pages use named exports, so map them to a default for React.lazy().
const lazyPage = <T extends Record<string, React.ComponentType<any>>>(
  loader: () => Promise<T>,
  name: keyof T,
) => lazy(() => loader().then((m) => ({ default: m[name] })));

const SignUpPage = lazyPage(() => import("./pages/SignUpPage"), "SignUpPage");
const DashboardPage = lazyPage(() => import("./pages/DashboardPage"), "DashboardPage");
const FileBrowserPage = lazyPage(() => import("./pages/FileBrowserPage"), "FileBrowserPage");
const UploadPage = lazyPage(() => import("./pages/UploadPage"), "UploadPage");
const SharedLinksPage = lazyPage(() => import("./pages/SharedLinksPage"), "SharedLinksPage");
const TeamPage = lazyPage(() => import("./pages/TeamPage"), "TeamPage");
const SettingsPage = lazyPage(() => import("./pages/SettingsPage"), "SettingsPage");
const ProfilePage = lazyPage(() => import("./pages/ProfilePage"), "ProfilePage");
const ActivityPage = lazyPage(() => import("./pages/ActivityPage"), "ActivityPage");
const SearchPage = lazyPage(() => import("./pages/SearchPage"), "SearchPage");
const SyncPage = lazyPage(() => import("./pages/SyncPage"), "SyncPage");
const FileRequestsPage = lazyPage(() => import("./pages/FileRequestsPage"), "FileRequestsPage");
const ForgotPasswordPage = lazyPage(() => import("./pages/ForgotPasswordPage"), "ForgotPasswordPage");
const LanTransferPage = lazyPage(() => import("./pages/LanTransferPage"), "LanTransferPage");
const VerifyPage = lazyPage(() => import("./pages/VerifyPage"), "VerifyPage");
const TwoFactorPage = lazyPage(() => import("./pages/TwoFactorPage"), "TwoFactorPage");
const CreateWorkspacePage = lazyPage(() => import("./pages/CreateWorkspacePage"), "CreateWorkspacePage");
const WorkspaceDashboardPage = lazyPage(() => import("./pages/WorkspaceDashboardPage"), "WorkspaceDashboardPage");

/** Full-screen spinner shown while a lazily-loaded page chunk downloads. */
function PageFallback() {
  return (
    <div className="flex h-screen items-center justify-center">
      <div className="h-8 w-8 animate-spin rounded-full border-2 border-[var(--color-primary)] border-t-transparent" />
    </div>
  );
}

function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const { isAuthenticated, isLoading: authLoading } = useAuth();
  const { workspaces, isLoading: wsLoading, isError, refetch } = useWorkspace();

  if (authLoading || wsLoading) {
    return (
      <div className="flex h-screen items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-[var(--color-primary)] border-t-transparent" />
      </div>
    );
  }

  if (!isAuthenticated) {
    return <Navigate to="/onboarding" replace />;
  }

  // Workspace query failed (e.g. 401) - show retry instead of create-workspace
  if (isError && workspaces.length === 0) {
    return (
      <div className="flex h-screen flex-col items-center justify-center gap-4">
        <p className="text-sm text-[var(--color-text-secondary)]">
          Failed to load workspaces. Please try again.
        </p>
        <button
          onClick={() => refetch()}
          className="rounded-lg px-4 py-2 text-sm font-medium text-white"
          style={{ background: "var(--color-primary)" }}
        >
          Retry
        </button>
      </div>
    );
  }

  // No workspaces - force the user to create one first
  if (workspaces.length === 0) {
    return <CreateWorkspacePage />;
  }

  return <>{children}</>;
}

function ProtectedPage({ children }: { children: React.ReactNode }) {
  return (
    <ProtectedRoute>
      <AppShell>{children}</AppShell>
    </ProtectedRoute>
  );
}

function AppRoutes() {
  return (
    <Routes>
      {/* Onboarding - always shown before login */}
      <Route path="/onboarding" element={<OnboardingPage />} />

      {/* Public routes */}
      <Route path="/login" element={<LoginPage />} />
      <Route path="/signup" element={<SignUpPage />} />
      <Route path="/forgot-password" element={<ForgotPasswordPage />} />
      <Route path="/2fa" element={<TwoFactorPage />} />

      {/* Protected routes */}
      <Route path="/dashboard" element={<ProtectedPage><DashboardPage /></ProtectedPage>} />
      <Route path="/files" element={<ProtectedPage><FileBrowserPage /></ProtectedPage>} />
      <Route path="/upload" element={<ProtectedPage><UploadPage /></ProtectedPage>} />
      <Route path="/shared" element={<ProtectedPage><SharedLinksPage /></ProtectedPage>} />
      <Route path="/team" element={<ProtectedPage><TeamPage /></ProtectedPage>} />
      <Route path="/settings" element={<ProtectedPage><SettingsPage /></ProtectedPage>} />
      <Route path="/profile" element={<ProtectedPage><ProfilePage /></ProtectedPage>} />
      <Route path="/activity" element={<ProtectedPage><ActivityPage /></ProtectedPage>} />
      <Route path="/search" element={<ProtectedPage><SearchPage /></ProtectedPage>} />
      <Route path="/sync" element={<ProtectedPage><SyncPage /></ProtectedPage>} />
      <Route path="/file-requests" element={<ProtectedPage><FileRequestsPage /></ProtectedPage>} />
      <Route path="/lan-transfer" element={<ProtectedPage><LanTransferPage /></ProtectedPage>} />
      <Route path="/workspaces" element={<ProtectedPage><WorkspaceDashboardPage /></ProtectedPage>} />
      <Route path="/verify" element={<VerifyPage />} />

      {/* Default: always start at onboarding */}
      <Route path="*" element={<Navigate to="/onboarding" replace />} />
    </Routes>
  );
}

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <HashRouter>
        <AuthProvider>
          <WorkspaceProvider>
          <Suspense fallback={<PageFallback />}>
            <AppRoutes />
          </Suspense>
          </WorkspaceProvider>
          <Toaster
            position="bottom-right"
            toastOptions={{
              style: {
                fontFamily: "system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
              },
            }}
          />
        </AuthProvider>
      </HashRouter>
    </QueryClientProvider>
  );
}
