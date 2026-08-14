import { apiBase } from "@/lib/api-client";
import type { StyleSpecification } from 'maplibre-gl';

// The vector basemap streams from R2 via our own API (range requests) - see
// apps/api/.../map/basemap.ts. It's a Protomaps-schema .pmtiles (whole world,
// z0-7). We render it with a small hand-written geometry style (no fonts/sprite,
// no external theme dependency) - validated to render cleanly with zero errors.
// Text labels are a future add-on (would need self-hosted glyph fonts).
// A function, not a constant: desktop resolves its API base at runtime from the
// main process, so there is nothing to interpolate at module load.
export function basemapUrl(): string {
  return `pmtiles://${apiBase()}/api/map/basemap`;
}
// Self-hosted Protomaps glyph fonts (Noto Sans Regular/Medium) in the web app's
// /public - same-origin, absolute URL (MapLibre needs glyphs absolute).
const ASSET_ORIGIN = typeof window !== 'undefined' ? window.location.origin : '';
const GLYPHS_URL = `${ASSET_ORIGIN}/map-assets/fonts/{fontstack}/{range}.pbf`;

/**
 * A self-contained style with NO external references - just a solid background.
 * Used before the basemap is confirmed available, so the map renders a clean
 * empty canvas with pins instead of throwing on missing tiles.
 */
function emptyStyle(dark: boolean): StyleSpecification {
  return {
    version: 8,
    sources: {},
    layers: [{ id: 'background', type: 'background', paint: { 'background-color': dark ? '#0f1720' : '#e7ebef' } }],
  };
}

/**
 * Probe whether the basemap PMTiles is actually in R2 (a tiny ranged GET). When
 * it isn't, `buildMapStyle` falls back to `emptyStyle` so the page never tries
 * to load a nonexistent basemap.
 */
export async function checkBasemapAvailable(): Promise<boolean> {
  try {
    const res = await fetch(`${apiBase()}/api/map/basemap`, { headers: { Range: 'bytes=0-0' } });
    return res.ok; // 200/206 when the .pmtiles exists; 404 when not provisioned
  } catch {
    return false;
  }
}

// Apple-Photos-ish palette: pale green land, green parks/forest, soft blue water.
type Palette = {
  water: string; earth: string; landuse: string; roads: string; boundaries: string;
  label: string; waterLabel: string; labelHalo: string;
};
const LIGHT: Palette = {
  water: '#a3d0ef', earth: '#eef1de', landuse: '#c7e2a4', roads: '#ffffff', boundaries: '#b3b9bf',
  label: '#41513a', waterLabel: '#5b86ad', labelHalo: '#ffffff',
};
const DARK: Palette = {
  water: '#0d1b2a', earth: '#1c2b22', landuse: '#223a2a', roads: '#43564c', boundaries: '#3c4c42',
  label: '#b6c0b6', waterLabel: '#6a8aa5', labelHalo: '#0d1b2a',
};

export function buildMapStyle(dark: boolean, hasBasemap = false): StyleSpecification {
  if (!hasBasemap) return emptyStyle(dark);
  const c = dark ? DARK : LIGHT;
  // Geometry layers (earth/landuse/water/roads/boundaries) + place-name labels.
  // Labels use only self-hosted glyph fonts (no sprite icons), and each place
  // layer is filtered by its `min_zoom` so the map declutters as you zoom out.
  return {
    version: 8,
    glyphs: GLYPHS_URL,
    sources: {
      protomaps: { type: 'vector', url: basemapUrl(), attribution: '© OpenStreetMap' },
    },
    layers: [
      { id: 'background', type: 'background', paint: { 'background-color': c.water } },
      { id: 'earth', type: 'fill', source: 'protomaps', 'source-layer': 'earth', paint: { 'fill-color': c.earth } },
      { id: 'landuse', type: 'fill', source: 'protomaps', 'source-layer': 'landuse', paint: { 'fill-color': c.landuse } },
      { id: 'water', type: 'fill', source: 'protomaps', 'source-layer': 'water', paint: { 'fill-color': c.water } },
      { id: 'roads', type: 'line', source: 'protomaps', 'source-layer': 'roads', paint: { 'line-color': c.roads, 'line-width': 0.7 } },
      { id: 'boundaries', type: 'line', source: 'protomaps', 'source-layer': 'boundaries', paint: { 'line-color': c.boundaries, 'line-width': 0.5 } },
      // Ocean / sea labels
      {
        id: 'water-labels', type: 'symbol', source: 'protomaps', 'source-layer': 'water',
        filter: ['all', ['has', 'name'], ['<=', ['coalesce', ['get', 'min_zoom'], 0], ['zoom']]],
        layout: {
          'text-field': ['coalesce', ['get', 'name:en'], ['get', 'name']],
          'text-font': ['Noto Sans Regular'],
          'text-size': ['interpolate', ['linear'], ['zoom'], 2, 10, 8, 13],
          'text-max-width': 6,
        },
        paint: { 'text-color': c.waterLabel, 'text-halo-color': c.labelHalo, 'text-halo-width': 1 },
      },
      // Place labels: continents, countries, cities/towns (min_zoom declutters)
      {
        id: 'places-labels', type: 'symbol', source: 'protomaps', 'source-layer': 'places',
        filter: ['<=', ['coalesce', ['get', 'min_zoom'], 0], ['zoom']],
        layout: {
          'text-field': ['coalesce', ['get', 'name:en'], ['get', 'name']],
          'text-font': ['Noto Sans Medium'],
          'text-size': ['interpolate', ['linear'], ['zoom'], 2, 11, 8, 15],
          'text-max-width': 7,
        },
        paint: { 'text-color': c.label, 'text-halo-color': c.labelHalo, 'text-halo-width': 1.3 },
      },
    ] as StyleSpecification['layers'],
  };
}
