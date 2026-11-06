import { useState, useRef, useEffect } from "react";
import { useLocation } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Settings,
  Palette,
  HardDrive,
  Shield,
  Users,
  AlertTriangle,
  Save,
  Pencil,
  Trash2,
  ImagePlus,
  LogOut,
  Globe,
  Eraser,
  RotateCcw,
  Bug,
  Sparkles,
} from "lucide-react";
import { api, ApiError, apiRequest } from "@/lib/api-client";
import { useWorkspace } from "@/lib/workspace-context";
import { usePermissions } from "@/lib/use-permissions";
import { formatBytes } from "@/lib/format";
import { toast } from "sonner";
import { autoDir, ipcErrorText } from "@/lib/bidi-ui";
import { webAppUrl } from "../lib/web-app-url";
import { SwatchPicker } from "../components/SwatchPicker";
import { openReport } from "../lib/report-problem-store";
import { useWorkspaceIconVersion, workspaceIconUrl } from "@/lib/workspace-icon-version";
import { useT } from "@/lib/i18n";
import { AiSearchSection } from "@/components/settings/AiSearchSection";
import type { MessageKey } from "../../i18n/keys";

/** Shape of GET /api/workspaces/:id. */
interface SettingsResponse {
  ok: boolean;
  workspace: {
    id: string;
    name: string;
    slug: string;
    icon_initials: string;
    icon_color: string;
    icon_image_url: string | null;
  };
  settings: {
    max_file_size_gb: number;
    max_total_storage_gb: number;
    max_storage_per_member_gb: number;
    max_concurrent_uploads: number;
    allowed_extensions: string | null;
    blocked_extensions: string | null;
    require_2fa: number;
    disable_share_links: number;
    force_share_password: number;
    share_max_expiry_days: number | null;
  } | null;
}

type Tab = "general" | "limits" | "security" | "ai-search" | "roles" | "danger";

/**
 * What PUT /api/workspaces/:id/settings demands for the Hard limits form, per
 * field (its fieldPermMap). The form sends all four, so the server wants all
 * four; a caller holding none of them is told so here instead of by the 403.
 */
const LIMIT_PERMISSIONS = [
  "change_max_file_size",
  "change_total_storage_cap",
  "change_storage_per_member",
  "change_max_concurrent_uploads",
] as const;

function isTab(v: string | null): v is Tab {
  return v !== null && TABS.some((t) => t.id === v);
}

const TABS: { id: Tab; label: MessageKey; icon: React.ReactNode }[] = [
  { id: "general", label: "settings.label.general", icon: <Settings size={16} /> },
  { id: "limits", label: "settings.label.hardLimits", icon: <HardDrive size={16} /> },
  { id: "security", label: "settings.label.security", icon: <Shield size={16} /> },
  { id: "ai-search", label: "settings.label.aiSearch", icon: <Sparkles size={16} /> },
  { id: "roles", label: "settings.label.roles", icon: <Users size={16} /> },
  { id: "danger", label: "profile.heading.dangerZone", icon: <AlertTriangle size={16} /> },
];


