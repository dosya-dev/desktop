import { useEffect, type ReactNode } from "react";
import { TitleBar } from "./TitleBar";
import { Sidebar } from "./Sidebar";
import { useSyncStore } from "@/lib/sync-store";
import { DeletionBanner } from "@/components/DeletionBanner";

export function AppShell({ children }: { children: ReactNode }) {
  // One shared sync-status subscription for the whole authenticated session.
  // TitleBar, Sidebar, Dashboard and SyncPage all read from this store.
  useEffect(() => useSyncStore.getState().init(), []);

  return (
    <div className="flex h-screen flex-col">
      <TitleBar />
      {/* Above the scroll container: a pending deletion must stay visible while
          the user scrolls, not scroll away with the page. */}
      <DeletionBanner />
      <div className="flex flex-1 overflow-hidden">
        <Sidebar />
        <main className="flex-1 overflow-y-auto p-6">{children}</main>
      </div>
    </div>
  );
}
