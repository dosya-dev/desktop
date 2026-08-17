import { useEffect, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { TitleBar } from "./TitleBar";
import { Sidebar } from "./Sidebar";
import { useSyncStore } from "@/lib/sync-store";
import { DeletionBanner } from "@/components/DeletionBanner";

export function AppShell({ children }: { children: ReactNode }) {
  const navigate = useNavigate();

  // One shared sync-status subscription for the whole authenticated session.
  // TitleBar, Sidebar, Dashboard and SyncPage all read from this store.
  useEffect(() => useSyncStore.getState().init(), []);

  // The sidebar advertises Cmd K / Ctrl+K next to Search; this listener is
  // what keeps that promise true everywhere in the authenticated shell.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "k") {
        e.preventDefault();
        navigate("/search");
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [navigate]);

  return (
    <div className="flex h-screen flex-col">
      <TitleBar />
      {/* Above the scroll container: a pending deletion must stay visible while
          the user scrolls, not scroll away with the page. */}
      <DeletionBanner />
      <div className="flex flex-1 overflow-hidden">
        <Sidebar />
        {/* `relative` is load-bearing: MapPage lays itself out with
            `absolute inset-0`, and without a positioned ancestor here that
            resolves against the viewport - painting the map over the sidebar
            with no way back out. Any page that fills its area absolutely
            anchors to the content region because of this. */}
        <main className="relative flex-1 overflow-y-auto p-6">{children}</main>
      </div>
    </div>
  );
}
