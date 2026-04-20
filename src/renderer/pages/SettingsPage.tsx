import { useState, useRef, useEffect } from "react";
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
} from "lucide-react";
import { api, ApiError, apiRequest } from "@/lib/api-client";
import { useWorkspace } from "@/lib/workspace-context";
import { formatBytes } from "@/lib/format";
import { toast } from "sonner";

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
  };
  roles: {
    id: string;
    name: string;
    is_default: number;
    permissions: Record<string, boolean>;
  }[];
}

type Tab = "general" | "limits" | "security" | "roles" | "danger";

const TABS: { id: Tab; label: string; icon: React.ReactNode }[] = [
  { id: "general", label: "General", icon: <Settings size={16} /> },
  { id: "limits", label: "Hard limits", icon: <HardDrive size={16} /> },
  { id: "security", label: "Security", icon: <Shield size={16} /> },
  { id: "roles", label: "Roles", icon: <Users size={16} /> },
  { id: "danger", label: "Danger zone", icon: <AlertTriangle size={16} /> },
];

const ICON_COLORS = [
  "#22c55e", "#3b82f6", "#8b5cf6", "#ec4899", "#f59e0b",
  "#ef4444", "#14b8a6", "#6366f1", "#f97316", "#06b6d4",
];

export function SettingsPage() {
  const { active } = useWorkspace();
  const queryClient = useQueryClient();
  const [tab, setTab] = useState<Tab>("general");

  const { data, isLoading } = useQuery({
    queryKey: ["settings", active?.id],
    queryFn: () =>
      api.get<SettingsResponse>(
        `/api/workspaces/${active?.id}/settings`,
      ),
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
  const roles = data?.roles ?? [];

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
      toast.success("Workspace updated");
    },
    onError: (err) => {
      toast.error(err instanceof ApiError ? err.message : "Failed to save");
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
      toast.success("Limits updated");
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
      toast.success("Security settings updated");
    },
  });

  if (isLoading) {
    return (
      <div className="space-y-4">
        <h1 className="text-2xl font-semibold">Settings</h1>
        <div className="h-64 animate-pulse rounded-xl bg-[var(--color-bg-tertiary)]" />
      </div>
    );
  }

  const PERMISSIONS = [
    "upload_files", "download_files", "create_share_links",
    "delete_any_file", "invite_members", "manage_roles", "manage_settings",
  ];

  return (
    <div className="flex h-full gap-6">
      {/* Sidebar Tabs */}
      <div className="w-48 space-y-1">
        {TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-sm transition-colors ${
              tab === t.id
                ? "bg-[var(--color-primary)]/10 font-medium text-[var(--color-primary)]"
                : "text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-secondary)]"
            }`}
          >
            {t.icon}
            {t.label}
          </button>
        ))}
      </div>

      {/* Content */}
      <div className="flex-1">
        {tab === "general" && (
          <Section title="Workspace info">
            <div className="space-y-5">
              {/* Workspace icon/photo */}
              <WorkspaceIconUpload
                workspaceId={active?.id ?? ""}
                currentColor={wsColor}
                currentInitials={workspace?.icon_initials ?? "?"}
                hasImage={!!workspace?.icon_image_url}
              />

              <div>
                <label className="mb-1 block text-sm font-medium">Name</label>
                <input
                  type="text"
                  value={wsName}
                  onChange={(e) => setWsName(e.target.value)}
                  className="w-full max-w-sm rounded-lg border px-3 py-2 text-sm outline-none focus:border-[var(--color-primary)]"
                  style={{ borderColor: "var(--color-border)" }}
                />
              </div>
              <div>
                <label className="mb-2 block text-sm font-medium">Icon color</label>
                <p className="mb-2 text-xs text-[var(--color-text-muted)]">Used when no custom photo is set</p>
                <div className="flex gap-2">
                  {ICON_COLORS.map((color) => (
                    <button
                      key={color}
                      onClick={() => setWsColor(color)}
                      className={`h-8 w-8 rounded-full transition-all ${
                        wsColor === color ? "ring-2 ring-offset-2" : ""
                      }`}
                      style={{ background: color, ringColor: color }}
                    />
                  ))}
                </div>
              </div>
              <button
                onClick={() => saveGeneralMut.mutate()}
                disabled={saveGeneralMut.isPending}
                className="flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-medium text-white"
                style={{ background: "var(--color-primary)" }}
              >
                <Save size={14} />
                Save changes
              </button>
            </div>
          </Section>
        )}

        {tab === "limits" && (
          <Section title="Hard limits">
            <div className="space-y-4 max-w-sm">
              <NumberInput
                label="Max upload file size (GB)"
                value={maxFileSize}
                onChange={setMaxFileSize}
              />
              <NumberInput
                label="Total workspace storage cap (GB)"
                value={maxStorage}
                onChange={setMaxStorage}
              />
              <NumberInput
                label="Storage per member (GB)"
                value={maxPerMember}
                onChange={setMaxPerMember}
              />
              <NumberInput
                label="Max simultaneous uploads per member"
                value={maxConcurrent}
                onChange={setMaxConcurrent}
              />
              <button
                onClick={() => saveLimitsMut.mutate()}
                disabled={saveLimitsMut.isPending}
                className="flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-medium text-white"
                style={{ background: "var(--color-primary)" }}
              >
                <Save size={14} />
                Save limits
              </button>
            </div>
          </Section>
        )}

        {tab === "security" && (
          <Section title="Security">
            <div className="space-y-4 max-w-sm">
              <Toggle
                label="Require 2FA for all members"
                description="Members must enable two-factor authentication"
                checked={require2fa}
                onChange={setRequire2fa}
              />
              <Toggle
                label="Disable share links"
                description="Prevent members from creating public share links"
                checked={disableShares}
                onChange={setDisableShares}
              />
              <Toggle
                label="Force password on share links"
                description="All share links must be password-protected"
                checked={forceSharePassword}
                onChange={setForceSharePassword}
              />
              <button
                onClick={() => saveSecurityMut.mutate()}
                disabled={saveSecurityMut.isPending}
                className="flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-medium text-white"
                style={{ background: "var(--color-primary)" }}
              >
                <Save size={14} />
                Save security
              </button>
            </div>
          </Section>
        )}

        {tab === "roles" && (
          <Section title="Roles & permissions">
            <div className="rounded-xl border p-6 text-center" style={{ borderColor: "var(--color-border)" }}>
              <Users size={32} className="mx-auto mb-3 text-[var(--color-text-muted)]" />
              <h3 className="text-sm font-semibold">Manage roles & permissions</h3>
              <p className="mt-1 text-sm text-[var(--color-text-secondary)]">
                Create custom roles, edit permissions, and manage access controls on the web app.
              </p>
              <button
                onClick={() => window.open("https://dosya.dev/settings", "_blank")}
                className="mt-4 inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-medium text-white"
                style={{ background: "var(--color-primary)" }}
              >
                Open on web
              </button>
            </div>
          </Section>
        )}

        {tab === "danger" && (
          <Section title="Danger zone">
            <div
              className="rounded-xl border-2 border-dashed p-6"
              style={{ borderColor: "var(--color-danger)" }}
            >
              <h3 className="mb-2 font-semibold text-[var(--color-danger)]">
                Delete workspace
              </h3>
              <p className="mb-4 text-sm text-[var(--color-text-secondary)]">
                Permanently delete this workspace and all its files. This action
                cannot be undone.
              </p>
              <button className="rounded-lg bg-[var(--color-danger)] px-4 py-2 text-sm font-medium text-white">
                Delete workspace
              </button>
            </div>
          </Section>
        )}
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
            checked ? "translate-x-5" : "translate-x-0.5"
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
  const queryClient = useQueryClient();
  const fileRef = useRef<HTMLInputElement>(null);
  const [apiBase, setApiBase] = useState("");
  const [imgKey, setImgKey] = useState(0); // force re-render after upload

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
      setImgKey((k) => k + 1);
      toast.success("Workspace icon updated");
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : "Failed to upload"),
  });

  const deleteMut = useMutation({
    mutationFn: () => api.delete(`/api/workspaces/${workspaceId}/icon`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["settings"] });
      queryClient.invalidateQueries({ queryKey: ["workspaces"] });
      setImgKey((k) => k + 1);
      toast.success("Icon removed");
    },
  });

  return (
    <div>
      <label className="mb-2 block text-sm font-medium">Workspace icon</label>
      <div className="flex items-center gap-4">
        <div className="group relative">
          {hasImage && apiBase ? (
            <img
              key={imgKey}
              src={`${apiBase}/api/workspaces/${workspaceId}/icon?t=${imgKey}`}
              alt="Workspace icon"
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
            {hasImage ? "Change photo" : "Upload photo"}
          </button>
          {hasImage && (
            <button
              onClick={() => deleteMut.mutate()}
              className="mt-1 flex items-center gap-1.5 text-xs text-[var(--color-danger)] hover:underline"
            >
              <Trash2 size={12} />
              Remove photo
            </button>
          )}
          <p className="mt-1 text-xs text-[var(--color-text-muted)]">
            PNG, JPEG, WebP or GIF — max 2 MB
          </p>
        </div>
      </div>
    </div>
  );
}
