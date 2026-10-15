import { useEffect, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useAuth } from "@/lib/auth-context";
import { useThemePref } from "@/lib/use-theme-pref";
import { useUiStore } from "@/lib/ui-store";
import { reportMenuState, useMenuActions } from "@/lib/menu-bus";
import { ShortcutsDialog } from "./ShortcutsDialog";

/**
 * Glue between the application menu (main process) and the router.
 *
 * - Reports the app-wide state the menu needs: route, signed-in, appearance,
 *   sidebar, back/forward. Pages add their own slice (selection, list/grid).
 * - Handles the "navigate" event from main (menu, tray, dosya:// deep links).
 * - Serves every menu action no page claimed: back/forward, sign out,
 *   appearance, sidebar, the shortcuts sheet. Registered as a fallback so a
 *   page handler (the Files page, the text viewer) always gets first refusal.
 *
 * Renders nothing but the shortcuts dialog when it is open.
 */
export function MenuBridge() {
  // The About window loads this same bundle at #/about. It must not report
  // its route as the app's, nor answer menu actions meant for the main
  // window, so it gets no bridge at all.
  if (isAboutWindow()) return null;
  return <MainWindowMenuBridge />;
}

function isAboutWindow(): boolean {
  return typeof window !== "undefined" && window.location.hash.startsWith("#/about");
}

function MainWindowMenuBridge() {
  const navigate = useNavigate();
  const location = useLocation();
  const { isAuthenticated, logout } = useAuth();
  const { pref, save } = useThemePref();
  const sidebarCollapsed = useUiStore((s) => s.sidebarCollapsed);
  const toggleSidebar = useUiStore((s) => s.toggleSidebar);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);

  // Main sends "navigate" for the menu, the tray's Upload item and dosya://
  // deep links. Nothing else in the renderer listens for it.
  useEffect(() => window.electronAPI.onNavigate((path) => navigate(path)), [navigate]);

  useEffect(() => {
    // The Navigation API (Chromium 102+) knows about same-document hash
    // entries, which is what HashRouter produces. Fall back to "can go back"
    // when it is missing so the item is never wrongly greyed.
    const nav = (window as { navigation?: { canGoBack?: boolean; canGoForward?: boolean } }).navigation;
    reportMenuState({
      route: location.pathname,
      canGoBack: nav?.canGoBack ?? window.history.length > 1,
      canGoForward: nav?.canGoForward ?? false,
    });
  }, [location]);
  useEffect(() => { reportMenuState({ signedIn: isAuthenticated }); }, [isAuthenticated]);
  useEffect(() => { reportMenuState({ appearance: pref.mode }); }, [pref.mode]);
  useEffect(() => { reportMenuState({ sidebarVisible: !sidebarCollapsed }); }, [sidebarCollapsed]);

  useMenuActions((action) => {
    switch (action.kind) {
      case "navigate":
        navigate(action.path);
        return true;
      case "appearance":
        void save({ ...pref, mode: action.mode });
        return true;
      case "simple":
        break;
      default:
        return false;
    }
    switch (action.id) {
      case "go-back":
        navigate(-1);
        return true;
      case "go-forward":
        navigate(1);
        return true;
      case "sign-out":
        void logout();
        return true;
      case "toggle-sidebar":
        toggleSidebar();
        return true;
      case "shortcuts":
        setShortcutsOpen(true);
        return true;
      case "find":
        // No document open to search in: the app-wide search is the next
        // best answer to ⌘F.
        navigate("/search");
        return true;
      default:
        return false;
    }
  }, { fallback: true });

  return shortcutsOpen ? <ShortcutsDialog onClose={() => setShortcutsOpen(false)} /> : null;
}
