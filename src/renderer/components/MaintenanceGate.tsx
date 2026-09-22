import type { ReactNode } from "react";
import { useAuth } from "../lib/auth-context";
import { MaintenanceScreen } from "./MaintenanceScreen";

/**
 * A platform switch has paused the desktop surface: every gated request
 * answers 503 (see auth-context.tsx), and there is nothing worth routing to
 * until it clears. Sits above the router so it pre-empts onboarding, login
 * and every protected page alike - the same reason apps/web's DashboardLayout
 * checks it before its own auth/workspace gate.
 *
 * Pulled out of App.tsx into its own module so it can be tested against a
 * plain <AuthProvider> without dragging in the router, react-query, and
 * every lazy page App.tsx also imports.
 */
export function MaintenanceGate({ children }: { children: ReactNode }) {
  const { maintenance, refreshUser, clearMaintenance, user, logout } = useAuth();

  if (!maintenance) return <>{children}</>;

  return (
    <MaintenanceScreen
      message={maintenance.message}
      email={user?.email}
      onSignOut={logout}
      onRetry={async () => {
        // refreshUser() never throws - it swallows 401, 503/surface_disabled,
        // and any transient error alike, returning false in every one of
        // those cases. Clearing maintenance unconditionally here would
        // dismiss the screen on every "Check now" / 60s tick even while the
        // surface is still down (round 3 fix - see auth-context.tsx).
        const ok = await refreshUser();
        if (ok) clearMaintenance();
        return ok;
      }}
    />
  );
}
