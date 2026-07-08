/**
 * Tests for the Efteling live-data build.
 *
 * These pin the restaurant-hours fix: dining venues must publish their opening
 * hours under the schema key `operatingHours` (camelCase). It was previously
 * written as `operatinghours`, which the base class never normalises, so the
 * hours never reached schema-compliant consumers. The raw fetch methods are
 * stubbed so nothing hits the API; full integration runs via
 * `npm run dev -- efteling`.
 */

import {describe, test, expect} from 'vitest';
import {Efteling} from '../efteling.js';

/** A restaurant POI hit that passes buildLiveData's location/type filter. */
const DINING_POI = {fields: {id: 'rest1', category: 'restaurant', latlon: '51.65,5.05'}};

const DINING_WAITTIME = {
  Id: 'rest1',
  Type: 'Eten en Drinken',
  State: 'open',
  OpeningTimes: [{HourFrom: '2026-07-08T10:00:00', HourTo: '2026-07-08T20:00:00'}],
};

function mockedEfteling(poiHits: any[], waitTimes: any[]): Efteling {
  const park = new Efteling();
  (park as any).getPOIData = async () => poiHits;
  (park as any).getWaitTimes = async () => waitTimes;
  return park;
}

describe('Efteling buildLiveData — restaurant hours', () => {
  test('publishes dining hours under the schema key operatingHours (camelCase)', async () => {
    const park = mockedEfteling([DINING_POI], [DINING_WAITTIME]);
    const live = await (park as any).buildLiveData();

    const entry = live.find((l: any) => l.id === 'rest1');
    expect(entry).toBeDefined();
    expect(entry.status).toBe('OPERATING');
    expect(entry.operatingHours).toEqual([
      {startTime: '2026-07-08T10:00:00', endTime: '2026-07-08T20:00:00', type: 'OPERATING'},
    ]);
    // Guard against the regression: the misspelled lowercase key must not exist.
    expect(entry.operatinghours).toBeUndefined();
  });

  test('a closed dining venue is CLOSED but still publishes its hours', async () => {
    const park = mockedEfteling(
      [DINING_POI],
      [{...DINING_WAITTIME, State: 'closed'}],
    );
    const live = await (park as any).buildLiveData();

    const entry = live.find((l: any) => l.id === 'rest1');
    expect(entry.status).toBe('CLOSED');
    expect(entry.operatingHours).toHaveLength(1);
  });
});
