import { SWATCHES, resolveSwatch } from "../lib/palette";
import { useT } from "@/lib/i18n";
import type { MessageKey } from "../../i18n/keys";

/** Swatch names (lib/palette.ts) to their catalog labels. */
const SWATCH_LABELS: Record<string, MessageKey> = {
  green: "common.label.green",
  teal: "common.label.teal",
  blue: "common.label.blue",
  violet: "common.label.violet",
  pink: "common.label.pink",
  orange: "common.label.orange",
  graphite: "common.label.graphite",
};

/**
 * The colour picker for anything that carries an identity colour: a workspace, a folder
 * group. The desktop app alone shipped three different sets of hexes for this, and the
 * web app two more, all writing to the same free-form database column.
 *
 * Selection is resolved by swatch, not by string equality. `workspaces.icon_color` has
 * never been validated server-side, so a workspace created by an older client holds a
 * hex that is not in this list; comparing against the list directly would show nothing
 * as selected. `resolveSwatch` maps every colour any picker ever offered to its swatch.
 *
 * The value written is the light-theme fill, because the stored hex is also rendered by
 * surfaces with no theme at all, notification e-mails in particular.
 */
export function SwatchPicker({
  value,
  onChange,
  disabled,
  label,
}: {
  value: string;
  onChange: (hex: string) => void;
  disabled?: boolean;
  label?: string;
}) {
  const t = useT();
  const selected = resolveSwatch(value);

  return (
    <div className="flex flex-wrap gap-2.5" role="radiogroup" aria-label={label ?? t("appearance.label.colour")}>
      {SWATCHES.map((s) => {
        const isOn = selected ? selected === s.name : value === s.light;
        return (
          <button
            key={s.name}
            type="button"
            role="radio"
            aria-checked={isOn}
            aria-label={SWATCH_LABELS[s.name] ? t(SWATCH_LABELS[s.name]) : s.label}
            title={SWATCH_LABELS[s.name] ? t(SWATCH_LABELS[s.name]) : s.label}
            disabled={disabled}
            onClick={() => onChange(s.light)}
            className={`h-8 w-8 rounded-full transition-transform ${
              isOn ? "scale-110 ring-2 ring-offset-2" : "hover:scale-110"
            } disabled:opacity-50 disabled:hover:scale-100`}
            style={
              {
                background: s.light,
                "--tw-ring-color": s.light,
                "--tw-ring-offset-color": "var(--color-bg)",
              } as React.CSSProperties
            }
          />
        );
      })}
    </div>
  );
}
