import { api } from "@/lib/api-client";

// File pins are a superset of FileItem (see file-viewer.tsx) so one can be passed
// straight to <FileViewer>, plus the map-specific fields the API adds.
export interface FilePin {
  kind: 'file';
  id: string;
  name: string;
  size_bytes: number;
  mime_type: string;
  extension: string;
  region: string;
  created_at: number;
  updated_at: number;
  current_version: number;
  lock_mode: string;
  is_hidden: number;
  uploaded_by: string;
  uploader_name: string;
  share_count: number;
  comment_count: number;
  is_synced: number;
  latitude: number;
  longitude: number;
  captured_at: string | null;
  source: 'exif' | 'ip' | null;
}

// Folders have no EXIF, so their location (when present) is always IP-derived.
export interface FolderPin {
  kind: 'folder';
  id: string;
  name: string;
  latitude: number;
  longitude: number;
  source: 'exif' | 'ip' | null;
}

export type MapPin = FilePin | FolderPin;

export interface MapPinsResponse {
  ok: boolean;
  pins: MapPin[];
  counts: { gps: number; approximate: number; pending: number };
}

// Filters applied server-side. `folderId` scopes to that folder + its descendants
// (recursive); `from`/`to` are inclusive unix-epoch-second bounds on the pin's
// taken-date (falling back to upload date).
export interface MapFilters {
  folderId?: string | null;
  folderName?: string | null; // UI label only; not sent to the API
  from?: number | null;
  to?: number | null;
}

/** Build the /api/map/pins query string, omitting empty filters. Pure + tested. */
export function mapPinsQuery(workspaceId: string, filters?: MapFilters): string {
  const p = new URLSearchParams({ workspace_id: workspaceId });
  if (filters?.folderId) p.set('folder_id', filters.folderId);
  if (filters?.from != null) p.set('from', String(filters.from));
  if (filters?.to != null) p.set('to', String(filters.to));
  return p.toString();
}

export function fetchMapPins(workspaceId: string, filters?: MapFilters): Promise<MapPinsResponse> {
  return api.get<MapPinsResponse>(`/api/map/pins?${mapPinsQuery(workspaceId, filters)}`);
}
