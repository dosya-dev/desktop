import { SWATCHES, resolveSwatch } from "../lib/palette";

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
  label = "Colour",
}: {
  value: string;
  onChange: (hex: string) => void;
  disabled?: boolean;
  label?: string;
}) {
  const selected = resolveSwatch(value);

  return (
    <div className="flex flex-wrap gap-2.5" role="radiogroup" aria-label={label}>
      {SWATCHES.map((s) => {
        const isOn = selected ? selected === s.name : value === s.light;
        return (
          <button
            key={s.name}
            type="button"
            role="radio"
            aria-checked={isOn}
            aria-label={s.label}
            title={s.label}
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
