import { test } from "node:test";
import assert from "node:assert/strict";

import { groupLocations, pickPreselected, type RegionInfo } from "./location-groups.ts";

/**
 * Run with `npm run test:unit` in apps/desktop - Node's own test runner.
 *
 * A workspace's location is chosen once, at creation, and the server refuses to
 * move it afterwards. So the create page's picker is the only place the choice
 * is offered and it has to make 40-odd locations findable: grouped by continent,
 * searchable by city, country or code. This is that grouping and filtering,
 * pulled out of the page so it can be tested without a renderer.
 */

const REGIONS: RegionInfo[] = [
  { code: "ap-southeast-2", city: "Sydney", country: "Australia", continent: "Oceania", flag: "\u{1F1E6}\u{1F1FA}" },
  { code: "eu-west-1", city: "Dublin", country: "Ireland", continent: "Europe" },
  { code: "eu-central-1", city: "Frankfurt", country: "Germany", continent: "Europe" },
  { code: "us-east-1", city: "Ashburn", country: "United States", continent: "North America" },
];

const shape = (groups: [string, RegionInfo[]][]) =>
  groups.map(([continent, rows]) => [continent, rows.map((r) => r.code)]);

test("an empty query offers every location, grouped by continent", () => {
  assert.deepEqual(shape(groupLocations(REGIONS, "")), [
    ["Oceania", ["ap-southeast-2"]],
    ["Europe", ["eu-west-1", "eu-central-1"]],
    ["North America", ["us-east-1"]],
  ]);
});

test("a whitespace-only query is no query at all", () => {
  assert.deepEqual(shape(groupLocations(REGIONS, "   ")), shape(groupLocations(REGIONS, "")));
});

test("continents come in the order the server sent them, and so do their rows", () => {
  const groups = groupLocations(REGIONS, "");
  assert.deepEqual(groups.map(([continent]) => continent), ["Oceania", "Europe", "North America"]);
});

test("filters by city", () => {
  assert.deepEqual(shape(groupLocations(REGIONS, "frank")), [["Europe", ["eu-central-1"]]]);
});

test("filters by country", () => {
  assert.deepEqual(shape(groupLocations(REGIONS, "ireland")), [["Europe", ["eu-west-1"]]]);
});

test("filters by code", () => {
  assert.deepEqual(shape(groupLocations(REGIONS, "ap-southeast")), [["Oceania", ["ap-southeast-2"]]]);
});

test("matching is case-insensitive and ignores surrounding spaces", () => {
  assert.deepEqual(shape(groupLocations(REGIONS, "  SYDNEY ")), [["Oceania", ["ap-southeast-2"]]]);
});

test("a continent with no match is left out entirely", () => {
  const groups = groupLocations(REGIONS, "eu-");
  assert.deepEqual(groups.map(([continent]) => continent), ["Europe"]);
});

test("nothing matching is an empty list, not a group of nothing", () => {
  assert.deepEqual(groupLocations(REGIONS, "atlantis"), []);
});

test("no locations yet is an empty list, not a crash", () => {
  assert.deepEqual(groupLocations([], ""), []);
  assert.deepEqual(groupLocations([], "sydney"), []);
});

test("preselects the server's suggestion when it is one of the offered locations", () => {
  assert.equal(pickPreselected(REGIONS, "eu-west-1"), "eu-west-1");
});

test("preselects nothing when the suggestion is not in the list", () => {
  // A code the picker cannot show must not become the silent answer: the
  // create page would send a location the user never saw and could not change.
  assert.equal(pickPreselected(REGIONS, "mars-north-1"), "");
});

test("preselects nothing when there is no suggestion, or no list yet", () => {
  assert.equal(pickPreselected(REGIONS, undefined), "");
  assert.equal(pickPreselected(REGIONS, ""), "");
  assert.equal(pickPreselected([], "eu-west-1"), "");
});
