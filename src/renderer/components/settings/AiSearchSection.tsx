// apps/desktop/src/renderer/components/settings/AiSearchSection.tsx
//
// The "AI search" tab of workspace Settings. Port of
// apps/web/src/pages/settings/ai-search.tsx - keep the behaviour and copy in
// step with it.
//
// GET  /api/workspaces/:id/ai-search  settings + status + can_edit, any member
// PUT  same path                      owner or change_ai_search: { enabled?, index_existing?, excluded_folders? }
//
// Only the controls live here; the indexing status is a card on the
// dashboard. `status.limits === null` means the owner's plan has no AI
// search: the switch is disabled with the upgrade text (but stays usable to
// switch OFF a workspace that is still on after a downgrade).
//
// Excluded folders arrive as bare ids. Their names come from the workspace's
// folder tree (/api/folders/tree, the same query and key the map filter and
// the pickers use), which the "Add folder" picker needs anyway - one request
// instead of one GET /api/folders/:id per excluded folder as on the web.
import { useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { FolderX, Loader2, Plus, X } from "lucide-react";
import { toast } from "sonner";
import { api, ApiError } from "@/lib/api-client";
import { autoDir, useAutoDir } from "@/lib/bidi-ui";
import { useT } from "@/lib/i18n";
import { webAppUrl } from "@/lib/web-app-url";
import { FolderPickerModal, type PickerFolder } from "@/components/files/FolderPickerModal";
import {
  aiSearchKey, fetchWorkspaceAiSearch, forgetContentAvailability, updateWorkspaceAiSearch,
  type AiSearchSettings, type AiSearchSettingsResponse,
} from "@/lib/ai-search";

export function AiSearchSection({ wsId }: { wsId: string }) {
  const t = useT();
  const ownDir = useAutoDir();
  const queryClient = useQueryClient();
  const [saving, setSaving] = useState<keyof AiSearchSettings | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [picked, setPicked] = useState<string | null>(null);

  // A failed load leaves only the description: AI search is optional.
  const { data } = useQuery({
    queryKey: aiSearchKey(wsId),
    queryFn: () => fetchWorkspaceAiSearch(wsId),
    enabled: !!wsId,
  });

  const excluded = data?.settings.excluded_folders ?? [];
  const tree = useQuery({
    queryKey: ["folders-tree", wsId],
    queryFn: () => api.get<{ ok: boolean; folders: PickerFolder[] }>(`/api/folders/tree?workspace_id=${wsId}`),
    enabled: !!wsId && (excluded.length > 0 || pickerOpen),
  });
  const folders = tree.data?.folders ?? [];

  const saveMut = useMutation({
    mutationFn: ({ body }: { field: keyof AiSearchSettings; body: Partial<AiSearchSettings> }) => updateWorkspaceAiSearch(wsId, body),
    onMutate: ({ field }) => setSaving(field),
    onSuccess: (settings) => {
      if (settings) {
        queryClient.setQueryData<AiSearchSettingsResponse | null>(aiSearchKey(wsId), (d) => (d ? { ...d, settings } : d));
      }
      forgetContentAvailability(wsId);
      toast.success(t("settings.feedback.settingsUpdated"));
      void queryClient.invalidateQueries({ queryKey: aiSearchKey(wsId) });
    },
    onError: (err) => {
      const code = err instanceof ApiError && typeof err.data.error === "string" ? err.data.error : null;
      const msg = code === "ai_search_not_in_plan" ? t("settings.description.aiSearchIsAvailableOnPaidPlans")
        : code === "ai_search_needs_object_home" || code === "ai_search_unavailable_for_vault" ? t("settings.error.aiSearchIsNotAvailableForThisWorkspace")
        : code === "rate_limited" ? t("settings.error.tooManyChangesTryAgainInAMinute")
        : err instanceof Error ? autoDir(err.message) : undefined;
      toast.error(t("settings.error.failedToSave"), msg ? { description: msg } : undefined);
    },
    onSettled: () => setSaving(null),
  });

  const intro = (
    <p className="mb-4 max-w-xl text-sm text-[var(--color-text-secondary)]">
      {t("settings.description.findsFilesByWhatTheyAreAboutByTextInsideDocumentsAndImages")}
    </p>
  );
  if (!data) return intro;

  const { settings, status } = data;
  const canEdit = data.can_edit;
  const inPlan = status.limits !== null;
  const save = (field: keyof AiSearchSettings, body: Partial<AiSearchSettings>) => saveMut.mutate({ field, body });

  // Switching ON needs the plan; switching OFF is always allowed.
  const switchDisabled = !canEdit || saving !== null || (!inPlan && !settings.enabled);
  const controlsDisabled = !canEdit || saving !== null;
  const switchDesc = !inPlan ? t("settings.description.aiSearchIsAvailableOnPaidPlans")
    : !canEdit ? t("settings.description.youDoNotHavePermissionToChangeAiSearch")
    : null;

  const nameOf = (id: string) => folders.find((f) => f.id === id)?.name
    ?? (tree.isSuccess || tree.isError ? t("file-requests.label.unknownFolder") : "…");
  // A folder already on the list (and so its subtree) is not offered again.
  const pickable = folders.filter((f) => !excluded.includes(f.id));

  const openPicker = () => { setPicked(null); setPickerOpen(true); };
  const addFolder = () => {
    setPickerOpen(false);
    if (!picked || excluded.includes(picked)) return;
    save("excluded_folders", { excluded_folders: [...excluded, picked] });
  };
  const removeFolder = (id: string) => save("excluded_folders", { excluded_folders: excluded.filter((f) => f !== id) });

  const border = { borderColor: "var(--color-border)" };

  return (
    <div data-testid="ai-search-section">
      {intro}

      <div className="max-w-xl divide-y rounded-xl border" style={border}>
        <Row label={t("settings.label.searchInsideFilesAndPhotos")} desc={switchDesc}>
          <div className="flex items-center gap-2">
            {!inPlan && (
              <button
                type="button"
                onClick={() => window.open(webAppUrl("/billing"), "_blank")}
                className="rounded-lg border px-2.5 py-1 text-xs font-medium hover:bg-[var(--color-bg-secondary)]"
                style={border}
              >
                {t("common.action.seePlans")}
              </button>
            )}
            {saving === "enabled" && <Loader2 size={12} className="animate-spin text-[var(--color-text-muted)]" />}
            <button
              type="button"
              role="switch"
              aria-checked={settings.enabled}
              aria-label={t("settings.label.searchInsideFilesAndPhotos")}
              disabled={switchDisabled}
              onClick={() => save("enabled", { enabled: !settings.enabled })}
              className={`relative h-6 w-11 shrink-0 rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
                settings.enabled ? "bg-[var(--color-primary)]" : "bg-[var(--color-border)]"
              }`}
            >
              <div
                className={`absolute top-0.5 h-5 w-5 rounded-full bg-[var(--color-bg)] shadow transition-transform ${
                  // rtl-ok: mirrored, the rtl: twin slides the knob the other way
                  settings.enabled ? "translate-x-5 rtl:-translate-x-5" : "translate-x-0.5 rtl:-translate-x-0.5"
                }`}
              />
            </button>
          </div>
        </Row>

        <Row label={t("settings.label.alsoIndexExistingFiles")}>
          <label className="flex items-center gap-2">
            {saving === "index_existing" && <Loader2 size={12} className="animate-spin text-[var(--color-text-muted)]" />}
            <input
              type="checkbox"
              checked={settings.index_existing}
              disabled={controlsDisabled}
              aria-label={t("settings.label.alsoIndexExistingFiles")}
              onChange={(e) => save("index_existing", { index_existing: e.target.checked })}
              className="h-4 w-4 accent-[var(--color-primary)] disabled:opacity-50"
            />
          </label>
        </Row>

        <div className="px-4 py-4">
          <div className="flex items-center justify-between gap-4">
            <div className="min-w-0">
              <p className="text-sm font-medium">{t("settings.label.excludeFolders")}</p>
              <p className="mt-0.5 text-xs text-[var(--color-text-muted)]">{t("settings.description.filesInTheseFoldersAreNotIndexed")}</p>
            </div>
            <button
              type="button"
              disabled={controlsDisabled}
              onClick={openPicker}
              className="inline-flex shrink-0 items-center gap-1 rounded-lg border px-2.5 py-1 text-xs font-medium hover:bg-[var(--color-bg-secondary)] disabled:opacity-50"
              style={border}
            >
              {saving === "excluded_folders" ? <Loader2 size={12} className="animate-spin" /> : <Plus size={12} />}
              {t("settings.action.addFolder")}
            </button>
          </div>
          {excluded.length > 0 && (
            <ul className="mt-3 flex flex-wrap gap-1.5">
              {excluded.map((id) => (
                <li key={id} className="inline-flex items-center gap-1 rounded-md border bg-[var(--color-bg-secondary)] py-0.5 ps-2 pe-1 text-xs" style={border}>
                  <FolderX size={12} className="text-[var(--color-text-muted)]" />
                  <span className="max-w-48 truncate" dir={ownDir ?? "auto"}>{nameOf(id)}</span>
                  <button
                    type="button"
                    aria-label={t("common.remove")}
                    disabled={controlsDisabled}
                    onClick={() => removeFolder(id)}
                    className="rounded p-0.5 hover:bg-[var(--color-bg-tertiary)] disabled:opacity-50"
                  >
                    <X size={12} />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      {settings.enabled && (
        <p className="mt-4 text-xs text-[var(--color-text-muted)]">
          <Link to="/dashboard" className="font-medium text-[var(--color-text)] underline underline-offset-2 hover:no-underline">
            {t("settings.action.seeIndexingStatusOnTheDashboard")}
          </Link>
        </p>
      )}

      {pickerOpen && (
        <FolderPickerModal
          title={t("settings.label.excludeFolders")}
          actionLabel={t("settings.action.addFolder")}
          folders={pickable}
          selectedId={picked}
          isPending={tree.isLoading}
          onSelect={setPicked}
          onConfirm={addFolder}
          onClose={() => setPickerOpen(false)}
        />
      )}
    </div>
  );
}

function Row({ label, desc, children }: { label: string; desc?: string | null; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 px-4 py-4">
      <div className="min-w-0">
        <p className="text-sm font-medium">{label}</p>
        {desc && <p className="mt-0.5 text-xs text-[var(--color-text-muted)]">{desc}</p>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}
