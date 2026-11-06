import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { AlertTriangle } from "lucide-react";
import { deletionDaysRemaining } from "@dosya-dev/shared";
import { api } from "@/lib/api-client";
import { formatters, useT } from "@/lib/i18n";
import { richText } from "@/lib/rich-text";

/**
 * Persistent notice while an account deletion is pending.
 *
 * Sits in the shell rather than on the Profile page: someone who scheduled a
 * deletion and then forgot should be reminded wherever they are. Two weeks of
 * silence followed by an empty account is the outcome this prevents.
 *
 * Reads the flag off GET /api/me, which the app already calls, so it adds no
 * polling of its own.
 */
export function DeletionBanner() {
  const t = useT();
  const navigate = useNavigate();
  const { data } = useQuery({
    queryKey: ["me", "deletion"],
    queryFn: () => api.get<{ ok: boolean; user?: { deletion_scheduled_for: number | null } }>("/api/me"),
    staleTime: 60_000,
  });

  const scheduledFor = data?.user?.deletion_scheduled_for ?? null;
  if (scheduledFor == null) return null;

  const days = deletionDaysRemaining(scheduledFor, Math.floor(Date.now() / 1000));
  // packages/shared formatDeletionDate's long date, in the chosen language.
  const date = <span className="font-semibold">{formatters().formatDate(scheduledFor, "long")}</span>;

  return (
    <div
      data-testid="deletion-banner"
      className="flex items-center gap-2 border-b px-4 py-2"
      style={{ background: "rgb(254 242 242)", borderColor: "var(--color-danger)" }}
    >
      <AlertTriangle size={14} className="shrink-0 text-[var(--color-danger)]" />
      <p className="flex-1 text-xs text-[var(--color-danger)]">
        {days > 0
          ? richText(t, "profile.description.yourAccountIsScheduledForDeletionOnScheduledForDay", { days }, { scheduledFor: date })
          : richText(t, "profile.description.yourAccountIsScheduledForDeletionOnScheduledForToday", {}, { scheduledFor: date })}
      </p>
      <button
        onClick={() => navigate("/profile")}
        className="shrink-0 text-xs font-medium underline text-[var(--color-danger)] hover:no-underline"
      >
        {t("profile.action.cancelDeletion")}
      </button>
    </div>
  );
}
