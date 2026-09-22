export interface RegionInfo {
  code: string;
  city: string;
  country: string;
  continent: string;
  flag?: string;
}

/**
 * Group the locations a workspace can be created in, filtered by a search box.
 *
 * A workspace's location is chosen once, at creation, and cannot be changed
 * afterwards, so the picker on the create page is the only place the choice is
 * offered - it has to make 40-odd locations findable. Continents come back in
 * the order the server sent them (first appearance wins) and so do the rows
 * inside each, so the server keeps control of what is listed first. A continent
 * whose locations all fail the search is dropped rather than shown empty.
 *
 * The query matches a city, a country or a region code, case-insensitively, as
 * a substring. An empty or whitespace-only query is no query at all.
 */
export function groupLocations(regions: RegionInfo[], query: string): [string, RegionInfo[]][] {
  const q = query.trim().toLowerCase();
  const matched = q
    ? regions.filter(
        (r) =>
          r.city.toLowerCase().includes(q) ||
          r.country.toLowerCase().includes(q) ||
          r.code.toLowerCase().includes(q),
      )
    : regions;
  const byContinent = new Map<string, RegionInfo[]>();
  for (const r of matched) {
    const rows = byContinent.get(r.continent);
    if (rows) rows.push(r);
    else byContinent.set(r.continent, [r]);
  }
  return [...byContinent.entries()];
}

/**
 * The location to start the create form on: the server's nearest-location
 * guess, but only when that code is one the picker actually offers.
 *
 * A suggestion outside the list cannot be shown as selected and cannot be
 * changed by clicking, so accepting it would send the workspace somewhere the
 * user never saw. Returning "" instead leaves the form unselected, which is the
 * same state as "the list has not loaded" - the create page already knows how
 * to handle that.
 */
export function pickPreselected(regions: RegionInfo[], suggested: string | undefined): string {
  if (!suggested) return "";
  return regions.some((r) => r.code === suggested) ? suggested : "";
}
