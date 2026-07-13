import {describe, test, expect, beforeEach} from 'vitest';
import {SixFlags} from '../sixflags.js';
import {CacheLib} from '../../../cache.js';

function jsonResponse(payload: unknown) {
  return {json: async () => payload};
}

/**
 * Firebase serves `otherParks[].fimsId` as a numeric-looking *string* for
 * some parks even though it's typed as `number`. Regression coverage for
 * the bug this caused: `getParkData()` must coerce it, or the strict
 * `poi.parkId === wp.parkId` comparison in buildEntityList() never matches
 * (poi.parkId is always a real number from the POI API), the bundled
 * waterpark lookup silently returns zero POIs, and the /poi/park/{id}
 * standalone fallback 404s for BUNDLED-pattern waterparks — net effect,
 * the waterpark's entities vanish from every sync and the collector
 * proposes deleting them. Confirmed live for 5 of 7 Six Flags waterparks
 * (Cedar Point Shores, Knott's Soak City, and the NJ/LA/Chicago Hurricane
 * Harbors) before the fix.
 */
class Probe extends SixFlags {
  public firebaseConfig: unknown = {};

  override async fetchFirebaseConfig(): Promise<any> {
    return jsonResponse(this.firebaseConfig);
  }
}

function configWith(otherParks: Array<Record<string, unknown>>) {
  return {
    entries: {
      parkTypeHourAvailability: JSON.stringify({
        parkHourSettings: {
          905: {
            code: 'GADV',
            showThemePark: true,
            otherParks,
          },
        },
      }),
      oneShot: JSON.stringify({
        parks_configuration: [{parkId: 905, parkName: 'Six Flags Great Adventure'}],
      }),
    },
  };
}

describe('getParkData waterpark parkId coercion', () => {
  // getParkData() is @cache-decorated and takes no arguments, so every
  // Probe instance shares the same cache key — clear it between tests or
  // later tests see the first test's cached result instead of their own.
  beforeEach(() => {
    CacheLib.clearByClassName('Probe');
  });

  test('coerces a string fimsId to a number', async () => {
    const park = new Probe();
    park.firebaseConfig = configWith([
      {label: 'Water Park', fimsId: '925', fimsSiteCode: 'HHNJ', subProperty: 'Hurricane Harbor New Jersey'},
    ]);

    const parks = await park.getParkData();
    const ga = parks.find(p => p.parkId === 905);

    expect(ga?.waterParks).toHaveLength(1);
    expect(ga?.waterParks[0].parkId).toBe(925);
    expect(typeof ga?.waterParks[0].parkId).toBe('number');
  });

  test('leaves an already-numeric fimsId untouched', async () => {
    const park = new Probe();
    park.firebaseConfig = configWith([
      {label: 'Water Park', fimsId: 913, fimsSiteCode: 'HHAR', subProperty: 'Hurricane Harbor Arlington'},
    ]);

    const parks = await park.getParkData();
    const ga = parks.find(p => p.parkId === 905);

    expect(ga?.waterParks[0].parkId).toBe(913);
    expect(typeof ga?.waterParks[0].parkId).toBe('number');
  });

  test('a coerced waterpark parkId matches bundled POI records by strict equality', async () => {
    // This is the actual failure mode: buildEntityList() filters the
    // parent's already-fetched POI list with `poi.parkId === wp.parkId`.
    // poi.parkId comes from the POI API and is always a number, so a
    // string wp.parkId would never match even when the numeric values
    // are identical.
    const park = new Probe();
    park.firebaseConfig = configWith([
      {label: 'Water Park', fimsId: '925', fimsSiteCode: 'HHNJ', subProperty: 'Hurricane Harbor New Jersey'},
    ]);

    const parks = await park.getParkData();
    const wp = parks.find(p => p.parkId === 905)?.waterParks[0];

    const poiFromApi = [{parkId: 925, venueId: 1, fimsId: 'x', name: 'The Winds'}];
    const matches = poiFromApi.filter(poi => poi.parkId === wp?.parkId);

    expect(matches).toHaveLength(1);
  });
});
