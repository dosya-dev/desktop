import { isImage } from "@/lib/file-type";

export type MarkerType = 'thumbnail' | 'file-icon' | 'folder-icon';

export interface MarkerInfo {
  type: MarkerType;
  approximate: boolean;
}

/** The subset of a MapPin that marker selection actually needs. Folder pins carry
 *  no `extension` field at all (folders have no EXIF), so it's optional here. */
export interface MarkerPin {
  kind: 'file' | 'folder';
  source: 'exif' | 'ip' | null;
  extension?: string | null;
}

/**
 * Pure marker-selection logic for a map pin: what to render (thumbnail / a
 * generic file-type icon / a folder icon) and whether it should get the
 * "approximate" (IP-derived) treatment. `isImage` reuses the same extension
 * check the rest of the app uses to decide when a thumbnail can be rendered -
 * it accepts any string with a trailing extension, so passing the raw
 * `.ext`-style value the API stores works without reformatting it.
 */
export function markerFor(pin: MarkerPin): MarkerInfo {
  const approximate = pin.source === 'ip';
  if (pin.kind === 'folder') return { type: 'folder-icon', approximate };
  const type = pin.extension && isImage(pin.extension) ? 'thumbnail' : 'file-icon';
  return { type, approximate };
}
