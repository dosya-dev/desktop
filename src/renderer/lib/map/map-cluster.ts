import Supercluster, { type PointFeature } from 'supercluster';

export type PinPointProps = { pinId: string };
export type PinFeature = PointFeature<PinPointProps>;

/** [west, south, east, north] */
export type Bbox = [number, number, number, number];

/**
 * Zoom past which supercluster stops clustering and returns raw points.
 *
 * This matters more than it looks: files that only have an IP-derived fallback
 * coordinate (origin.ts stamps one at upload) all share the SAME point, so a
 * 2000-photo upload is 2000 identical coordinates. Above maxZoom supercluster
 * hands every one of them back individually, which the map then turns into 2000
 * stacked markers on one pixel. `clustersInView` clamps its query zoom to this
 * so that can't happen; see the clamp there.
 */
const CLUSTER_MAX_ZOOM = 16;

/** Web Mercator can't represent the poles; tiles stop here. */
const MAX_LAT = 85;

export function pinsToFeatures(
  pins: { id: string; latitude: number; longitude: number }[],
): PinFeature[] {
  return pins.map((p) => ({
    type: 'Feature',
    properties: { pinId: p.id },
    geometry: { type: 'Point', coordinates: [p.longitude, p.latitude] },
  }));
}

export function buildClusterIndex(features: PinFeature[]): Supercluster<PinPointProps> {
  const index = new Supercluster<PinPointProps>({ radius: 60, maxZoom: CLUSTER_MAX_ZOOM });
  index.load(features);
  return index;
}

export type ViewItem =
  | {
      kind: 'cluster';
      id: number;
      count: number;
      lon: number;
      lat: number;
      expansionZoom: number;
      /** False when zooming in cannot separate the members (identical coordinates). */
      expandable: boolean;
      sampleIds: string[];
    }
  | { kind: 'pin'; pinId: string; lon: number; lat: number };

/**
 * Wrap a longitude into [-180, 180]. Values already in range are returned
 * untouched - running them through the modulo would perturb them by ~1e-14 for
 * no reason, and that is the case for every viewport that hasn't been panned
 * off the first world copy.
 */
function wrapLon(lon: number): number {
  if (lon >= -180 && lon <= 180) return lon;
  return ((((lon + 180) % 360) + 360) % 360) - 180;
}

/**
 * Turn the map's current bounds into the 1-2 clamped bboxes supercluster can
 * actually be queried with.
 *
 * MapLibre's bounds are not normalized: pan east and `west`/`east` keep counting
 * past 180 into the next world copy, and a query with those raw numbers matches
 * nothing (which is why this used to just ask for the whole world, rendering
 * every pin on the planet). Wrapping brings them back into range, and a viewport
 * straddling the antimeridian becomes two ranges rather than an inverted one.
 */
export function viewportBboxes(bounds: {
  west: number;
  south: number;
  east: number;
  north: number;
}): Bbox[] {
  const south = Math.max(-MAX_LAT, Math.min(MAX_LAT, bounds.south));
  const north = Math.max(-MAX_LAT, Math.min(MAX_LAT, bounds.north));

  // Zoomed out far enough to see a whole turn (or more): nothing to wrap.
  if (bounds.east - bounds.west >= 360) return [[-180, south, 180, north]];

  const west = wrapLon(bounds.west);
  const east = wrapLon(bounds.east);
  if (west <= east) return [[west, south, east, north]];
  return [
    [west, south, 180, north],
    [-180, south, east, north],
  ];
}

/**
 * The clusters and individual pins to draw for the given view.
 *
 * Accepts several bboxes so an antimeridian-straddling viewport can be asked for
 * in two pieces; results are de-duplicated, since the pieces can overlap.
 */
export function clustersInView(
  index: Supercluster<PinPointProps>,
  bbox: Bbox | Bbox[],
  zoom: number,
): ViewItem[] {
  const boxes = Array.isArray(bbox[0]) ? (bbox as Bbox[]) : [bbox as Bbox];
  // Clamp: above the index's maxZoom supercluster returns every point raw, so
  // coincident pins (see CLUSTER_MAX_ZOOM) would explode into one marker each.
  const z = Math.min(Math.round(zoom), CLUSTER_MAX_ZOOM);

  const seen = new Set<string>();
  const items: ViewItem[] = [];

  for (const box of boxes) {
    for (const f of index.getClusters(box, z)) {
      const [lon, lat] = f.geometry.coordinates as [number, number];
      const props = f.properties as PinPointProps & {
        cluster?: boolean;
        cluster_id?: number;
        point_count?: number;
      };

      if (props.cluster) {
        const id = props.cluster_id as number;
        if (seen.has(`c${id}`)) continue;
        seen.add(`c${id}`);
        // A few representative leaf ids so the marker can show a cover photo (Apple-style).
        const sampleIds = (index.getLeaves(id, 6) as PinFeature[]).map((l) => l.properties.pinId);
        const expansionZoom = Math.min(index.getClusterExpansionZoom(id), 20);
        items.push({
          kind: 'cluster',
          id,
          count: props.point_count as number,
          lon,
          lat,
          expansionZoom,
          expandable: expansionZoom <= CLUSTER_MAX_ZOOM,
          sampleIds,
        });
      } else {
        const pinId = props.pinId;
        if (seen.has(`p${pinId}`)) continue;
        seen.add(`p${pinId}`);
        items.push({ kind: 'pin', pinId, lon, lat });
      }
    }
  }

  return items;
}
