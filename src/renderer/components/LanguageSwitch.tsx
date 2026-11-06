import { useT } from "@/lib/i18n";
import { LanguageMenu } from "./LanguageMenu";

/** Profile → Appearance language picker: the titlebar menu's list behind a full-size button. */
export function LanguageSwitch() {
  const t = useT();
  return (
    <div>
      <p className="text-sm font-medium mb-3">{t("appearance.label.language")}</p>
      <LanguageMenu variant="field" align="start" />
    </div>
  );
}
