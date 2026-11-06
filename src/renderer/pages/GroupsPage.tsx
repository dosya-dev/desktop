import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import {
  Layers, Plus, Trash2, Pencil, Check, X, FolderOpen, FileIcon, Loader2,
} from "lucide-react";
import { toast } from "sonner";
import { autoDir, useAutoDir } from "@/lib/bidi-ui";
import { api, ApiError } from "@/lib/api-client";
import { useWorkspace } from "@/lib/workspace-context";
import { humanSize } from "@/lib/file-type";
import {
  getGroups, createGroup, updateGroup, deleteGroup,
  removeFileFromGroup, removeFolderFromGroup,
  DEFAULT_GROUP_COLOR, MAX_GROUP_NAME, type Group,
} from "@/lib/groups-api";
import { SWATCHES, resolveSwatch } from "@/lib/palette";
import { useT } from "@/lib/i18n";
import type { MessageKey } from "../../i18n/keys";

/**
 * A swatch row rather than a colour picker: the colour exists so two groups are told
 * apart at a glance, and a free-form picker would let someone choose a colour invisible
 * on their own theme. The swatches now come from the shared palette (packages/brand),
 * which states a fill per ground, so that last hazard is handled by the token rather
 * than by limiting the choice.
 */

/** Swatch names (lib/palette.ts) to their catalog labels, as SwatchPicker names them. */
const SWATCH_LABELS: Record<string, MessageKey> = {
  green: "common.label.green",
  teal: "common.label.teal",
  blue: "common.label.blue",
  violet: "common.label.violet",
  pink: "common.label.pink",
  orange: "common.label.orange",
  graphite: "common.label.graphite",
};