export function SettingsPage() {
  const t = useT();
  const { active } = useWorkspace();
  const queryClient = useQueryClient();
  // `?tab=<id>` lands the user on a section.
  const location = useLocation();
  const requestedTab = new URLSearchParams(location.search).get("tab");
  // Personas settings are each member's own and live on /personas/settings,
  // not here.
  const [tab, setTab] = useState<Tab>(() => (isTab(requestedTab) ? requestedTab : "general"));
  useEffect(() => { if (isTab(requestedTab)) setTab(requestedTab); }, [requestedTab]);
  const { can } = usePermissions();
  const canSaveLimits = LIMIT_PERMISSIONS.some((p) => can(p));
  // The security toggles are all manage_settings fields on the server.
  const canSaveSecurity = can("manage_settings");

  const tabs = TABS;

  // GET /api/workspaces/:id - NOT /:id/settings, which is PUT-only on the API.
  // The old URL 404'd on every load, so `data` was always undefined: the whole
  // page rendered with blank fields, and the icon uploader's `hasImage` was
  // permanently false, which is why a successful icon upload still showed the
  // initials instead of the new image.
  const { data, isLoading } = useQuery({
    queryKey: ["settings", active?.id],
    queryFn: () => api.get<SettingsResponse>(`/api/workspaces/${active?.id}`),
    enabled: !!active,
  });

  // Local form state
  const [wsName, setWsName] = useState("");
  const [wsColor, setWsColor] = useState("");
  const [maxFileSize, setMaxFileSize] = useState(0);
  const [maxStorage, setMaxStorage] = useState(0);
  const [maxPerMember, setMaxPerMember] = useState(0);
  const [maxConcurrent, setMaxConcurrent] = useState(0);
  const [require2fa, setRequire2fa] = useState(false);
  const [disableShares, setDisableShares] = useState(false);
  const [forceSharePassword, setForceSharePassword] = useState(false);

  // Populate form when data loads
  const workspace = data?.workspace;
  const settings = data?.settings;

  if (workspace && !wsName) {
    setWsName(workspace.name);
    setWsColor(workspace.icon_color);
  }
  if (settings && maxFileSize === 0) {
    setMaxFileSize(settings.max_file_size_gb);
    setMaxStorage(settings.max_total_storage_gb);
    setMaxPerMember(settings.max_storage_per_member_gb);
    setMaxConcurrent(settings.max_concurrent_uploads);
    setRequire2fa(!!settings.require_2fa);
    setDisableShares(!!settings.disable_share_links);
    setForceSharePassword(!!settings.force_share_password);
  }

  const saveGeneralMut = useMutation({
    mutationFn: () =>
      api.put(`/api/workspaces/${active!.id}`, {
        name: wsName,
        icon_color: wsColor,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["settings"] });
      queryClient.invalidateQueries({ queryKey: ["workspaces"] });
      toast.success(t("settings.label.workspaceUpdated"));
    },
    onError: (err) => {
      toast.error(err instanceof ApiError ? autoDir(err.message) : t("settings.error.failedToSave"));
    },
  });

  const saveLimitsMut = useMutation({
    mutationFn: () =>
      api.put(`/api/workspaces/${active!.id}/settings`, {
        max_file_size_gb: maxFileSize,
        max_total_storage_gb: maxStorage,
        max_storage_per_member_gb: maxPerMember,
        max_concurrent_uploads: maxConcurrent,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["settings"] });
      toast.success(t("settings.label.limitsUpdated"));
    },
    onError: (err) => {
      toast.error(err instanceof ApiError ? autoDir(err.message) : t("settings.error.failedToSaveLimits"));
    },
  });

  const saveSecurityMut = useMutation({
    mutationFn: () =>
      api.put(`/api/workspaces/${active!.id}/settings`, {
        require_2fa: require2fa ? 1 : 0,
        disable_share_links: disableShares ? 1 : 0,
        force_share_password: forceSharePassword ? 1 : 0,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["settings"] });
      toast.success(t("settings.label.securitySettingsUpdated"));
    },
    onError: (err) => {
      toast.error(err instanceof ApiError ? autoDir(err.message) : t("settings.error.failedToSaveSecuritySettings"));
    },
  });

  if (isLoading) {
    return (
      <div className="space-y-4" data-testid="settings-page">
        <h1 className="text-2xl font-semibold">{t("common.label.settings")}</h1>
        <div className="h-64 animate-pulse rounded-xl bg-[var(--color-bg-tertiary)]" />
      </div>
    );
  }

  // A dead `PERMISSIONS` array lived here: seven hand-picked keys out of the
  // registry's thirty-five, declared inside the render body and referenced by
  // nothing. This page does not draw a role matrix at all - the Roles section
  // below links out to the web app - so the list was only ever a trap waiting
  // for someone to wire it up and ship a permission table that silently
  // omitted twenty-eight keys, which is precisely the defect the web page's
  // own matrix had (it listed two permissions that do not exist and missed
  // twenty-three that do).

  return (
    <div className="flex h-full gap-6" data-testid="settings-page">
      {/* Sidebar Tabs */}
      <div className="w-48 space-y-1" data-testid="settings-tabs">
        {tabs.map((tb) => (
          <button
            key={tb.id}
            onClick={() => setTab(tb.id)}
            className={`flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-sm transition-colors ${
              tab === tb.id
                ? "bg-[var(--color-primary)]/10 font-medium text-[var(--color-primary)]"
                : "text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-secondary)]"
            }`}
          >
            {tb.icon}
            {t(tb.label)}
          </button>
        ))}
      </div>

      {/* Content */}
      <div className="flex-1">
        {tab === "general" && (
          <Section title={t("settings.tooltip.workspaceInfo")}>
            <div className="space-y-5">
              {/* Workspace icon/photo */}
              <WorkspaceIconUpload
                workspaceId={active?.id ?? ""}
                currentColor={wsColor}
                currentInitials={workspace?.icon_initials ?? "?"}
                hasImage={!!workspace?.icon_image_url}
              />

              <div>
                <label className="mb-1 block text-sm font-medium">{t("common.label.name")}</label>
                <input
                  type="text"
                  value={wsName}
                  onChange={(e) => setWsName(e.target.value)}
                  className="w-full max-w-sm rounded-lg border px-3 py-2 text-sm outline-none focus:border-[var(--color-primary)]"
                  style={{ borderColor: "var(--color-border)" }}
                />
              </div>
              <div>
                <label className="mb-2 block text-sm font-medium">{t("settings.label.iconColor")}</label>
                <p className="mb-2 text-xs text-[var(--color-text-muted)]">{t("settings.label.usedWhenNoCustomPhotoIsSet")}</p>
                <SwatchPicker value={wsColor} onChange={setWsColor} label={t("common.label.workspaceColour")} />
              </div>
              <button
                onClick={() => saveGeneralMut.mutate()}
                disabled={saveGeneralMut.isPending}
                className="flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-medium text-[var(--color-primary-fg)]"
                style={{ background: "var(--color-primary)" }}
              >
                <Save size={14} />
                {t("settings.action.saveChanges")}
              </button>
            </div>
          </Section>
        )}
        {tab === "general" && (
          <div className="mt-6">
            <Section title={t("settings.tooltip.troubleshooting")}>
              <TroubleshootingSection />
            </Section>
          </div>
        )}

        {tab === "limits" && (
          <Section title={t("settings.label.hardLimits")}>
            <div className="space-y-4 max-w-sm">
              <p className="text-xs text-[var(--color-text-muted)]">
                {t("settings.description.setAnyLimitTo0ToLeaveItUnlimited")}
              </p>
              <NumberInput
                label={t("settings.label.maxUploadFileSizeGB")}
                value={maxFileSize}
                onChange={setMaxFileSize}
              />
              <NumberInput
                label={t("settings.label.totalWorkspaceStorageCapGB")}
                value={maxStorage}
                onChange={setMaxStorage}
              />
              <NumberInput
                label={t("settings.label.storagePerMemberGB")}
                value={maxPerMember}
                onChange={setMaxPerMember}
              />
              <NumberInput
                label={t("settings.label.maxSimultaneousUploadsPerMember")}
                value={maxConcurrent}
                onChange={setMaxConcurrent}
              />
              <button
                onClick={() => saveLimitsMut.mutate()}
                disabled={saveLimitsMut.isPending || !canSaveLimits}
                className="flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-medium text-[var(--color-primary-fg)] disabled:opacity-50"
                style={{ background: "var(--color-primary)" }}
              >
                <Save size={14} />
                {t("settings.action.saveLimits")}
              </button>
              {!canSaveLimits && (
                <p className="text-xs text-[var(--color-text-muted)]">
                  {t("settings.description.yourRoleDoesNotAllowChangingTheseLimits")}
                </p>
              )}
            </div>
          </Section>
        )}

        {tab === "security" && (
          <Section title={t("settings.label.security")}>
            <div className="space-y-4 max-w-sm">
              <Toggle
                label={t("settings.label.require2FAForAllMembers")}
                description={t("settings.description.membersMustEnableTwoFactorAuthentication")}
                checked={require2fa}
                onChange={setRequire2fa}
              />
              <Toggle
                label={t("settings.label.disableShareLinks")}
                description={t("settings.label.preventMembersFromCreatingPublicShareLinks")}
                checked={disableShares}
                onChange={setDisableShares}
              />
              <Toggle
                label={t("settings.label.forcePasswordOnShareLinks")}
                description={t("settings.description.allShareLinksMustBePasswordProtected")}
                checked={forceSharePassword}
                onChange={setForceSharePassword}
              />
              <button
                onClick={() => saveSecurityMut.mutate()}
                disabled={saveSecurityMut.isPending || !canSaveSecurity}
                className="flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-medium text-[var(--color-primary-fg)] disabled:opacity-50"
                style={{ background: "var(--color-primary)" }}
              >
                <Save size={14} />
                {t("settings.action.saveSecurity")}
              </button>
              {!canSaveSecurity && (
                <p className="text-xs text-[var(--color-text-muted)]">
                  {t("settings.description.yourRoleDoesNotAllowChangingSecuritySettings")}
                </p>
              )}
            </div>
          </Section>
        )}

        {tab === "ai-search" && active && (
          <Section title={t("settings.label.aiSearch")}>
            <AiSearchSection wsId={active.id} />
          </Section>
        )}

        {tab === "roles" && (
          <Section title={t("settings.tooltip.rolesPermissions")}>
            <div className="rounded-xl border p-6 text-center" style={{ borderColor: "var(--color-border)" }}>
              <Users size={32} className="mx-auto mb-3 text-[var(--color-text-muted)]" />
              <h3 className="text-sm font-semibold">{t("settings.heading.manageRolesPermissions")}</h3>
              <p className="mt-1 text-sm text-[var(--color-text-secondary)]">
                {t("settings.description.createCustomRolesEditPermissionsAndManageAccessControls")}
              </p>
              <button
                onClick={() => window.open(webAppUrl("/settings"), "_blank")}
                className="mt-4 inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-medium text-[var(--color-primary-fg)]"
                style={{ background: "var(--color-primary)" }}
              >
                {t("common.action.openOnWeb")}
              </button>
            </div>
          </Section>
        )}

        {tab === "danger" && (
          <Section title={t("profile.heading.dangerZone")}>
            <DangerZone workspaceId={active?.id ?? ""} workspaceName={workspace?.name ?? ""} />
          </Section>
        )}
      </div>
    </div>
  );
}

