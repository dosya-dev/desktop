import { useState, type FormEvent } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "@/lib/api-client";
import { useWorkspace } from "@/lib/workspace-context";
import { useAuth } from "@/lib/auth-context";
import { FolderOpen, Upload, RefreshCw, Shield, Users, Zap, LogOut } from "lucide-react";
import logoSvg from "@/assets/logo.svg";
import { toast } from "sonner";

const COLORS = [
  "#22c55e",
  "#7C3AED",
  "#2563EB",
  "#EA580C",
  "#059669",
  "#DB2777",
  "#1A1917",
];

export function CreateWorkspacePage() {
  const { setActive } = useWorkspace();
  const { logout } = useAuth();
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [color, setColor] = useState("#22c55e");

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
      }>("/api/workspaces", { name: wsName, icon_color: color }),
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

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (name.trim()) createMut.mutate(name.trim());
  }

  return (
    <div className="flex h-screen">
      {/* Left — form */}
      <div className="flex w-[40%] flex-col justify-center bg-[var(--color-bg)] px-12">
        <div className="max-w-sm">
          <div className="mb-8 flex items-center gap-2.5">
            <img src={logoSvg} alt="dosya.dev" className="h-7 w-7" />
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
              <div className="flex gap-2.5">
                {COLORS.map((c) => (
                  <button
                    key={c}
                    type="button"
                    onClick={() => setColor(c)}
                    className={`h-8 w-8 rounded-full transition-all ${
                      color === c
                        ? "ring-2 ring-offset-2 scale-110"
                        : "hover:scale-110"
                    }`}
                    style={{
                      background: c,
                      ringColor: c,
                    }}
                  />
                ))}
              </div>
            </div>

            <button
              type="submit"
              disabled={!name.trim() || createMut.isPending}
              className="w-full rounded-lg px-4 py-2.5 text-sm font-semibold text-white transition-colors disabled:opacity-50"
              style={{ background: "var(--color-primary)" }}
            >
              {createMut.isPending ? "Creating..." : "Create workspace"}
            </button>
          </form>

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

      {/* Right — features grid */}
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
