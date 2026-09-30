import { useState } from "react";
import { ChevronLeft, ChevronRight, FolderLock, Plus, Users } from "lucide-react";
import type { KnownWorkspace } from "@/lib/vault/store";
import { useNarrowWindow } from "@/lib/use-narrow-window";

const COLLAPSED_KEY = "dosya_vault_spaces_collapsed";

/**
 * The Vault's left Space menu. Presentational: every list, the active id and
 * both actions are props, because VaultBrowser also owns the breadcrumb that
 * has to reset in the same click that switches Spaces. Collapsed state is a
 * per-machine convenience in localStorage, ORed with the same narrow-window
 * threshold the main sidebar collapses at (spec 4.3) - two Space menus
 * fighting the main sidebar for width at a 700px window is worse than one
 * collapsing early.
 */
export function VaultSpaces({
  mySpaces, sharedSpaces, activeId, onSelect, onNewSpace,
}: {
  mySpaces: KnownWorkspace[];
  sharedSpaces: KnownWorkspace[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onNewSpace: () => void;
}) {
  const [userCollapsed, setUserCollapsed] = useState(() => {
    try { return localStorage.getItem(COLLAPSED_KEY) === "1"; } catch { return false; }
  });
  const narrow = useNarrowWindow();
  const collapsed = userCollapsed || narrow;
  const toggle = () => setUserCollapsed((c) => {
    try { localStorage.setItem(COLLAPSED_KEY, c ? "0" : "1"); } catch { /* per-machine convenience only */ }
    return !c;
  });

  const heading = (icon: React.ReactNode, text: string, action?: React.ReactNode) => (
    <div className="mb-1.5 flex items-center gap-1.5">
      {icon}
      <span className="flex-1 text-[10px] font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">{text}</span>
      {action}
    </div>
  );

  return (
    <div
      data-testid="vault-spaces"
      className={`${collapsed ? "w-12" : "w-48"} flex shrink-0 flex-col overflow-hidden border-r border-[var(--color-border)] transition-all duration-200`}
    >
      <div className="flex shrink-0 items-center justify-end px-2 py-2">
        {/* Withdrawn while the window is narrow, same as the main sidebar's
            toggle: the width is deciding here, not the user, and a control
            that immediately undid itself would be a control that lies. */}
        {!narrow && (
          <button type="button" onClick={toggle} title={collapsed ? "Expand" : "Collapse"}
            className="flex h-6 w-6 items-center justify-center rounded text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-secondary)]">
            {collapsed ? <ChevronRight size={14} /> : <ChevronLeft size={14} />}
          </button>
        )}
      </div>

      <div className="flex-1 overflow-y-auto pb-3">
        <div className={collapsed ? "px-1.5" : "px-3"}>
          {collapsed ? (
            <button type="button" onClick={onNewSpace} title="New Space" data-testid="vault-new-space"
              className="flex w-full items-center justify-center rounded-md py-2 text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-secondary)] hover:text-[var(--color-text)]">
              <Plus size={16} />
            </button>
          ) : heading(
            <FolderLock size={12} className="text-[var(--color-text-muted)]" />, "My Spaces",
            <button type="button" onClick={onNewSpace} title="New Space" data-testid="vault-new-space"
              className="flex h-4 w-4 items-center justify-center rounded text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-secondary)] hover:text-[var(--color-text)]">
              <Plus size={12} />
            </button>,
          )}
          {mySpaces.length === 0
            ? (!collapsed && <p className="pl-4 text-[11px] text-[var(--color-text-muted)]">No Spaces yet</p>)
            : <div className="space-y-0.5">{mySpaces.map((ws) => <SpaceRow key={ws.id} ws={ws} active={ws.id === activeId} collapsed={collapsed} onClick={() => onSelect(ws.id)} />)}</div>}
        </div>

        {sharedSpaces.length > 0 && (
          <div className={`mt-4 ${collapsed ? "px-1.5" : "px-3"}`}>
            {collapsed
              ? <div className="mx-1 mb-1.5 border-t border-[var(--color-border)]" />
              : heading(<Users size={12} className="text-[var(--color-text-muted)]" />, "Shared with me")}
            <div className="space-y-0.5">{sharedSpaces.map((ws) => <SpaceRow key={ws.id} ws={ws} active={ws.id === activeId} collapsed={collapsed} onClick={() => onSelect(ws.id)} />)}</div>
          </div>
        )}
      </div>
    </div>
  );
}

function SpaceRow({ ws, active, collapsed, onClick }: { ws: KnownWorkspace; active: boolean; collapsed: boolean; onClick: () => void }) {
  const base = active
    ? "bg-[var(--color-bg-secondary)] font-semibold text-[var(--color-text)]"
    : "text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-secondary)] hover:text-[var(--color-text)]";
  if (collapsed) {
    return (
      <button type="button" onClick={onClick} title={ws.name} data-testid={`vault-space-${ws.id}`}
        className={`flex w-full items-center justify-center rounded-md py-2 text-xs font-semibold transition-colors ${base}`}>
        {ws.name.charAt(0).toUpperCase() || "?"}
      </button>
    );
  }
  return (
    <button type="button" onClick={onClick} title={ws.name} data-testid={`vault-space-${ws.id}`}
      className={`flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-xs transition-colors ${base}`}>
      <FolderLock size={14} className="shrink-0" />
      <span className="flex-1 truncate text-left">{ws.name}</span>
    </button>
  );
}
