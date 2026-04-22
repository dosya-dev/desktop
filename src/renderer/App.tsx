import { HashRouter, Routes, Route, Navigate } from "react-router-dom";
import { QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "sonner";
import { queryClient } from "./lib/query-client";
import { AuthProvider, useAuth } from "./lib/auth-context";
import { WorkspaceProvider, useWorkspace } from "./lib/workspace-context";

// Pages
import { LoginPage } from "./pages/LoginPage";
import { SignUpPage } from "./pages/SignUpPage";
import { DashboardPage } from "./pages/DashboardPage";
import { FileBrowserPage } from "./pages/FileBrowserPage";
import { UploadPage } from "./pages/UploadPage";
import { SharedLinksPage } from "./pages/SharedLinksPage";
import { TeamPage } from "./pages/TeamPage";
import { SettingsPage } from "./pages/SettingsPage";
import { ProfilePage } from "./pages/ProfilePage";
import { ActivityPage } from "./pages/ActivityPage";
import { SearchPage } from "./pages/SearchPage";
import { SyncPage } from "./pages/SyncPage";
import { ForgotPasswordPage } from "./pages/ForgotPasswordPage";
import { LanTransferPage } from "./pages/LanTransferPage";
import { VerifyPage } from "./pages/VerifyPage";
import { TwoFactorPage } from "./pages/TwoFactorPage";
import { OnboardingPage } from "./pages/OnboardingPage";
import { CreateWorkspacePage } from "./pages/CreateWorkspacePage";

// Layout
import { AppShell } from "./components/layout/AppShell";

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

  // Workspace query failed (e.g. 401) — show retry instead of create-workspace
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

  // No workspaces — force the user to create one first
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
      {/* Onboarding — always shown before login */}
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
      <Route path="/lan-transfer" element={<ProtectedPage><LanTransferPage /></ProtectedPage>} />
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
          <AppRoutes />
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
