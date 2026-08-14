import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import {
  Layers, Plus, Trash2, Pencil, Check, X, FolderOpen, FileIcon, Loader2,
} from "lucide-react";
import { toast } from "sonner";
import { api, ApiError } from "@/lib/api-client";
import { useWorkspace } from "@/lib/workspace-context";
import { humanSize } from "@/lib/file-type";
import {
  getGroups, createGroup, updateGroup, deleteGroup,
  removeFileFromGroup, removeFolderFromGroup,
  DEFAULT_GROUP_COLOR, MAX_GROUP_NAME, type Group,
} from "@/lib/groups-api";

/**
 * A fixed palette rather than a colour picker.
 *
 * The server takes any string, but the colour is decorative - it exists so two
 * groups are told apart at a glance. A swatch row does that without a picker
 * dependency, and without letting someone choose a colour invisible on their
 * own theme.
 */
const SWATCHES = [
  DEFAULT_GROUP_COLOR, "#C2410C", "#B45309", "#4D7C0F",
  "#0F766E", "#1D4ED8", "#6D28D9", "#BE185D",
];

export function GroupsPage() {
  const { active } = useWorkspace();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [newColor, setNewColor] = useState(DEFAULT_GROUP_COLOR);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<Group | null>(null);

  const { data: groups, isLoading, isError, refetch } = useQuery({
    queryKey: ["groups", active?.id],
    queryFn: () => getGroups(active!.id),
    enabled: !!active,
  });

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["groups"] });
  const failed = (e: unknown) => toast.error(e instanceof ApiError ? e.message : "Failed");

  const createMut = useMutation({
    mutationFn: () => createGroup(active!.id, newName.trim(), newColor),
    onSuccess: () => {
      invalidate();
      setCreating(false);
      setNewName("");
      setNewColor(DEFAULT_GROUP_COLOR);
      toast.success("Group created");
    },
    onError: failed,
  });

  const renameMut = useMutation({
    mutationFn: (v: { id: string; name: string }) => updateGroup(v.id, { name: v.name }),
    onSuccess: () => { invalidate(); setEditingId(null); },
    onError: failed,
  });

  const recolourMut = useMutation({
    mutationFn: (v: { id: string; color: string }) => updateGroup(v.id, { color: v.color }),
    onSuccess: invalidate,
    onError: failed,
  });

  const deleteMut = useMutation({
    mutationFn: (id: string) => deleteGroup(id),
    // The group goes; the files and folders in it do not. Saying so stops this
    // reading as a bulk delete.
    onSuccess: () => { invalidate(); toast.success("Group deleted", { description: "The files and folders in it were not touched." }); },
    onError: failed,
  });

  const removeFileMut = useMutation({
    mutationFn: (v: { groupId: string; fileId: string }) => removeFileFromGroup(v.groupId, v.fileId),
    onSuccess: invalidate,
    onError: failed,
  });

  const removeFolderMut = useMutation({
    mutationFn: (v: { groupId: string; folderId: string }) => removeFolderFromGroup(v.groupId, v.folderId),
    onSuccess: invalidate,
    onError: failed,
  });

  const list = groups ?? [];
  const nameTooLong = newName.trim().length > MAX_GROUP_NAME;

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Groups</h1>
          <p className="text-sm text-[var(--color-text-muted)]">
            Your own shortcuts to files and folders - only you see them
          </p>
        </div>
        <button
          data-testid="group-new"
          onClick={() => setCreating(true)}
          className="flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-medium text-white"
          style={{ background: "var(--color-primary)" }}
        >
          <Plus size={14} /> New group
        </button>
      </div>

      {isLoading ? (
        <div className="space-y-3">
          {[1, 2, 3].map((i) => <div key={i} className="h-24 animate-pulse rounded-xl bg-[var(--color-bg-tertiary)]" />)}
        </div>
      ) : isError ? (
        <div className="flex flex-col items-center rounded-xl border py-16" style={{ borderColor: "var(--color-border)" }} data-testid="groups-error">
          <p className="text-sm">Couldn't load your groups.</p>
          <button data-testid="groups-retry" onClick={() => refetch()} className="mt-2 text-xs font-medium text-[var(--color-primary)]">
            Retry
          </button>
        </div>
      ) : list.length === 0 ? (
        <div className="flex flex-col items-center justify-center rounded-xl border py-16" style={{ borderColor: "var(--color-border)" }} data-testid="groups-empty">
          <Layers size={36} className="mb-3 text-[var(--color-text-muted)]" />
          <p className="text-sm font-medium">No groups yet</p>
          <p className="mt-1 text-xs text-[var(--color-text-muted)]">
            Group anything you keep coming back to. Add items from the file browser.
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {list.map((g) => (
            <div key={g.id} data-testid={`group-${g.id}`} className="rounded-xl border p-4" style={{ borderColor: "var(--color-border)" }}>
              <div className="flex items-center gap-2">
                <span className="h-3 w-3 shrink-0 rounded-full" style={{ background: g.color }} data-testid={`group-${g.id}-swatch`} />
                {editingId === g.id ? (
                  <>
                    <input
                      data-testid="group-rename-input"
                      value={editName}
                      onChange={(e) => setEditName(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && editName.trim()) renameMut.mutate({ id: g.id, name: editName.trim() });
                        if (e.key === "Escape") setEditingId(null);
                      }}
                      autoFocus
                      className="flex-1 rounded-lg border px-2 py-1 text-sm outline-none focus:border-[var(--color-primary)]"
                      style={{ borderColor: "var(--color-border)" }}
                    />
                    <button
                      data-testid="group-rename-save"
                      onClick={() => editName.trim() && renameMut.mutate({ id: g.id, name: editName.trim() })}
                      disabled={!editName.trim() || editName.trim().length > MAX_GROUP_NAME}
                      className="text-[var(--color-primary)] disabled:opacity-40"
                    >
                      <Check size={14} />
                    </button>
                    <button data-testid="group-rename-cancel" onClick={() => setEditingId(null)} className="text-[var(--color-text-muted)]">
                      <X size={14} />
                    </button>
                  </>
                ) : (
                  <>
                    <p className="flex-1 truncate text-sm font-semibold">{g.name}</p>
                    <span className="text-xs text-[var(--color-text-muted)]">
                      {g.files.length + g.folders.length} item{g.files.length + g.folders.length === 1 ? "" : "s"}
                    </span>
                    <button
                      data-testid={`group-${g.id}-rename`}
                      onClick={() => { setEditingId(g.id); setEditName(g.name); }}
                      title="Rename"
                      className="text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)]"
                    >
                      <Pencil size={13} />
                    </button>
                    <button
                      data-testid={`group-${g.id}-delete`}
                      onClick={() => setDeleteTarget(g)}
                      title="Delete group"
                      className="text-[var(--color-text-muted)] hover:text-[var(--color-danger)]"
                    >
                      <Trash2 size={13} />
                    </button>
                  </>
                )}
              </div>

              {/* Recolour */}
              <div className="mt-2 flex items-center gap-1.5">
                {SWATCHES.map((c) => (
                  <button
                    key={c}
                    data-testid={`group-${g.id}-color-${c.replace("#", "")}`}
                    onClick={() => recolourMut.mutate({ id: g.id, color: c })}
                    aria-label={`Set colour ${c}`}
                    className={`h-4 w-4 rounded-full transition-transform hover:scale-110 ${g.color.toLowerCase() === c.toLowerCase() ? "ring-2 ring-offset-1" : ""}`}
                    style={{ background: c }}
                  />
                ))}
              </div>

              {g.folders.length === 0 && g.files.length === 0 ? (
                <p className="mt-3 text-xs text-[var(--color-text-muted)]" data-testid={`group-${g.id}-empty`}>
                  Nothing in this group yet.
                </p>
              ) : (
                <div className="mt-3 space-y-1.5">
                  {g.folders.map((f) => (
                    <div key={f.item_id} data-testid={`group-folder-${f.folder_id}`} className="flex items-center gap-2 text-xs">
                      <FolderOpen size={12} className="shrink-0 text-[var(--color-text-muted)]" />
                      <button onClick={() => navigate(`/files?folder=${f.folder_id}`)} className="flex-1 truncate text-left hover:underline">
                        {f.folder_name}
                      </button>
                      <button
                        data-testid={`group-folder-${f.folder_id}-remove`}
                        onClick={() => removeFolderMut.mutate({ groupId: g.id, folderId: f.folder_id })}
                        title="Remove from group"
                        className="text-[var(--color-text-muted)] hover:text-[var(--color-danger)]"
                      >
                        <X size={11} />
                      </button>
                    </div>
                  ))}
                  {g.files.map((f) => (
                    <div key={f.item_id} data-testid={`group-file-${f.file_id}`} className="flex items-center gap-2 text-xs">
                      <FileIcon size={12} className="shrink-0 text-[var(--color-text-muted)]" />
                      <button onClick={() => navigate(`/files?panel=${f.file_id}`)} className="flex-1 truncate text-left hover:underline">
                        {f.file_name}
                      </button>
                      <span className="text-[var(--color-text-muted)]">{humanSize(f.size_bytes)}</span>
                      <button
                        data-testid={`group-file-${f.file_id}-remove`}
                        onClick={() => removeFileMut.mutate({ groupId: g.id, fileId: f.file_id })}
                        title="Remove from group"
                        className="text-[var(--color-text-muted)] hover:text-[var(--color-danger)]"
                      >
                        <X size={11} />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Create */}
      {creating && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30">
          <div className="w-full max-w-sm rounded-xl bg-[var(--color-bg)] p-6 shadow-xl">
            <h3 className="mb-4 text-lg font-semibold">New group</h3>
            <input
              data-testid="group-create-name"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && newName.trim() && !nameTooLong) createMut.mutate(); }}
              autoFocus
              placeholder="e.g. Client work"
              className="w-full rounded-lg border px-3 py-2 text-sm outline-none focus:border-[var(--color-primary)]"
              style={{ borderColor: "var(--color-border)" }}
            />
            {nameTooLong && (
              <p data-testid="group-create-error" className="mt-1 text-xs text-[var(--color-danger)]">
                Keep the name under {MAX_GROUP_NAME} characters.
              </p>
            )}
            <div className="mt-3 flex items-center gap-1.5">
              {SWATCHES.map((c) => (
                <button
                  key={c}
                  data-testid={`group-create-color-${c.replace("#", "")}`}
                  onClick={() => setNewColor(c)}
                  aria-label={`Colour ${c}`}
                  className={`h-5 w-5 rounded-full transition-transform hover:scale-110 ${newColor === c ? "ring-2 ring-offset-1" : ""}`}
                  style={{ background: c }}
                />
              ))}
            </div>
            <div className="mt-5 flex justify-end gap-2">
              <button data-testid="group-create-cancel" onClick={() => setCreating(false)} className="rounded-lg border px-4 py-2 text-sm" style={{ borderColor: "var(--color-border)" }}>
                Cancel
              </button>
              <button
                data-testid="group-create-submit"
                onClick={() => createMut.mutate()}
                disabled={!newName.trim() || nameTooLong || createMut.isPending}
                className="flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
                style={{ background: "var(--color-primary)" }}
              >
                {createMut.isPending && <Loader2 size={12} className="animate-spin" />}
                Create
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Delete confirm */}
      {deleteTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30">
          <div className="w-full max-w-sm rounded-xl bg-[var(--color-bg)] p-6 shadow-xl">
            <h3 className="text-lg font-semibold">Delete "{deleteTarget.name}"?</h3>
            <p className="mt-2 text-sm text-[var(--color-text-muted)]">
              The group goes. The files and folders in it stay exactly where they are.
            </p>
            <div className="mt-5 flex justify-end gap-2">
              <button data-testid="group-delete-cancel" onClick={() => setDeleteTarget(null)} className="rounded-lg border px-4 py-2 text-sm" style={{ borderColor: "var(--color-border)" }}>
                Cancel
              </button>
              <button
                data-testid="group-delete-confirm"
                onClick={() => { const t = deleteTarget; setDeleteTarget(null); deleteMut.mutate(t.id); }}
                className="rounded-lg px-4 py-2 text-sm font-medium text-white"
                style={{ background: "var(--color-danger)" }}
              >
                Delete group
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
