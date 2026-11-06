import { useEffect, useRef, useState } from "react";
import { ShieldCheck, LogOut, Folder, File, Upload, Download, ChevronRight, Users, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { useVault, spaceName, vaultErrorDir, type EncryptedEntry } from "@/lib/vault/store";
import { useT } from "@/lib/i18n";
import { useWorkspace } from "@/lib/workspace-context";
import { readDroppedEntries } from "@/lib/dropped-entries";
import { Modal } from "@/components/files/Modal";
import { VaultSpaces } from "./VaultSpaces";
import { Notice, VaultButton, VaultInput, VaultLabel } from "./ui";
import { useAutoDir } from "@/lib/bidi-ui";

/**
 * The unlocked Vault: pick or create a Space, browse its client-decrypted
 * contents, upload and download. Owns the split layout (Space menu + content)
 * because the Space list and the breadcrumb `folderPath` change together.
 * Entries carry only a name and kind; there is no thumbnail, share or comment
 * metadata inside a Space, so the cards are deliberately light.
 */
export function VaultBrowser({ renderMembers }: { renderMembers?: (props: { workspaceName: string; onClose: () => void }) => React.ReactNode } = {}) {
  const ownDir = useAutoDir();
  const t = useT();
  const workspaces = useVault((s) => s.workspaces);
  const activeWorkspaceId = useVault((s) => s.activeWorkspaceId);
  const entries = useVault((s) => s.entries);
  const busy = useVault((s) => s.busy);
  const loadingFolder = useVault((s) => s.loadingFolder);
  const uploading = useVault((s) => s.uploading);
  const error = useVault((s) => s.error);
  const lock = useVault((s) => s.lock);
  const createWorkspace = useVault((s) => s.createWorkspace);
  const openWorkspace = useVault((s) => s.openWorkspace);
  const refreshMyWorkspaces = useVault((s) => s.refreshMyWorkspaces);
  const refreshFolder = useVault((s) => s.refreshFolder);
  const refreshMembers = useVault((s) => s.refreshMembers);
  const uploadFiles = useVault((s) => s.uploadFiles);
  const downloadEntry = useVault((s) => s.downloadEntry);
  // The active STORAGE workspace, from React context: decides which own
  // Spaces show under "My Spaces". Re-renders on a switch, which re-filters.
  const activeGlobalId = useWorkspace().active?.id ?? null;

  const [newOpen, setNewOpen] = useState(false);
  const [newName, setNewName] = useState("");
  const [membersOpen, setMembersOpen] = useState(false);
  const [dragging, setDragging] = useState(false);
  // Subfolder navigation lives here: the store's folder actions take a
  // folderId and listFolder can return kind:'folder' entries.
  const [folderPath, setFolderPath] = useState<{ id: string; name: string }[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const activeWorkspace = workspaces.find((w) => w.id === activeWorkspaceId) ?? null;
  const activeName = activeWorkspace ? spaceName(activeWorkspace, t) : "";
  const currentFolderId = folderPath.length > 0 ? folderPath[folderPath.length - 1].id : "";
  const mySpaces = workspaces.filter((w) => !w.shared && (w.globalWorkspaceId === activeGlobalId || w.globalWorkspaceId == null));
  const sharedSpaces = workspaces.filter((w) => w.shared);

  // Right after unlock, and whenever the storage workspace changes: pull in
  // this account's Spaces (own + shared) so a fresh invite shows up unasked.
  useEffect(() => {
    refreshMyWorkspaces();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeGlobalId]);

  const selectSpace = async (id: string) => {
    setFolderPath([]);
    await openWorkspace(id);
    // Only list if the open succeeded. A failed open sets `error` and, when
    // the Space was already the active one, leaves `activeWorkspaceId` as it
    // was - so the id check alone is not enough.
    const s = useVault.getState();
    if (!s.error && s.activeWorkspaceId === id) {
      await refreshFolder("");
      await refreshMembers();
    }
  };

  const create = async () => {
    const name = newName.trim();
    if (!name) return;
    await createWorkspace(name);
    const s = useVault.getState();
    if (!s.error && s.activeWorkspaceId) {
      setNewOpen(false); setNewName(""); setFolderPath([]);
      await refreshFolder("");
    }
  };

  const openFolder = async (entry: EncryptedEntry) => {
    setFolderPath((p) => [...p, { id: entry.id, name: entry.name }]);
    await refreshFolder(entry.id);
  };

  const crumb = async (index: number) => {
    const next = index < 0 ? [] : folderPath.slice(0, index + 1);
    setFolderPath(next);
    await refreshFolder(next.length ? next[next.length - 1].id : "");
  };

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault(); e.stopPropagation(); setDragging(false);
    if (!activeWorkspaceId || useVault.getState().busy) return;
    // A Space encrypts files one at a time and has no folder import yet: a
    // dropped folder contributes only its loose files, and says so.
    void readDroppedEntries(e.dataTransfer).then((tree) => {
      const loose = tree.entries.filter((en) => en.path === "").map((en) => en.file);
      if (loose.length > 0) uploadFiles(loose, currentFolderId);
      if (tree.hadDirectory) {
        toast.info(t("vault.error.foldersAreNotSupportedInTheVaultYet"), {
          description: loose.length > 0
            ? t("vault.description.uploadedLooseFileDropTheFolderSFilesDirectly", { looseCount: loose.length })
            : t("vault.description.dropTheFolderSFilesDirectlyToEncryptThem"),
        });
      }
    });
  };

  return (
    <div className="flex h-full overflow-hidden" data-testid="vault-browser">
      <VaultSpaces mySpaces={mySpaces} sharedSpaces={sharedSpaces} activeId={activeWorkspaceId} onSelect={selectSpace} onNewSpace={() => setNewOpen(true)} />

      <div className="min-w-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-6xl flex-col gap-5 px-4 py-4">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <span className="inline-flex items-center gap-1 rounded-full bg-[var(--color-bg-secondary)] px-2 py-0.5 text-[11px] font-medium text-[var(--color-text-secondary)]">
                <ShieldCheck size={12} className="text-[var(--color-primary)]" /> {t("vault.label.endToEndEncrypted")}
              </span>
              <h1 className="text-lg font-semibold text-[var(--color-text)]">Vault</h1>
            </div>
            <VaultButton variant="outline" size="sm" onClick={() => lock()} data-testid="vault-lock"><LogOut size={14} className="rtl:-scale-x-100" /> {t("common.action.lock")}</VaultButton>
          </div>

          {error && <Notice tone="danger" dir={vaultErrorDir(error)}>{error}</Notice>}

          {activeWorkspace ? (
            <div className="relative min-h-64 rounded-xl border border-dashed border-[var(--color-border)] p-4"
              data-testid="vault-drop-target"
              onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); if (!useVault.getState().busy) setDragging(true); }}
              onDragLeave={(e) => { e.preventDefault(); e.stopPropagation(); if (e.currentTarget === e.target) setDragging(false); }}
              onDrop={onDrop}>
              {dragging && (
                <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-xl border-2 border-dashed border-[var(--color-primary)] bg-[var(--color-primary)]/5">
                  <div className="flex flex-col items-center gap-2 text-[var(--color-primary)]">
                    <Upload size={40} />
                    <p className="text-sm font-semibold">{t("vault.label.dropFilesToEncryptUpload")}</p>
                  </div>
                </div>
              )}

              <div className="mb-3 flex items-center justify-between gap-3">
                <div className="flex min-w-0 items-center gap-1 text-xs">
                  <button type="button" onClick={() => crumb(-1)} dir={activeWorkspace?.stub === true ? undefined : ownDir} className="truncate font-medium text-[var(--color-text-secondary)] hover:text-[var(--color-text)]" data-testid="vault-crumb-root">{activeName}</button>
                  {folderPath.map((f, i) => (
                    <span key={f.id} className="flex shrink-0 items-center gap-1">
                      <ChevronRight size={12} className="text-[var(--color-text-muted)] rtl:-scale-x-100" />
                      <button type="button" onClick={() => crumb(i)} dir={ownDir} className="max-w-32 truncate text-[var(--color-text-secondary)] hover:text-[var(--color-text)]" title={f.name}>{f.name}</button>
                    </span>
                  ))}
                </div>
                <div className="flex shrink-0 items-center gap-1.5">
                  <VaultButton variant="outline" size="sm" onClick={() => setMembersOpen(true)} data-testid="vault-members"><Users size={14} /> {t("common.action.members")}</VaultButton>
                  <VaultButton size="sm" onClick={() => fileInputRef.current?.click()} disabled={busy} data-testid="vault-upload"><Upload size={14} /> {t("common.action.upload")}</VaultButton>
                </div>
                <input ref={fileInputRef} type="file" multiple className="hidden" data-testid="vault-upload-input"
                  onChange={(e) => { if (e.target.files?.length) uploadFiles(e.target.files, currentFolderId); e.target.value = ""; }} />
              </div>

              {/* Skeletons only while there is nothing to show yet: a first
                  listing or a Space being opened. An upload or download used
                  to blank the whole grid for as long as it ran (QA TC-056);
                  the existing files now stay and the upload gets its own card. */}
              {entries.length === 0 && !uploading && (loadingFolder || busy) ? (
                <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-4" data-testid="vault-busy">
                  {Array.from({ length: 8 }).map((_, i) => <div key={i} className="aspect-[3/2] w-full animate-pulse rounded-xl bg-[var(--color-bg-secondary)]" />)}
                </div>
              ) : entries.length === 0 && !uploading ? (
                <div className="flex flex-col items-center justify-center py-16 text-center" data-testid="vault-empty-folder">
                  <Folder size={40} className="mb-3 text-[var(--color-text-muted)]/40" />
                  <p className="text-sm text-[var(--color-text-secondary)]">{t("vault.description.noFilesYetUploadToGetStarted")}</p>
                </div>
              ) : (
                <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-4">
                  {uploading && <UploadingCard name={uploading.name} index={uploading.index} total={uploading.total} />}
                  {entries.map((entry) => entry.kind === "folder"
                    ? <FolderCard key={entry.id} entry={entry} onOpen={() => openFolder(entry)} />
                    : <FileCard key={entry.id} entry={entry} onDownload={() => downloadEntry(entry.id, entry.name, currentFolderId)} />)}
                </div>
              )}
            </div>
          ) : (
            <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-[var(--color-border)] py-16 text-center" data-testid="vault-empty-space">
              <ShieldCheck size={40} className="mb-3 text-[var(--color-text-muted)]/40" />
              <p className="text-sm text-[var(--color-text-secondary)]">{t("vault.description.selectOrCreateASpaceToGetStarted")}</p>
            </div>
          )}
        </div>
      </div>

      {newOpen && (
        <Modal onClose={() => setNewOpen(false)} maxWidth={400}>
          <div className="space-y-3" data-testid="vault-new-space-modal">
            <h2 className="text-base font-semibold">{t("vault.heading.newSpace")}</h2>
            <div>
              <VaultLabel htmlFor="vault-new-space-name">{t("common.label.name")}</VaultLabel>
              <VaultInput id="vault-new-space-name" autoFocus value={newName} onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") create(); }} placeholder={t("vault.placeholder.eGPersonalDocuments")} />
            </div>
            <div className="flex justify-end gap-2">
              <VaultButton variant="outline" onClick={() => setNewOpen(false)}>{t("common.cancel")}</VaultButton>
              <VaultButton onClick={create} disabled={!newName.trim() || busy} data-testid="vault-new-space-create">{t("common.action.create")}</VaultButton>
            </div>
          </div>
        </Modal>
      )}

      {membersOpen && activeWorkspace && renderMembers?.({ workspaceName: activeName, onClose: () => setMembersOpen(false) })}
    </div>
  );
}

