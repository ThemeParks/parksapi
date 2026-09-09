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

const show = (drupalId: number, type: POIEntry['_type'] = 'show'): POIEntry => ({
  drupal_id: drupalId,
  title: `Show ${drupalId}`,
  titles: {en: `Show ${drupalId}`},
  latitude: 49.13675,
  longitude: 2.573816,
  _type: type,
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
  vi.spyOn(park as any, 'getPOIData').mockImplementation(async () => {
    // An ordinary open day for whatever the fake clock currently says, so the
    // bill is believed and the gate is being tested against it rather than
    // against a calendar that quietly silences the bill.
    const date = new Date().toISOString().slice(0, 10);
    return {
      poi,
      calendar: [
        {
          date,
          type: 'OPERATING',
          openingTime: `${date}T10:00:00+02:00`,
          closingTime: `${date}T18:00:00+02:00`,
        },
      ],
    };
  });
  return park;
}

/** Enough attractions that the degraded-feed guard has a real denominator. */
const ATTRACTION_IDS = Array.from({length: 20}, (_, i) => 31303 + i);
const ATTRACTIONS = ATTRACTION_IDS.map((id) => latency(String(id)));
/**
 * The package rows behind ATTRACTIONS. buildLiveData() only reads the bill as
 * darkness when the attraction bill corroborates it against these, so a test
 * that wants the bill to close a show has to supply them — without them the
 * closure under test would silently be the gate's, not the bill's.
 */
const ATTRACTION_POI = ATTRACTION_IDS.map((id) => show(id, 'attraction'));

/**
 * Mid-afternoon on an operating day, and every jump below is a whole number of
 * days from it, so each build lands inside opening hours too. Pinned rather
 * than started from the wall clock: buildLiveData() only reads the bill as
 * darkness once the park has opened, so an unpinned run silences the bill
 * before ~10:00 and after midnight local, and the gate quietly does the
 * closing that these tests are asserting the bill does — green in the
 * afternoon, red overnight and in CI.
 */
const DAYTIME = new Date('2026-09-09T12:00:00Z');

describe('Parc Asterix show retirement', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    CacheLib.clearByClassName('ParcAsterix', {includePersistent: true});
    vi.useFakeTimers();
    vi.setSystemTime(DAYTIME);
  });

  afterEach(() => vi.useRealTimers());

  it('is enabled', () => {
    expect(new ParcAsterix()['retireMissingLiveEntities']).toBe(true);
  });

  it('force-closes a show gone from paxSchedules past the retirement window', async () => {
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

  // Below the window, a plain absence is not yet evidence of anything. This is
  // the gate's own boundary, kept isolated from the reset case below so a
  // regression in either cannot hide behind the other.
  it('leaves a show alone that has been absent for less than the window', async () => {
    await stubbedPark(ATTRACTIONS, [performance('31483')]).getLiveData();

    vi.setSystemTime(Date.now() + 5 * DAY);
    await stubbedPark(ATTRACTIONS, []).getLiveData();
    await stubbedPark(ATTRACTIONS, []).getLiveData();
    const live = await stubbedPark(ATTRACTIONS, []).getLiveData();

    expect(live.find((l) => l.id === '31483')).toBeUndefined();
  });

  // While the package still lists the show, the bill closes it the same day
  // and the gate never sees it absent, so the two cannot both speak for it.
  // The row alone cannot show which one produced it — either would emit the
  // same thing — so this watches for the gate's own log line instead.
  it('stays out of the way while the package still lists the show', async () => {
    const poi = [...ATTRACTION_POI, show(31483)];
    await stubbedPark(ATTRACTIONS, [performance('31483')], poi).getLiveData();

    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.setSystemTime(Date.now() + 30 * DAY);
    await stubbedPark(ATTRACTIONS, [], poi).getLiveData();
    await stubbedPark(ATTRACTIONS, [], poi).getLiveData();
    const live = await stubbedPark(ATTRACTIONS, [], poi).getLiveData();

    expect(live.filter((l) => l.id === '31483')).toEqual([
      {id: '31483', status: 'CLOSED'},
    ]);
    expect(
      log.mock.calls.flat().filter((line) => String(line).includes('force-closing')),
    ).toEqual([]);
  });

  // And the same scenario with the package row gone is the gate's to handle,
  // so the log line proves the two are genuinely split rather than one of them
  // quietly covering for the other in both tests.
  it('does the closing itself once the package row goes', async () => {
    await stubbedPark(ATTRACTIONS, [performance('31483')], ATTRACTION_POI).getLiveData();

    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.setSystemTime(Date.now() + 8 * DAY);
    await stubbedPark(ATTRACTIONS, [], ATTRACTION_POI).getLiveData();
    await stubbedPark(ATTRACTIONS, [], ATTRACTION_POI).getLiveData();
    const live = await stubbedPark(ATTRACTIONS, [], ATTRACTION_POI).getLiveData();

    expect(live.filter((l) => l.id === '31483')).toEqual([
      {id: '31483', status: 'CLOSED'},
    ]);
    expect(
      log.mock.calls.flat().filter((line) => String(line).includes('force-closing')),
    ).toHaveLength(1);
  });

  it('resets the window when the show performs again', async () => {
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
