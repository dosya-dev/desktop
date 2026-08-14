import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api-client";
import type { MapFilters } from "@/lib/map/map-pins";

interface TreeFolder {
  id: string;
  name: string;
  parent_id: string | null;
  file_count: number;
}

/** Unix seconds for the start (or end) of the day a date input names. */
function fromDateInput(value: string, endOfDay: boolean): number | null {
  if (!value) return null;
  const ms = new Date(`${value}T${endOfDay ? "23:59:59" : "00:00:00"}`).getTime();
  return Number.isNaN(ms) ? null : Math.floor(ms / 1000);
}

function toDateInput(unix: number | null | undefined): string {
  if (unix == null) return "";
  const d = new Date(unix * 1000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/**
 * Folder and date-range filters for the map.
 *
 * Web opens its FolderPickerDialog here. Desktop has no reusable picker - the
 * only one lives inline inside UploadPage - so this uses a flat select over
 * /api/folders/tree instead of extracting that dialog and risking the upload
 * flow for a filter. The endpoint already returns every folder with its
 * parent_id, which is all a select needs.
 */
export function MapFilterPanel({ value, onChange, workspaceId }: {
  value: MapFilters;
  onChange: (next: MapFilters) => void;
  workspaceId: string;
}) {
  const { data } = useQuery({
    queryKey: ["folders-tree", workspaceId],
    queryFn: () => api.get<{ ok: boolean; folders: TreeFolder[] }>(`/api/folders/tree?workspace_id=${workspaceId}`),
    enabled: !!workspaceId,
  });

  const folders = data?.folders ?? [];
  const active = Boolean(value.folderId) || value.from != null || value.to != null;
  const field = "rounded-lg border px-2 py-1 text-xs outline-none focus:border-[var(--color-primary)]";

  return (
    <div
      data-testid="map-filters"
      className="flex flex-wrap items-center gap-2 rounded-xl border p-2"
      style={{ borderColor: "var(--color-border)" }}
    >
      <select
        data-testid="map-filter-folder"
        value={value.folderId ?? ""}
        onChange={(e) => {
          const id = e.target.value || null;
          onChange({
            ...value,
            folderId: id,
            folderName: id ? (folders.find((f) => f.id === id)?.name ?? null) : null,
          });
        }}
        className={field}
        style={{ borderColor: "var(--color-border)" }}
      >
        <option value="">Everywhere</option>
        {folders.map((f) => (
          <option key={f.id} value={f.id}>{f.name}</option>
        ))}
      </select>

      <label className="flex items-center gap-1 text-xs text-[var(--color-text-muted)]">
        From
        <input
          data-testid="map-filter-from"
          type="date"
          value={toDateInput(value.from)}
          onChange={(e) => onChange({ ...value, from: fromDateInput(e.target.value, false) })}
          className={field}
          style={{ borderColor: "var(--color-border)" }}
        />
      </label>

      <label className="flex items-center gap-1 text-xs text-[var(--color-text-muted)]">
        To
        <input
          data-testid="map-filter-to"
          type="date"
          value={toDateInput(value.to)}
          // Inclusive: a "to" date means the end of that day, not its midnight,
          // or a photo taken in the afternoon falls outside its own date.
          onChange={(e) => onChange({ ...value, to: fromDateInput(e.target.value, true) })}
          className={field}
          style={{ borderColor: "var(--color-border)" }}
        />
      </label>

      {active && (
        <button
          type="button"
          data-testid="map-filter-clear"
          onClick={() => onChange({})}
          className="rounded-lg border px-2 py-1 text-xs"
          style={{ borderColor: "var(--color-border)" }}
        >
          Clear
        </button>
      )}
    </div>
  );
}
