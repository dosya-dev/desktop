import { useState } from "react";
import { useT } from "@/lib/i18n";
import acknowledgements from "virtual:acknowledgements";

/**
 * The open-source packages dosya ships with, each expandable to its licence
 * text. Shown by the About window and by Profile > About.
 */
export function AcknowledgementsList() {
  const t = useT();
  const [open, setOpen] = useState<string | null>(null);
  return (
    <>
      <p className="mb-3 text-xs text-[var(--color-text-secondary)]">
        {t("about.description.dosyaIsBuiltWithTheseOpenSourcePackagesSelect")}
      </p>
      <ul className="divide-y divide-[var(--color-border)]">
        {acknowledgements.map((a: { name: string; version: string; license: string; text: string | null }) => (
          <li key={a.name} className="py-1.5">
            <button
              onClick={() => setOpen(open === a.name ? null : a.name)}
              className="flex w-full items-center justify-between gap-3 text-start text-sm"
            >
              <span>{a.name} <span className="font-mono text-xs text-[var(--color-text-muted)]">{a.version}</span></span>
              <span className="font-mono text-[11px] text-[var(--color-text-secondary)]">{a.license}</span>
            </button>
            {open === a.name && (
              <pre className="mt-2 max-h-48 overflow-y-auto whitespace-pre-wrap rounded-lg p-3 font-mono text-[11px] leading-relaxed text-[var(--color-text-secondary)]" style={{ background: "var(--color-bg-secondary)" }}>
                {a.text ?? t("about.label.licensedUnderLicenseNoLicenceFileShipsWithThe", { license: a.license })}
              </pre>
            )}
          </li>
        ))}
      </ul>
    </>
  );
}
