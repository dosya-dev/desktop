import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { AlertTriangle } from "lucide-react";
import { formatDeletionDate, deletionDaysRemaining } from "@dosya-dev/shared";
import { api } from "@/lib/api-client";

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
  const navigate = useNavigate();
  const { data } = useQuery({
    queryKey: ["me", "deletion"],
    queryFn: () => api.get<{ ok: boolean; user?: { deletion_scheduled_for: number | null } }>("/api/me"),
    staleTime: 60_000,
  });

  const scheduledFor = data?.user?.deletion_scheduled_for ?? null;
  if (scheduledFor == null) return null;

  const days = deletionDaysRemaining(scheduledFor, Math.floor(Date.now() / 1000));

  return (
    <div
      data-testid="deletion-banner"
      className="flex items-center gap-2 border-b px-4 py-2"
      style={{ background: "rgb(254 242 242)", borderColor: "var(--color-danger)" }}
    >
      <AlertTriangle size={14} className="shrink-0 text-[var(--color-danger)]" />
      <p className="flex-1 text-xs text-[var(--color-danger)]">
        Your account is scheduled for deletion on{" "}
        <span className="font-semibold">{formatDeletionDate(scheduledFor)}</span>
        {days > 0 ? ` - ${days} day${days === 1 ? "" : "s"} left.` : " - today."}
      </p>
      <button
        onClick={() => navigate("/profile")}
        className="shrink-0 text-xs font-medium underline text-[var(--color-danger)] hover:no-underline"
      >
        Cancel deletion
      </button>
    </div>
  );
}