/** The file being encrypted and uploaded, shown in the grid where it will land. */
function UploadingCard({ name, index, total }: { name: string; index: number; total: number }) {
  const ownDir = useAutoDir();
  const t = useT();
  return (
    <div data-testid="vault-uploading" role="status"
      className="relative aspect-[3/2] overflow-hidden rounded-xl border border-dashed border-[var(--color-primary)] bg-[var(--color-bg-secondary)]">
      <div className="absolute inset-0 flex items-center justify-center">
        <Loader2 size={28} className="animate-spin text-[var(--color-primary)]" />
      </div>
      <div className="absolute inset-x-0 bottom-0 p-2.5">
        <p dir={ownDir} className="truncate font-mono text-sm font-semibold text-[var(--color-text)]" title={name}>{name}</p>
        <p className="text-[11px] text-[var(--color-text-secondary)]">
          {t("upload.heading.uploading")}{total > 1 ? ` · ${index} / ${total}` : ""}
        </p>
      </div>
    </div>
  );
}

function FolderCard({ entry, onOpen }: { entry: EncryptedEntry; onOpen: () => void }) {
  const ownDir = useAutoDir();
  const t = useT();
  return (
    <button type="button" onClick={onOpen} data-testid={`vault-entry-${entry.id}`}
      className="rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)] p-3 text-start transition-all hover:-translate-y-px hover:shadow-md">
      <Folder size={24} className="mb-2 text-[var(--color-text-secondary)]" />
      <p dir={ownDir} className="truncate text-xs font-medium text-[var(--color-text)]" title={entry.name}>{entry.name}</p>
      <p className="text-[10px] text-[var(--color-text-muted)]">{t("vault.label.encryptedFolder")}</p>
    </button>
  );
}

