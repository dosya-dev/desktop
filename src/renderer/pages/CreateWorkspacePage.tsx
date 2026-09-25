import { useEffect, useMemo, useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { api, ApiError } from "@/lib/api-client";
import { groupLocations, pickPreselected, type RegionInfo } from "@/lib/location-groups";
import { useWorkspace } from "@/lib/workspace-context";
import { useAuth } from "@/lib/auth-context";
import { FolderOpen, Upload, RefreshCw, Shield, Users, Zap, LogOut, ArrowRight } from "lucide-react";
import { Logo } from "@/components/Logo";
import { toast } from "sonner";
import { SwatchPicker } from "../components/SwatchPicker";

export function CreateWorkspacePage() {
  const { workspaces, setActive } = useWorkspace();
  const { logout } = useAuth();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [color, setColor] = useState("#22c55e");
  // Where this workspace's files will live. Chosen here and only here - the
  // server refuses to move a workspace afterwards, so there is no second chance
  // and no per-upload override anywhere in the app.
  const [region, setRegion] = useState("");
  const [locationQuery, setLocationQuery] = useState("");

  const {
    data: regionsData,
    isError: regionsError,
  } = useQuery({
    queryKey: ["regions"],
    queryFn: () =>
      api.get<{ ok: boolean; regions: RegionInfo[]; suggested: string }>(
        "/api/regions",
      ),
  });

  const regions = useMemo(() => regionsData?.regions ?? [], [regionsData]);
  // The list never arrived (offline, or an old API). Creating a workspace must
  // still work: the server picks the nearest location when the request carries
  // none, so the form submits without one rather than dead-ending on a button
  // that can never enable.
  const locationsUnavailable =
    regionsError || (!!regionsData && regions.length === 0);

  // The server's nearest-location guess, so the common case is one click fewer
  // rather than an empty required field. Only a suggestion the picker can
  // actually show is accepted - see pickPreselected.
  useEffect(() => {
    if (region) return;
    const preselected = pickPreselected(regions, regionsData?.suggested);
    if (preselected) setRegion(preselected);
  }, [regions, regionsData, region]);

  const locationGroups = useMemo(
    () => groupLocations(regions, locationQuery),
    [regions, locationQuery],
  );

  const initials = name.trim()
    ? name
        .trim()
        .split(/\s+/)
        .map((w) => w[0])
        .join("")
        .slice(0, 2)
        .toUpperCase()
    : "?";

  const createMut = useMutation({
    mutationFn: (wsName: string) =>
      api.post<{
        ok: boolean;
        workspace: {
          id: string;
          name: string;
          slug: string;
          icon_initials: string;
          icon_color: string;
          owner_id: string;
        };
      }>("/api/workspaces", {
        name: wsName,
        icon_color: color,
        // Empty only when the location list could not be loaded; the server
        // then suggests one from the request's geography.
        default_region: region,
      }),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["workspaces"] });
      setActive(data.workspace as any);
      toast.success("Workspace created!");
    },
    onError: (err) => {
      toast.error(
        err instanceof ApiError ? err.message : "Failed to create workspace",
      );
    },
  });

  // Mirrors the button's own gate so a return key in the name field cannot
  // create the workspace before its permanent location has been chosen.
  const canCreate =
    !!name.trim() && !createMut.isPending && (!!region || locationsUnavailable);

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (canCreate) createMut.mutate(name.trim());
  }

  return (
    <div className="flex h-screen">
      {/* Left - form */}
      <div className="flex w-[40%] flex-col justify-center bg-[var(--color-bg)] px-12">
        <div className="max-w-sm">
          <div className="mb-8 flex items-center gap-2.5">
            <Logo className="h-7 w-7" />
            <span className="text-base font-semibold text-[var(--color-text)]">
              dosya.dev
            </span>
          </div>

          <h1 className="mb-2 text-2xl font-bold tracking-tight text-[var(--color-text)]">
            Create your workspace
          </h1>
          <p className="mb-8 text-sm leading-relaxed text-[var(--color-text-secondary)]">
            A workspace is where your files, folders, and team live. You need at
            least one to get started.
          </p>

          <form onSubmit={handleSubmit} className="space-y-5">
            {/* Preview + Name */}
            <div>
              <label className="mb-1.5 block text-sm font-medium">
                Workspace name
              </label>
              <div className="flex items-center gap-3">
                <div
                  className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-sm font-bold text-white"
                  style={{ background: color }}
                >
                  {initials}
                </div>
                <input
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="e.g. My Files, Work, School..."
                  autoFocus
                  className="flex-1 rounded-lg border px-3 py-2.5 text-sm outline-none focus:border-[var(--color-primary)] focus:ring-1 focus:ring-[var(--color-primary)]"
                  style={{ borderColor: "var(--color-border)" }}
                />
              </div>
            </div>

            {/* Color picker */}
            <div>
              <label className="mb-1.5 block text-sm font-medium">Color</label>
              <SwatchPicker value={color} onChange={setColor} label="Workspace colour" />
            </div>

            {/* Location */}
            <div>
              <label className="mb-1.5 block text-sm font-medium">
                Location
              </label>
              <p className="mb-2 text-xs text-[var(--color-text-secondary)]">
                Where this workspace's files are stored. Chosen once - every
                file in the workspace lives here.
              </p>
              {locationsUnavailable ? (
                <p className="text-xs text-[var(--color-text-muted)]">
                  Locations could not be loaded. Your workspace will be created
                  in the one closest to you.
                </p>
              ) : (
                <>
                  <input
                    type="text"
                    value={locationQuery}
                    onChange={(e) => setLocationQuery(e.target.value)}
                    placeholder="Search a city or country"
                    aria-label="Search locations"
                    className="mb-2 w-full rounded-lg border px-3 py-2 text-sm outline-none focus:border-[var(--color-primary)] focus:ring-1 focus:ring-[var(--color-primary)]"
                    style={{ borderColor: "var(--color-border)" }}
                  />
                  <div
                    role="listbox"
                    aria-label="Location"
                    className="max-h-48 overflow-y-auto rounded-lg border"
                    style={{ borderColor: "var(--color-border)" }}
                  >
                    {locationGroups.map(([continent, rows]) => (
                      <div key={continent} role="group" aria-label={continent}>
                        <div
                          aria-hidden="true"
                          className="bg-[var(--color-bg-secondary)] px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wide text-[var(--color-text-muted)]"
                        >
                          {continent}
                        </div>
                        {rows.map((r) => (
                          <button
                            key={r.code}
                            type="button"
                            role="option"
                            aria-selected={r.code === region}
                            onClick={() => setRegion(r.code)}
                            className={`flex w-full items-center justify-between px-3 py-2 text-left text-xs transition-colors hover:bg-[var(--color-bg-secondary)] ${
                              r.code === region
                                ? "bg-[var(--color-primary)]/10 font-medium text-[var(--color-primary)]"
                                : ""
                            }`}
                          >
                            <span>
                              {r.flag ? `${r.flag} ` : ""}
                              {r.city}, {r.country}
                            </span>
                            <span className="text-[var(--color-text-muted)]">
                              {r.code}
                            </span>
                          </button>
                        ))}
                      </div>
                    ))}
                    {regions.length === 0 && (
                      <div className="px-3 py-5 text-center text-xs text-[var(--color-text-muted)]">
                        Loading locations...
                      </div>
                    )}
                    {regions.length > 0 && locationGroups.length === 0 && (
                      <div className="px-3 py-5 text-center text-xs text-[var(--color-text-muted)]">
                        No location matches.
                      </div>
                    )}
                  </div>
                </>
              )}
            </div>

            {/* The location is permanent, so the form waits until the server
                has said what the options are and one of them is selected - but
                never past the point where the list is known to be unavailable,
                which would leave this button disabled forever. */}
            <button
              type="submit"
              disabled={!canCreate}
              className="w-full rounded-lg px-4 py-2.5 text-sm font-semibold text-[var(--color-primary-fg)] transition-colors disabled:opacity-50"
              style={{ background: "var(--color-primary)" }}
            >
              {createMut.isPending ? "Creating..." : "Create workspace"}
            </button>
          </form>

          {workspaces.length > 0 && (
            <button
              onClick={() => navigate("/dashboard")}
              className="mt-4 flex w-full items-center justify-center gap-2 rounded-lg border px-4 py-2.5 text-sm font-medium transition-colors hover:bg-[var(--color-bg-secondary)]"
              style={{ borderColor: "var(--color-border)" }}
            >
              <ArrowRight size={14} />
              Go to dashboard
            </button>
          )}

          <button
            onClick={logout}
            className="mt-4 flex w-full items-center justify-center gap-2 rounded-lg border px-4 py-2.5 text-sm font-medium text-[var(--color-text-secondary)] transition-colors hover:bg-[var(--color-bg-secondary)]"
            style={{ borderColor: "var(--color-border)" }}
          >
            <LogOut size={14} />
            Log out
          </button>
        </div>
      </div>

      {/* Right - features grid */}
      <div className="bg-grid flex w-[60%] flex-col items-center justify-center bg-[var(--color-bg-secondary)] p-12">
        <div className="max-w-md">
          <h2 className="mb-2 text-center text-xl font-bold text-[var(--color-text)]">
            What you can do with a workspace
          </h2>
          <p className="mb-8 text-center text-sm text-[var(--color-text-secondary)]">
            Everything starts with a workspace. Here's what's included.
          </p>

          <div className="grid grid-cols-2 gap-4">
            {[
              {
                icon: FolderOpen,
                title: "Organize files",
                desc: "Create folders, move files, and keep everything structured.",
              },
              {
                icon: Upload,
                title: "Upload anything",
                desc: "Drag and drop any file. No size limits, no restrictions.",
              },
              {
                icon: RefreshCw,
                title: "Sync folders",
                desc: "Keep local folders in sync with the cloud automatically.",
              },
              {
                icon: Shield,
                title: "Encrypted storage",
                desc: "AES-256 encryption at rest. Your files are always protected.",
              },
              {
                icon: Users,
                title: "Invite your team",
                desc: "Share your workspace with others and collaborate on files.",
              },
              {
                icon: Zap,
                title: "Instant sharing",
                desc: "Create share links with passwords, expiry, and download limits.",
              },
            ].map(({ icon: Icon, title, desc }) => (
              <div
                key={title}
                className="rounded-xl bg-[var(--color-bg)] p-4 shadow-sm"
              >
                <div className="mb-2 flex h-8 w-8 items-center justify-center rounded-lg bg-[var(--color-primary)]/10">
                  <Icon
                    size={16}
                    className="text-[var(--color-primary)]"
                    strokeWidth={2}
                  />
                </div>
                <h3 className="mb-0.5 text-sm font-semibold text-[var(--color-text)]">
                  {title}
                </h3>
                <p className="text-xs leading-relaxed text-[var(--color-text-muted)]">
                  {desc}
                </p>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
