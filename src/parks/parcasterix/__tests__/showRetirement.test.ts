import {describe, it, expect, vi, beforeEach, afterEach} from 'vitest';
import {ParcAsterix, type POIEntry} from '../parcasterix.js';
import {CacheLib} from '../../../cache.js';

/**
 * A show that leaves `paxSchedules` for the day is closed the same poll from
 * the bill itself — see showAbsence.test.ts, which is what actually clears a
 * frozen show row now.
 *
 * The gate covers the case the bill cannot see: a show that leaves the offline
 * package as well, taking its POI row with it. Nothing then names the id at
 * all, so there is nothing to close it against, and the collector being
 * upsert-only means dropping the row changes nothing on the wiki. Four retired
 * shows read OPERATING for 8 to 24 days that way.
 */
const DAY = 24 * 60 * 60 * 1000;

const latency = (drupalId: string, isOpen = true, latencyValue: number | null = 10) => ({
  drupalId,
  latency: latencyValue,
  isOpen,
  message: null,
  openingTime: null,
  closingTime: null,
});

const performance = (drupalId: string) => ({
  drupalId,
  times: [{at: '14:00:00', startAt: null, endAt: null}],
});

const show = (drupalId: number): POIEntry => ({
  drupal_id: drupalId,
  title: `Show ${drupalId}`,
  titles: {en: `Show ${drupalId}`},
  latitude: 49.13675,
  longitude: 2.573816,
  _type: 'show',
});

/**
 * The default empty POI list is the scenario under test: the package has
 * dropped the show's row, so buildLiveData() cannot close it from the bill.
 */
function stubbedPark(
  latencies: ReturnType<typeof latency>[],
  schedules: ReturnType<typeof performance>[],
  poi: POIEntry[] = [],
): ParcAsterix {
  const park = new ParcAsterix();
  vi.spyOn(park as any, 'getPolling').mockResolvedValue({latencies, schedules});
  vi.spyOn(park as any, 'getPOIData').mockResolvedValue({poi, calendar: []});
  return park;
}

/** Enough attractions that the degraded-feed guard has a real denominator. */
const ATTRACTIONS = Array.from({length: 20}, (_, i) => latency(String(31303 + i)));

describe('Parc Asterix show retirement', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    CacheLib.clearByClassName('ParcAsterix', {includePersistent: true});
  });

  afterEach(() => vi.useRealTimers());

  it('is enabled', () => {
    expect(new ParcAsterix()['retireMissingLiveEntities']).toBe(true);
  });

  it('force-closes a show gone from paxSchedules past the retirement window', async () => {
    vi.useFakeTimers();

    await stubbedPark(ATTRACTIONS, [performance('31483')]).getLiveData();

    // The run ended: the show leaves paxSchedules, and the offline package
    // drops its POI row in the same release.
    vi.setSystemTime(Date.now() + 8 * DAY);
    // The gate wants the absence corroborated across consecutive polls.
    await stubbedPark(ATTRACTIONS, []).getLiveData();
    await stubbedPark(ATTRACTIONS, []).getLiveData();
    const live = await stubbedPark(ATTRACTIONS, []).getLiveData();

    expect(live.find((l) => l.id === '31483')).toEqual({id: '31483', status: 'CLOSED'});
  });

  // While the package still lists the show, the bill closes it the same day
  // and the gate never sees it absent, so the two cannot both speak for it.
  it('stays out of the way while the package still lists the show', async () => {
    vi.useFakeTimers();

    const poi = [show(31483)];
    await stubbedPark(ATTRACTIONS, [performance('31483')], poi).getLiveData();

    vi.setSystemTime(Date.now() + 30 * DAY);
    await stubbedPark(ATTRACTIONS, [], poi).getLiveData();
    await stubbedPark(ATTRACTIONS, [], poi).getLiveData();
    const live = await stubbedPark(ATTRACTIONS, [], poi).getLiveData();

    expect(live.filter((l) => l.id === '31483')).toEqual([
      {id: '31483', status: 'CLOSED'},
    ]);
  });

  it('resets the window when the show performs again', async () => {
    vi.useFakeTimers();

    await stubbedPark(ATTRACTIONS, [performance('31483')]).getLiveData();
    vi.setSystemTime(Date.now() + 6 * DAY);
    await stubbedPark(ATTRACTIONS, []).getLiveData();

    // Back on the bill before the window elapsed.
    vi.setSystemTime(Date.now() + 1 * DAY);
    await stubbedPark(ATTRACTIONS, [performance('31483')]).getLiveData();

    vi.setSystemTime(Date.now() + 5 * DAY);
    await stubbedPark(ATTRACTIONS, []).getLiveData();
    await stubbedPark(ATTRACTIONS, []).getLiveData();
    const live = await stubbedPark(ATTRACTIONS, []).getLiveData();

    expect(live.find((l) => l.id === '31483')).toBeUndefined();
  });

  // getPolling() now throws on a malformed GraphQL payload, but a caller that
  // hands the gate an empty build by any other route must still not retire on
  // it: a confident CLOSED across an open park is the failure being avoided.
  it('withholds retirement when the whole polling feed comes back empty', async () => {
    vi.useFakeTimers();

    await stubbedPark(ATTRACTIONS, [performance('31483')]).getLiveData();

    vi.setSystemTime(Date.now() + 8 * DAY);
    await stubbedPark([], []).getLiveData();
    await stubbedPark([], []).getLiveData();
    const live = await stubbedPark([], []).getLiveData();

    expect(live.find((l) => l.status === 'CLOSED')).toBeUndefined();
    expect(live).toHaveLength(0);
  });

  // The winter closure takes every show out at once while paxLatencies keeps
  // listing the attractions as closed. That is a real closure, not a broken
  // feed, and the shows should close.
  it('still retires shows across a seasonal closure, with attractions unaffected', async () => {
    vi.useFakeTimers();

    const shows = ['31483', '31485', '31502'].map(performance);
    await stubbedPark(ATTRACTIONS, shows).getLiveData();

    const shut = ATTRACTIONS.map((a) => latency(a.drupalId, false, null));
    vi.setSystemTime(Date.now() + 30 * DAY);
    await stubbedPark(shut, []).getLiveData();
    await stubbedPark(shut, []).getLiveData();
    const live = await stubbedPark(shut, []).getLiveData();

    for (const id of ['31483', '31485', '31502']) {
      expect(live.find((l) => l.id === id)).toEqual({id, status: 'CLOSED'});
    }
    expect(live.find((l) => l.id === '31303')).toMatchObject({status: 'CLOSED'});
  });
});
