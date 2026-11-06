// apps/desktop/src/renderer/pages/PersonasSettingsPage.tsx
//
// Ported from apps/web/src/pages/personas/settings-page.tsx - keep in step.
//
// /personas/settings: this user's Personas settings for the active workspace
// (components/settings/PersonasSection). Personas is each member's own, so it
// lives beside People, reachable from the grid header and the persona page,
// not in workspace Settings. The Files sidebar is the shell's.
import { Link } from "react-router-dom";
import { ArrowLeft } from "lucide-react";
import { PersonasSection } from "@/components/settings/PersonasSection";
import { useT } from "@/lib/i18n";
import { useWorkspace } from "@/lib/workspace-context";

export function PersonasSettingsPage() {
  const t = useT();
  const { active } = useWorkspace();
  const wsId = active?.id ?? "";
  return (
    <div className="mx-auto max-w-3xl">
      <Link to="/personas" className="mb-4 inline-flex items-center gap-1.5 text-sm text-[var(--color-text-secondary)] hover:text-[var(--color-text)]">
        <ArrowLeft size={14} className="rtl:-scale-x-100" aria-hidden="true" />
        {t("common.label.personas")}
      </Link>
      {wsId && <PersonasSection key={wsId} wsId={wsId} />}
    </div>
  );
}
