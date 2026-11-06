import { useEffect, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { useT } from "@/lib/i18n";
import { historyCan } from "@/lib/use-history-nav";

/**
 * Back / Forward in the titlebar, like Finder and Explorer. Opening a folder
 * pushes a history entry, but the only way back used to be the hidden
 * Go > Back menu item (Cmd+[) or clicking "Files" in the breadcrumb.
 */
export function NavButtons() {
  const t = useT();
  const navigate = useNavigate();
  const location = useLocation();
  const [can, setCan] = useState(historyCan);
  useEffect(() => setCan(historyCan()), [location]);

  const btn = "titlebar-no-drag flex h-7 w-7 items-center justify-center rounded-lg text-[var(--color-text-secondary)] transition-colors hover:bg-black/5 hover:text-[var(--color-text)] disabled:opacity-35 disabled:hover:bg-transparent";
  const mac = /Mac/i.test(navigator.platform);
  return (
    <div className="titlebar-no-drag flex items-center gap-0.5">
      <button type="button" className={btn} disabled={!can.back} onClick={() => navigate(-1)}
        title={`${t("common.back")} (${mac ? "⌘[" : "Ctrl+["})`} aria-label={t("common.back")}>
        <ChevronLeft size={16} className="rtl:-scale-x-100" />
      </button>
      <button type="button" className={btn} disabled={!can.forward} onClick={() => navigate(1)}
        title={`${t("menus.action.forward")} (${mac ? "⌘]" : "Ctrl+]"})`} aria-label={t("menus.action.forward")}>
        <ChevronRight size={16} className="rtl:-scale-x-100" />
      </button>
    </div>
  );
}
