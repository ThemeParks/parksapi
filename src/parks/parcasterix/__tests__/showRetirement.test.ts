import {describe, it, expect, vi, beforeEach, afterEach} from 'vitest';
import {ParcAsterix} from '../parcasterix.js';
import {CacheLib} from '../../../cache.js';

/**
 * Four retired Parc Asterix shows were still reading OPERATING on the wiki
 * 8 to 24 days after their last write. A show that ends its run leaves
 * `paxSchedules` entirely rather than reporting no performances, so
 * buildLiveData() has nothing to key off, and the collector is upsert-only —
 * dropping the row changes nothing. Parc Asterix opts into the shared
 * retirement gate (destination.ts) to force-close it instead.
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

function stubbedPark(
  latencies: ReturnType<typeof latency>[],
  schedules: ReturnType<typeof performance>[],
): ParcAsterix {
  const park = new ParcAsterix();
  vi.spyOn(park as any, 'getPolling').mockResolvedValue({latencies, schedules});
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

  it('leaves a show alone that simply did not perform this week', async () => {
    vi.useFakeTimers();

    await stubbedPark(ATTRACTIONS, [performance('31483')]).getLiveData();

    // Shows drop out of paxSchedules on any day they do not perform, so a few
    // days of absence is an ordinary weekly cadence, not a retirement.
    vi.setSystemTime(Date.now() + 5 * DAY);
    await stubbedPark(ATTRACTIONS, []).getLiveData();
    await stubbedPark(ATTRACTIONS, []).getLiveData();
    const live = await stubbedPark(ATTRACTIONS, []).getLiveData();

    expect(live.find((l) => l.id === '31483')).toBeUndefined();
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

  // getPolling() returns `data?.data?.paxLatencies || []`, so a malformed or
  // gutted GraphQL response parses cleanly into an empty build rather than
  // throwing. Retiring on that would publish a confident CLOSED for a park
  // that is open.
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