export function GroupsPage() {
  const ownDir = useAutoDir();
  const { active } = useWorkspace();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const t = useT();
  const swatchLabel = (s: { name: string; label: string }): string =>
    SWATCH_LABELS[s.name] ? t(SWATCH_LABELS[s.name]) : s.label;

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
  const failed = (e: unknown) => toast.error(e instanceof ApiError ? autoDir(e.message) : t("common.error.failed"));

  const createMut = useMutation({
    mutationFn: () => createGroup(active!.id, newName.trim(), newColor),
    onSuccess: () => {
      invalidate();
      setCreating(false);
      setNewName("");
      setNewColor(DEFAULT_GROUP_COLOR);
      toast.success(t("groups.label.groupCreated"));
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
    onSuccess: () => { invalidate(); toast.success(t("groups.label.groupDeleted"), { description: t("groups.description.theFilesAndFoldersInItWereNotTouched") }); },
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
    <div className="space-y-5" data-testid="groups-page">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">{t("groups.heading.groups")}</h1>
          <p className="text-sm text-[var(--color-text-muted)]">
            {t("groups.description.yourOwnShortcutsToFilesAndFoldersOnlyYou")}
          </p>
        </div>
        <button
          data-testid="group-new"
          onClick={() => setCreating(true)}
          className="flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-medium text-[var(--color-primary-fg)]"
          style={{ background: "var(--color-primary)" }}
        >
          <Plus size={14} /> {t("groups.action.newGroup")}
        </button>
      </div>

      {isLoading ? (
        <div className="space-y-3">
          {[1, 2, 3].map((i) => <div key={i} className="h-24 animate-pulse rounded-xl bg-[var(--color-bg-tertiary)]" />)}
        </div>
      ) : isError ? (
        <div className="flex flex-col items-center rounded-xl border py-16" style={{ borderColor: "var(--color-border)" }} data-testid="groups-error">
          <p className="text-sm">{t("groups.error.couldnTLoadYourGroups")}</p>
          <button data-testid="groups-retry" onClick={() => refetch()} className="mt-2 text-xs font-medium text-[var(--color-primary)]">
            {t("common.retry")}
          </button>
        </div>
      ) : list.length === 0 ? (
        <div className="flex flex-col items-center justify-center rounded-xl border py-16" style={{ borderColor: "var(--color-border)" }} data-testid="groups-empty">
          <Layers size={36} className="mb-3 text-[var(--color-text-muted)]" />
          <p className="text-sm font-medium">{t("groups.empty.noGroupsYet")}</p>
          <p className="mt-1 text-xs text-[var(--color-text-muted)]">
            {t("groups.description.groupAnythingYouKeepComingBackToAddItems")}
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
                    <p dir={ownDir} className="flex-1 truncate text-sm font-semibold">{g.name}</p>
                    <span className="text-xs text-[var(--color-text-muted)]">
                      {t("common.label.item", { count: g.files.length + g.folders.length })}
                    </span>
                    <button
                      data-testid={`group-${g.id}-rename`}
                      onClick={() => { setEditingId(g.id); setEditName(g.name); }}
                      title={t("common.action.rename")}
                      className="text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)]"
                    >
                      <Pencil size={13} />
                    </button>
                    <button
                      data-testid={`group-${g.id}-delete`}
                      onClick={() => setDeleteTarget(g)}
                      title={t("groups.action.deleteGroup")}
                      className="text-[var(--color-text-muted)] hover:text-[var(--color-danger)]"
                    >
                      <Trash2 size={13} />
                    </button>
                  </>
                )}
              </div>

              {/* Recolour - shown while editing: a set-and-forget control has
                  no claim to permanent card space. */}
              {editingId === g.id && (
              <div className="mt-2 flex items-center gap-1.5">
                {SWATCHES.map((s) => (
                  <button
                    key={s.name}
                    data-testid={`group-${g.id}-color-${s.name}`}
                    onClick={() => recolourMut.mutate({ id: g.id, color: s.light })}
                    aria-label={t("groups.accessibility.setColourLabel", { label: swatchLabel(s) })}
                    className={`h-4 w-4 rounded-full transition-transform hover:scale-110 ${resolveSwatch(g.color) === s.name ? "ring-2 ring-offset-1" : ""}`}
                    style={{ background: s.light }}
                  />
                ))}
              </div>
              )}

              {g.folders.length === 0 && g.files.length === 0 ? (
                <p className="mt-3 text-xs text-[var(--color-text-muted)]" data-testid={`group-${g.id}-empty`}>
                  {t("groups.description.nothingInThisGroupYet")}
                </p>
              ) : (
                <div className="mt-3 space-y-1.5">
                  {g.folders.map((f) => (
                    <div key={f.item_id} data-testid={`group-folder-${f.folder_id}`} className="flex items-center gap-2 text-xs">
                      <FolderOpen size={12} className="shrink-0 text-[var(--color-text-muted)]" />
                      <button onClick={() => navigate(`/files?folder=${f.folder_id}`)} dir={ownDir} className="flex-1 truncate text-start hover:underline">
                        {f.folder_name}
                      </button>
                      <button
                        data-testid={`group-folder-${f.folder_id}-remove`}
                        onClick={() => removeFolderMut.mutate({ groupId: g.id, folderId: f.folder_id })}
                        title={t("groups.tooltip.removeFromGroup")}
                        className="text-[var(--color-text-muted)] hover:text-[var(--color-danger)]"
                      >
                        <X size={11} />
                      </button>
                    </div>
                  ))}
                  {g.files.map((f) => (
                    <div key={f.item_id} data-testid={`group-file-${f.file_id}`} className="flex items-center gap-2 text-xs">
                      <FileIcon size={12} className="shrink-0 text-[var(--color-text-muted)]" />
                      <button onClick={() => navigate(`/files?panel=${f.file_id}`)} dir={ownDir} className="flex-1 truncate text-start hover:underline">
                        {f.file_name}
                      </button>
                      <span className="text-[var(--color-text-muted)]">{humanSize(f.size_bytes)}</span>
                      <button
                        data-testid={`group-file-${f.file_id}-remove`}
                        onClick={() => removeFileMut.mutate({ groupId: g.id, fileId: f.file_id })}
                        title={t("groups.tooltip.removeFromGroup")}
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
            <h3 className="mb-4 text-lg font-semibold">{t("groups.heading.newGroup")}</h3>
            <input
              data-testid="group-create-name"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && newName.trim() && !nameTooLong) createMut.mutate(); }}
              autoFocus
              placeholder={t("groups.placeholder.eGClientWork")}
              className="w-full rounded-lg border px-3 py-2 text-sm outline-none focus:border-[var(--color-primary)]"
              style={{ borderColor: "var(--color-border)" }}
            />
            {nameTooLong && (
              <p data-testid="group-create-error" className="mt-1 text-xs text-[var(--color-danger)]">
                {t("groups.description.keepTheNameUnderMaxGroupNameCharacters", { maxGroupName: MAX_GROUP_NAME })}
              </p>
            )}
            <div className="mt-3 flex items-center gap-1.5">
              {SWATCHES.map((s) => (
                <button
                  key={s.name}
                  data-testid={`group-create-color-${s.name}`}
                  onClick={() => setNewColor(s.light)}
                  aria-label={t("groups.accessibility.colourLabel", { label: swatchLabel(s) })}
                  className={`h-5 w-5 rounded-full transition-transform hover:scale-110 ${resolveSwatch(newColor) === s.name ? "ring-2 ring-offset-1" : ""}`}
                  style={{ background: s.light }}
                />
              ))}
            </div>
            <div className="mt-5 flex justify-end gap-2">
              <button data-testid="group-create-cancel" onClick={() => setCreating(false)} className="rounded-lg border px-4 py-2 text-sm" style={{ borderColor: "var(--color-border)" }}>
                {t("common.cancel")}
              </button>
              <button
                data-testid="group-create-submit"
                onClick={() => createMut.mutate()}
                disabled={!newName.trim() || nameTooLong || createMut.isPending}
                className="flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-medium text-[var(--color-primary-fg)] disabled:opacity-50"
                style={{ background: "var(--color-primary)" }}
              >
                {createMut.isPending && <Loader2 size={12} className="animate-spin" />}
                {t("common.action.create")}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Delete confirm */}
      {deleteTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30">
          <div className="w-full max-w-sm rounded-xl bg-[var(--color-bg)] p-6 shadow-xl">
            <h3 className="text-lg font-semibold">{t("groups.heading.deleteDeleteTargetName", { deleteTargetName: deleteTarget.name })}</h3>
            <p className="mt-2 text-sm text-[var(--color-text-muted)]">
              {t("groups.description.theGroupGoesTheFilesAndFoldersInIt")}
            </p>
            <div className="mt-5 flex justify-end gap-2">
              <button data-testid="group-delete-cancel" onClick={() => setDeleteTarget(null)} className="rounded-lg border px-4 py-2 text-sm" style={{ borderColor: "var(--color-border)" }}>
                {t("common.cancel")}
              </button>
              <button
                data-testid="group-delete-confirm"
                onClick={() => { const target = deleteTarget; setDeleteTarget(null); deleteMut.mutate(target.id); }}
                className="rounded-lg px-4 py-2 text-sm font-medium text-white"
                style={{ background: "var(--color-danger)" }}
              >
                {t("groups.action.deleteGroup")}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
