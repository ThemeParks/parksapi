import {describe, test, expect, beforeEach, afterEach} from 'vitest';
import {WalibiBelgium, Bellewaerde} from '../walibi.js';
import {CacheLib} from '../../../cache.js';
import type {HTTPObj} from '../../../http.js';

/**
 * The waitingtimes feed gives `time` in seconds. Now and then it posts values
 * that convert to 444, 999 or 1000 minutes: a dozen rides at once flip from
 * a five-minute wait to 444 and back on the next poll. Those are placeholders,
 * not queues. Any converted wait of 444, or of 600 minutes or more, is
 * published as no wait reported.
 */

const RIDE_A = 'a1b2c3d4-0000-4000-8000-000000000001';
const RIDE_B = 'a1b2c3d4-0000-4000-8000-000000000002';

const ATTRACTIONS = [
  {title: 'Ride A', waitingTimeName: RIDE_A, path: '/content/dam/wbe/en/attractions/ride-a', latitude: 50.7, longitude: 4.59},
  {title: 'Ride B', waitingTimeName: RIDE_B, path: '/content/dam/wbe/en/attractions/ride-b', latitude: 50.7, longitude: 4.59},
];

function stubbed<T extends WalibiBelgium | Bellewaerde>(park: T, waitTimes: any[]): T {
  park.fetchAttractions = (async () => ({json: async () => ATTRACTIONS} as any as HTTPObj)) as any;
  park.getRestaurants = async () => [];
  park.getWaitTimes = async () => waitTimes;
  return park;
}

async function waitFor(park: WalibiBelgium | Bellewaerde, id: string) {
  const live = await park.getLiveData();
  return live.find(l => l.id === id);
}

describe('Walibi placeholder wait times', () => {
  beforeEach(() => CacheLib.clear());
  afterEach(() => CacheLib.clear());

  test.each([
    [444, 26640],
    [999, 59940],
    [1000, 60000],
    [600, 36000],
  ])('%i minutes (time %i seconds) publishes no standby wait', async (_minutes, seconds) => {
    const park = stubbed(new WalibiBelgium(), [{id: RIDE_A, status: 'open', time: seconds}]);
    const entry = await waitFor(park, RIDE_A);

    expect(entry?.status).toBe('OPERATING');
    expect(entry?.queue?.STANDBY?.waitTime ?? null).toBeNull();
  });

  test('Bellewaerde shares the rule', async () => {
    const park = stubbed(new Bellewaerde(), [{id: RIDE_A, status: 'open', time: '26640'}]);
    const entry = await waitFor(park, RIDE_A);

    expect(entry?.queue?.STANDBY?.waitTime ?? null).toBeNull();
  });

  test('real waits still convert from seconds', async () => {
    const park = stubbed(new WalibiBelgium(), [
      {id: RIDE_A, status: 'open', time: 300},
      {id: RIDE_B, status: 'open', time: 26580},
    ]);

    expect((await waitFor(park, RIDE_A))?.queue?.STANDBY?.waitTime).toBe(5);
    // 443 minutes is not a known placeholder and sits under the cut-off.
    expect((await waitFor(park, RIDE_B))?.queue?.STANDBY?.waitTime).toBe(443);
  });
});