function FileCard({ entry, onDownload }: { entry: EncryptedEntry; onDownload: () => void }) {
  const ownDir = useAutoDir();
  const t = useT();
  const ext = entry.name.split(".").pop()?.toUpperCase() || t("vault.label.fileBadge");
  return (
    <div data-testid={`vault-entry-${entry.id}`}
      className="group relative aspect-[3/2] overflow-hidden rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-secondary)] transition-all hover:-translate-y-px hover:shadow-lg">
      <div className="absolute inset-0 flex items-center justify-center"><File size={32} className="text-[var(--color-text-muted)]/60" /></div>
      <div className="pointer-events-none absolute inset-x-0 bottom-0 h-3/5 bg-gradient-to-t from-black/80 via-black/40 to-transparent" />
      <span className="absolute inset-e-2 top-2 rounded-full bg-black/45 px-2 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-wider text-white backdrop-blur-sm">{ext}</span>
      <button type="button" title={t("common.action.download")} data-testid={`vault-download-${entry.id}`}
        onClick={(e) => { e.stopPropagation(); onDownload(); }}
        className="absolute bottom-2 inset-e-2 z-10 flex h-8 w-8 items-center justify-center rounded-full bg-black/35 opacity-0 backdrop-blur-sm transition-opacity hover:bg-black/55 group-hover:opacity-100 focus:opacity-100">
        <Download size={16} className="text-white" />
      </button>
      <p dir={ownDir} className="absolute inset-x-0 bottom-0 z-0 truncate p-2.5 pe-12 font-mono text-sm font-semibold text-white drop-shadow" title={entry.name}>{entry.name}</p>
    </div>
  );
}