/**
 * Leave / delete workspace.
 *
 * Both used to be missing here: "Delete workspace" was a styled button with no
 * onClick at all (it looked live but did nothing when clicked), and there was no
 * way to leave a workspace from the desktop app. Both are irreversible, so both
 * confirm first - matching the web app's danger zone.
 */
/**
 * Leaving and deleting a workspace are both surfaced here, but neither is
 * performed here - each opens the web app instead.
 *
 * Deletion cannot work from the desktop app at all: the server now requires a
 * 6-digit code mailed to the owner plus the workspace name retyped, and that
 * ceremony lives in the web dialog. Leaving is technically a single POST, but
 * shipping one irreversible membership action in-app while its neighbour hands
 * off to the browser is the kind of inconsistency that gets clicked by
 * accident. Both hand off, and the panel says so plainly rather than letting
 * someone discover it from a failed request.
 */
/**
 * The escape hatches for "the app is stuck": a safe cache clear, and a full
 * local reset. Born from a real support case - a session revoked server-side
 * left sync erroring after re-login, and there was nothing in the app the
 * user could reach for. The reset is app-scoped (this device only): nothing
 * in the cloud is touched.
 */
function TroubleshootingSection() {
  const t = useT();
  const [confirmReset, setConfirmReset] = useState(false);
  const [busy, setBusy] = useState<"cache" | "reset" | null>(null);
  const queryClient = useQueryClient();

  const clearCache = async () => {
    setBusy("cache");
    try {
      await window.electronAPI.clearAppCache();
      // Renderer-side caches too: query results and decoded previews are the
      // caches the user can actually see going stale.
      queryClient.invalidateQueries();
      toast.success(t("settings.label.cacheCleared"));
    } catch (err) {
      toast.error(ipcErrorText(err instanceof Error ? err.message : undefined, t("settings.error.failedToClearCache")));
    } finally {
      setBusy(null);
    }
  };

  const factoryReset = async () => {
    setBusy("reset");
    try {
      // Quits and relaunches signed out; nothing to do afterwards.
      await window.electronAPI.factoryReset();
    } catch (err) {
      setBusy(null);
      setConfirmReset(false);
      toast.error(ipcErrorText(err instanceof Error ? err.message : undefined, t("settings.error.resetFailed")));
    }
  };

  return (
    <div className="space-y-5">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h3 className="mb-1 font-semibold">{t("common.heading.reportABug")}</h3>
          <p className="text-sm text-[var(--color-text-secondary)]">
            {t("settings.description.opensASupportTicketWithThisAppSVersion")}
          </p>
        </div>
        <button
          onClick={() => openReport()}
          className="inline-flex shrink-0 items-center gap-2 rounded-lg border px-4 py-2 text-sm font-medium"
          style={{ borderColor: "var(--color-border)" }}
        >
          <Bug size={14} /> {t("settings.action.reportABug")}
        </button>
      </div>

      <div className="border-t" style={{ borderColor: "var(--color-border)" }} />

      <div className="flex items-start justify-between gap-4">
        <div>
          <h3 className="mb-1 font-semibold">{t("settings.heading.clearCache")}</h3>
          <p className="text-sm text-[var(--color-text-secondary)]">
            {t("settings.description.clearsDownloadedPreviewsAndCachedDataYourFilesSync")}
          </p>
        </div>
        <button
          onClick={clearCache}
          disabled={busy !== null}
          className="inline-flex shrink-0 items-center gap-2 rounded-lg border px-4 py-2 text-sm font-medium disabled:opacity-50"
          style={{ borderColor: "var(--color-border)" }}
        >
          <Eraser size={14} /> {busy === "cache" ? t("settings.action.clearing") : t("settings.action.clearCache")}
        </button>
      </div>

      <div className="border-t" style={{ borderColor: "var(--color-border)" }} />

      <div className="flex items-start justify-between gap-4">
        <div>
          <h3 className="mb-1 font-semibold text-[var(--color-danger)]">{t("settings.heading.resetAppDataSentenceCase")}</h3>
          <p className="text-sm text-[var(--color-text-secondary)]">
            {t("settings.description.signsYouOutRemovesAllLocalAppDataIncluding")}
          </p>
        </div>
        <button
          onClick={() => setConfirmReset(true)}
          disabled={busy !== null}
          className="inline-flex shrink-0 items-center gap-2 rounded-lg border px-4 py-2 text-sm font-medium disabled:opacity-50"
          style={{ borderColor: "var(--color-danger)", color: "var(--color-danger)" }}
        >
          <RotateCcw size={14} /> {t("settings.action.resetAppData")}
        </button>
      </div>

      {confirmReset && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div
            className="w-full max-w-md rounded-xl border bg-[var(--color-bg)] p-6 shadow-xl"
            style={{ borderColor: "var(--color-border)" }}
          >
            <h3 className="mb-2 text-lg font-semibold">{t("settings.heading.resetAppDataQuestionSentenceCase")}</h3>
            <p className="mb-3 text-sm text-[var(--color-text-secondary)]">
              {t("settings.description.thisSignsYouOutAndRemovesEverythingTheApp")}
            </p>
            <ul className="mb-4 list-disc space-y-1 ps-5 text-sm text-[var(--color-text-secondary)]">
              <li>{t("settings.label.syncFolderSettingsAndSyncHistory")}</li>
              <li>{t("settings.label.cachedFilesPreviewsAndThumbnails")}</li>
              <li>{t("settings.label.yourSessionOnThisDevice")}</li>
            </ul>
            <p className="mb-5 text-sm text-[var(--color-text-secondary)]">
              {t("settings.description.filesOnYourComputerAndInTheCloudAre")}
            </p>
            <div className="flex justify-end gap-3">
              <button
                onClick={() => setConfirmReset(false)}
                disabled={busy === "reset"}
                className="rounded-lg border px-4 py-2 text-sm font-medium disabled:opacity-50"
                style={{ borderColor: "var(--color-border)" }}
              >
                {t("common.cancel")}
              </button>
              <button
                onClick={factoryReset}
                disabled={busy === "reset"}
                className="rounded-lg bg-[var(--color-danger)] px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
              >
                {busy === "reset" ? t("common.status.resetting") : t("settings.action.resetAndRestart")}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function DangerZone({ workspaceId, workspaceName }: { workspaceId: string; workspaceName: string }) {
  const t = useT();
  const hasName = workspaceName ? "yes" : "no";
  const openInWeb = () => window.open(webAppUrl("/settings#section-danger"), "_blank");

  return (
    <div
      className="rounded-xl border-2 border-dashed p-6"
      style={{ borderColor: "var(--color-danger)" }}
    >
      <div
        className="mb-5 flex items-start gap-2.5 rounded-lg border px-3 py-2.5"
        style={{ borderColor: "var(--color-border)" }}
      >
        <Globe size={15} className="mt-0.5 shrink-0 text-[var(--color-text-secondary)]" />
        <p className="text-sm text-[var(--color-text-secondary)]">
          {t("settings.description.leavingAndDeletingAWorkspaceAreOnlyAvailableIn")}
        </p>
      </div>

      <div className="flex items-start justify-between gap-4">
        <div>
          <h3 className="mb-1 font-semibold">{t("settings.heading.leaveWorkspace")}</h3>
          <p className="text-sm text-[var(--color-text-secondary)]">
            {t("settings.description.youWillLoseAccessToWorkspaceNameAndItsFiles", { hasName, workspaceName })}
          </p>
        </div>
        <button
          onClick={openInWeb}
          disabled={!workspaceId}
          className="inline-flex shrink-0 items-center gap-2 rounded-lg border px-4 py-2 text-sm font-medium disabled:opacity-50"
          style={{ borderColor: "var(--color-danger)", color: "var(--color-danger)" }}
        >
          <LogOut size={14} className="rtl:-scale-x-100" /> {t("settings.action.leaveOnWeb")}
        </button>
      </div>

      <div className="my-5 border-t" style={{ borderColor: "var(--color-border)" }} />

      <div className="flex items-start justify-between gap-4">
        <div>
          <h3 className="mb-1 font-semibold text-[var(--color-danger)]">{t("settings.heading.deleteWorkspace")}</h3>
          <p className="text-sm text-[var(--color-text-secondary)]">
            {t("settings.error.permanentlyDeletesWorkspaceNameAndEveryFileInItThis", { hasName, workspaceName })}
          </p>
        </div>
        <button
          onClick={openInWeb}
          disabled={!workspaceId}
          className="inline-flex shrink-0 items-center gap-2 rounded-lg bg-[var(--color-danger)] px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
        >
          <Trash2 size={14} /> {t("settings.action.deleteOnWeb")}
        </button>
      </div>
    </div>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <h2 className="mb-4 text-lg font-semibold">{title}</h2>
      {children}
    </div>
  );
}

function NumberInput({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
}) {
  return (
    <div>
      <label className="mb-1 block text-sm font-medium">{label}</label>
      <input
        type="number"
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        min={0}
        className="w-full rounded-lg border px-3 py-2 text-sm outline-none focus:border-[var(--color-primary)]"
        style={{ borderColor: "var(--color-border)" }}
      />
    </div>
  );
}

function Toggle({
  label,
  description,
  checked,
  onChange,
}: {
  label: string;
  description: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div>
        <p className="text-sm font-medium">{label}</p>
        <p className="text-xs text-[var(--color-text-muted)]">{description}</p>
      </div>
      <button
        onClick={() => onChange(!checked)}
        className={`relative h-6 w-11 shrink-0 rounded-full transition-colors ${
          checked ? "bg-[var(--color-primary)]" : "bg-[var(--color-border)]"
        }`}
      >
        <div
          className={`absolute top-0.5 h-5 w-5 rounded-full bg-[var(--color-bg)] shadow transition-transform ${
            // rtl-ok: mirrored, the rtl: twin slides the knob the other way
            checked ? "translate-x-5 rtl:-translate-x-5" : "translate-x-0.5 rtl:-translate-x-0.5"
          }`}
        />
      </button>
    </div>
  );
}

function WorkspaceIconUpload({
  workspaceId,
  currentColor,
  currentInitials,
  hasImage,
}: {
  workspaceId: string;
  currentColor: string;
  currentInitials: string;
  hasImage: boolean;
}) {
  const t = useT();
  const queryClient = useQueryClient();
  const fileRef = useRef<HTMLInputElement>(null);
  const [apiBase, setApiBase] = useState("");
  // Cache-buster for the icon URL, which is a fixed path. Shared with the
  // sidebar and the workspace switcher, so an upload repaints every
  // workspace badge, not just this preview.
  const imgKey = useWorkspaceIconVersion((s) => s.version);
  const bumpIcon = useWorkspaceIconVersion((s) => s.bump);

  useEffect(() => {
    window.electronAPI.getApiBase().then(setApiBase);
  }, []);

  const uploadMut = useMutation({
    mutationFn: (file: File) => {
      const fd = new FormData();
      fd.append("icon", file);
      return apiRequest(`/api/workspaces/${workspaceId}/icon`, { method: "POST", body: fd });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["settings"] });
      queryClient.invalidateQueries({ queryKey: ["workspaces"] });
      bumpIcon();
      toast.success(t("settings.label.workspaceIconUpdated"));
    },
    onError: (e) => toast.error(e instanceof ApiError ? autoDir(e.message) : t("settings.error.failedToUpload")),
  });

  const deleteMut = useMutation({
    mutationFn: () => api.delete(`/api/workspaces/${workspaceId}/icon`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["settings"] });
      queryClient.invalidateQueries({ queryKey: ["workspaces"] });
      bumpIcon();
      toast.success(t("settings.label.iconRemoved"));
    },
  });

  return (
    <div>
      <label className="mb-2 block text-sm font-medium">{t("settings.label.workspaceIcon")}</label>
      <div className="flex items-center gap-4">
        <div className="group relative">
          {hasImage && apiBase ? (
            <img
              key={imgKey}
              src={workspaceIconUrl(apiBase, workspaceId, imgKey)}
              alt={t("settings.label.workspaceIcon")}
              className="h-16 w-16 rounded-xl object-cover"
            />
          ) : (
            <div
              className="flex h-16 w-16 items-center justify-center rounded-xl text-lg font-bold text-white"
              style={{ background: currentColor }}
            >
              {currentInitials}
            </div>
          )}
          <button
            onClick={() => fileRef.current?.click()}
            className="absolute inset-0 flex items-center justify-center rounded-xl bg-black/40 text-white opacity-0 transition-opacity group-hover:opacity-100"
          >
            <Pencil size={16} />
          </button>
          <input
            ref={fileRef}
            type="file"
            accept="image/png,image/jpeg,image/webp,image/gif"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) uploadMut.mutate(file);
              e.target.value = "";
            }}
          />
        </div>
        <div>
          <button
            onClick={() => fileRef.current?.click()}
            className="flex items-center gap-1.5 text-xs font-medium text-[var(--color-primary)] hover:underline"
          >
            <ImagePlus size={12} />
            {hasImage ? t("settings.action.changePhoto") : t("settings.action.uploadPhoto")}
          </button>
          {hasImage && (
            <button
              onClick={() => deleteMut.mutate()}
              className="mt-1 flex items-center gap-1.5 text-xs text-[var(--color-danger)] hover:underline"
            >
              <Trash2 size={12} />
              {t("settings.action.removePhoto")}
            </button>
          )}
          <p className="mt-1 text-xs text-[var(--color-text-muted)]">
            {t("common.label.pngJPEGWebPOrGIFMax2MB")}
          </p>
        </div>
      </div>
    </div>
  );
}
