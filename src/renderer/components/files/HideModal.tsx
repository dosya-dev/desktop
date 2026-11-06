// Ported from apps/web/src/components/hide-modal.tsx - keep in sync with the web copy.
import { useState, useEffect } from "react";
import { Eye, EyeOff, UserMinus, Shield, Loader2, Check } from "lucide-react";
import { toast } from "sonner";
import { api, ApiError } from "@/lib/api-client";
import { Modal } from "@/components/files/Modal";
import { useT } from "@/lib/i18n";
import type { MessageKey } from "../../../i18n/keys";
import { useAutoDir } from "@/lib/bidi-ui";

interface HideModalProps {
  open: boolean;
  target: { id: string; name: string; type: "file" | "folder" } | null;
  workspaceId: string;
  onClose: () => void;
  onDone: () => void;
}

type HiddenMode = "none" | "everyone" | "users" | "roles";

/** Long enough for a slow link, short enough that nobody waits on a dead one. */
export const HIDE_LOAD_TIMEOUT_MS = 15_000;

interface Member { user_id: string; name: string; email: string; role_id: string; is_you: boolean }
interface Role { id: string; name: string }

export function HideModal({ open, target, workspaceId, onClose, onDone }: HideModalProps) {
  const ownDir = useAutoDir();
  const t = useT();
  const [mode, setMode] = useState<HiddenMode>("none");
  const [selectedTargets, setSelectedTargets] = useState<Set<string>>(new Set());
  const [members, setMembers] = useState<Member[]>([]);
  const [roles, setRoles] = useState<Role[]>([]);
  const [loading, setLoading] = useState(false);
  const [fetching, setFetching] = useState(false);
  const [error, setError] = useState("");
  // The server's own sentence takes its own direction; a translation follows the page.
  const [errorRaw, setErrorRaw] = useState(false);
  // Why the pickers are empty, when they are. /api/team and /api/roles answer
  // 403 to a role that may not see the roster; swallowing that showed "No
  // members found" as if the workspace were empty.
  const [loadError, setLoadError] = useState("");
  const [rosterLoading, setRosterLoading] = useState(false);
  // The current visibility could not be read: the dialog says so and offers a
  // retry instead of guessing (Apply would overwrite a state it never saw).
  const [stateError, setStateError] = useState("");
  const [attempt, setAttempt] = useState(0);

  // Keyed on the target's identity, not the object: a parent re-render that
  // builds a fresh { id, name, type } must not restart the load.
  const targetId = target?.id;
  const targetType = target?.type;

  useEffect(() => {
    if (!open || !targetId) return;
    setError("");
    setLoadError("");
    setStateError("");
    setFetching(true);
    setRosterLoading(true);

    // The spinner used to wait on all three requests with no deadline, so one
    // request that never answered (a stalled connection after the machine
    // slept, say) left the dialog spinning forever with Apply greyed out
    // (QA TC-039). Every request now has a deadline, an earlier load that
    // finishes late cannot overwrite a newer one, and only the visibility
    // read gates the spinner: the member and role lists only fill the pickers.
    let live = true;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), HIDE_LOAD_TIMEOUT_MS);
    const failure = (err: unknown) =>
      err instanceof ApiError ? err.message : t("common.error.canTReachTheServerCheckYourConnectionAnd");

    const ep = targetType === "file" ? `/api/files/${targetId}/hide` : `/api/folders/${targetId}/hide`;

    api.get<{ ok: boolean; hidden_mode?: string; rules?: { target_id: string }[] }>(ep, ctrl.signal)
      .then((hideData) => {
        if (!live) return;
        if (hideData?.ok) {
          setMode((hideData.hidden_mode ?? "none") as HiddenMode);
          setSelectedTargets(new Set((hideData.rules ?? []).map((r) => r.target_id)));
        } else {
          setStateError(t("common.error.canTReachTheServerCheckYourConnectionAnd"));
        }
      })
      .catch((err: unknown) => { if (live) setStateError(failure(err)); })
      .finally(() => { if (live) setFetching(false); });

    Promise.all([
      api.get<{ ok: boolean; members?: Member[] }>(`/api/team?workspace_id=${workspaceId}`, ctrl.signal),
      api.get<{ ok: boolean; roles?: Role[] }>(`/api/roles?workspace_id=${workspaceId}`, ctrl.signal),
    ]).then(([teamData, rolesData]) => {
      if (!live) return;
      if (teamData?.ok && teamData.members) setMembers(teamData.members);
      if (rolesData?.ok && rolesData.roles) setRoles(rolesData.roles);
    }).catch((err: unknown) => {
      if (live) setLoadError(err instanceof ApiError ? err.message : t("file-security.error.membersAndRolesCouldNotBeLoaded"));
    }).finally(() => { if (live) setRosterLoading(false); });

    return () => {
      live = false;
      clearTimeout(timer);
      ctrl.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, targetId, targetType, workspaceId, attempt]);

  const toggleTarget = (id: string) => {
    setSelectedTargets((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const handleSubmit = async () => {
    if (!target) return;
    setError("");
    setLoading(true);
    const ep = target.type === "file" ? `/api/files/${target.id}/hide` : `/api/folders/${target.id}/hide`;
    try {
      const body: Record<string, unknown> = { hidden_mode: mode };
      if (mode === "users" || mode === "roles") {
        if (selectedTargets.size === 0) {
          setError(mode === "users" ? t("file-security.error.selectAtLeastOneUser") : t("file-security.error.selectAtLeastOneRole")); setErrorRaw(false);
          setLoading(false);
          return;
        }
        body.targets = Array.from(selectedTargets);
      }
      const res = await api.post<{ ok: boolean; error?: string }>(ep, body);
      if (res.ok) {
        toast.success(mode === "none" ? t("file-security.status.nowVisible") : t("common.status.hidden"), {
          description: mode === "none"
            ? t("file-security.description.targetnameIsNowVisibleToEveryone", { targetName: target.name })
            : t("file-security.description.targetnameIsNowHidden", { targetName: target.name }),
        });
        onDone();
        onClose();
      } else {
        setError(res.error ?? t("common.error.failed")); setErrorRaw(res.error != null);
      }
    } catch {
      setError(t("file-security.error.failedToUpdateVisibility")); setErrorRaw(false);
    }
    setLoading(false);
  };

  // You can't hide your own files from yourself or your own role - still shown, but disabled.
  const myRoleId = members.find((m) => m.is_you)?.role_id;

  const MODES: { value: HiddenMode; label: MessageKey; desc: MessageKey; icon: React.ReactNode }[] = [
    { value: "none", label: "file-security.status.visible", desc: "file-security.label.everyoneCanSeeThis", icon: <Eye size={16} className="text-[var(--color-text-muted)]" /> },
    { value: "everyone", label: "file-security.label.hiddenFromEverybody", desc: "file-security.label.onlyYouCanSeeThis", icon: <EyeOff size={16} className="text-red-500" /> },
    { value: "users", label: "file-security.label.hiddenFromSpecificUsers", desc: "file-security.description.selectWhichUsersCanTSeeThis", icon: <UserMinus size={16} className="text-blue-500" /> },
    { value: "roles", label: "file-security.label.hiddenFromSpecificRoles", desc: "file-security.description.selectWhichRolesCanTSeeThis", icon: <Shield size={16} className="text-violet-500" /> },
  ];

  if (!open || !target) return null;

  return (
    <Modal onClose={onClose} maxWidth={384}>
      <h3 className="mb-4 text-lg font-semibold">{t("file-security.heading.hideFile", { kind: target.type })}</h3>

      {fetching ? (
        <div className="flex justify-center py-6" role="status" aria-label={t("common.status.loading")}><Loader2 size={20} className="animate-spin text-[var(--color-text-muted)]" /></div>
      ) : stateError ? (
        <div className="flex flex-col items-center gap-3 py-4 text-center" role="alert">
          <p className="text-sm text-[var(--color-danger)]">{stateError}</p>
          <button
            type="button"
            onClick={() => setAttempt((n) => n + 1)}
            className="rounded-lg border px-3 py-1.5 text-sm hover:bg-[var(--color-bg-secondary)]"
            style={{ borderColor: "var(--color-border)" }}
          >
            {t("common.retry")}
          </button>
        </div>
      ) : (
        <div className="space-y-2">
          {MODES.map((m) => (
            <label
              key={m.value}
              className={`flex cursor-pointer items-start gap-3 rounded-lg border px-3 py-2.5 transition-colors ${mode === m.value ? "border-[var(--color-primary)] bg-[var(--color-bg-secondary)]" : "hover:bg-[var(--color-bg-secondary)]"}`}
              style={mode === m.value ? undefined : { borderColor: "var(--color-border)" }}
            >
              <input
                type="radio"
                name="hide-mode"
                checked={mode === m.value}
                onChange={() => { setMode(m.value); setSelectedTargets(new Set()); }}
                className="mt-0.5 accent-[var(--color-primary)]"
              />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 text-sm font-medium">{m.icon} {t(m.label)}</div>
                <p className="mt-0.5 text-xs text-[var(--color-text-muted)]">{t(m.desc)}</p>
              </div>
            </label>
          ))}

          {/* User picker */}
          {mode === "users" && (
            <div className="max-h-40 overflow-y-auto rounded-lg border" style={{ borderColor: "var(--color-border)" }}>
              {rosterLoading && members.length === 0 ? (
                <div className="flex justify-center py-3"><Loader2 size={14} className="animate-spin text-[var(--color-text-muted)]" /></div>
              ) : members.length === 0 ? (
                <p className="py-3 text-center text-xs text-[var(--color-text-muted)]">{t("file-security.empty.noMembersFound")}</p>
              ) : members.map((m) => (
                <button
                  key={m.user_id}
                  disabled={m.is_you}
                  className={`flex w-full items-center gap-2 border-b px-3 py-2 text-start text-xs last:border-b-0 ${m.is_you ? "cursor-not-allowed opacity-50" : "hover:bg-[var(--color-bg-secondary)]"} ${selectedTargets.has(m.user_id) ? "bg-blue-50" : ""}`}
                  style={{ borderColor: "var(--color-border)" }}
                  onClick={() => { if (!m.is_you) toggleTarget(m.user_id); }}
                >
                  {selectedTargets.has(m.user_id) && <Check size={12} className="shrink-0 text-blue-600" />}
                  <span className="flex-1 truncate">{m.name}{m.is_you && ` ${t("common.label.you")}`}</span>
                  <span className="truncate text-[var(--color-text-muted)]">{m.email}</span>
                </button>
              ))}
            </div>
          )}

          {/* Role picker */}
          {mode === "roles" && (
            <div className="max-h-40 overflow-y-auto rounded-lg border" style={{ borderColor: "var(--color-border)" }}>
              {rosterLoading && roles.length === 0 ? (
                <div className="flex justify-center py-3"><Loader2 size={14} className="animate-spin text-[var(--color-text-muted)]" /></div>
              ) : roles.length === 0 ? (
                <p className="py-3 text-center text-xs text-[var(--color-text-muted)]">{t("file-security.empty.noRolesFound")}</p>
              ) : roles.map((r) => {
                const isMine = r.id === myRoleId;
                return (
                  <button
                    key={r.id}
                    disabled={isMine}
                    className={`flex w-full items-center gap-2 border-b px-3 py-2 text-start text-xs last:border-b-0 ${isMine ? "cursor-not-allowed opacity-50" : "hover:bg-[var(--color-bg-secondary)]"} ${selectedTargets.has(r.id) ? "bg-violet-50" : ""}`}
                    style={{ borderColor: "var(--color-border)" }}
                    onClick={() => { if (!isMine) toggleTarget(r.id); }}
                  >
                    {selectedTargets.has(r.id) && <Check size={12} className="shrink-0 text-violet-600" />}
                    <span className="flex-1 truncate">{r.name}{isMine && ` ${t("file-security.label.yourRole")}`}</span>
                  </button>
                );
              })}
            </div>
          )}

          {loadError && (
            <p className="text-xs text-[var(--color-danger)]">
              {t("file-security.error.membersAndRolesCouldNotBeLoadedLoadError", { loadError })}
            </p>
          )}

          {(mode === "users" || mode === "roles") && selectedTargets.size > 0 && (
            <p className="text-xs text-[var(--color-text-muted)]">{t("file-security.description.countSelected", { count: String(selectedTargets.size) })}</p>
          )}

          {error && (
            <p dir={errorRaw ? ownDir : undefined} className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-[var(--color-danger)]">{error}</p>
          )}
        </div>
      )}

      <div className="mt-5 flex justify-end gap-2">
        <button onClick={onClose} className="rounded-lg border px-4 py-2 text-sm" style={{ borderColor: "var(--color-border)" }}>
          {t("common.cancel")}
        </button>
        <button
          onClick={handleSubmit}
          disabled={loading || fetching || !!stateError}
          className="flex items-center gap-1.5 rounded-lg px-4 py-2 text-sm font-medium text-[var(--color-primary-fg)] disabled:opacity-50"
          style={{ background: "var(--color-primary)" }}
        >
          {loading && <Loader2 size={14} className="animate-spin" />}
          {t("file-security.apply")}
        </button>
      </div>
    </Modal>
  );
}
