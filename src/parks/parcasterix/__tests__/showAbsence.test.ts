import {describe, it, expect, vi, beforeEach, afterEach} from 'vitest';
import {ParcAsterix, type POIEntry} from '../parcasterix.js';
import {CacheLib} from '../../../cache.js';

/**
 * `paxSchedules` is a same-day bill: it carries one entry per show performing
 * today and nothing at all for the rest. A show that is dark today therefore
 * has no live row to key off, and the collector is upsert-only — so the wiki
 * kept serving whichever showtimes the show last performed to, still reading
 * OPERATING. Three Parc Asterix shows were sitting on 11-day-old times when a
 * user reported it.
 *
 * Absence is not ambiguous here, so it does not need a multi-day window to
 * interpret: a show missing from a bill that lists every performance today has
 * no performances today, which is exactly what CLOSED says.
 */
const show = (drupalId: number, title = `Show ${drupalId}`): POIEntry => ({
  drupal_id: drupalId,
  title,
  titles: {en: title},
  latitude: 49.13675,
  longitude: 2.573816,
  _type: 'show',
});

const attraction = (drupalId: number): POIEntry => ({
  ...show(drupalId, `Attraction ${drupalId}`),
  _type: 'attraction',
});

const restaurant = (drupalId: number): POIEntry => ({
  ...show(drupalId, `Restaurant ${drupalId}`),
  _type: 'restaurant',
});

const latency = (drupalId: string, isOpen = true, latencyValue: number | null = 10) => ({
  drupalId,
  latency: latencyValue,
  isOpen,
  message: null,
  openingTime: null,
  closingTime: null,
});

const performance = (drupalId: string, times = [{at: '14:00:00', startAt: null, endAt: null}]) => ({
  drupalId,
  times,
});

const ATTRACTION_IDS = Array.from({length: 20}, (_, i) => 31303 + i);
const ATTRACTIONS = ATTRACTION_IDS.map((id) => latency(String(id)));
/** The package rows behind ATTRACTIONS, so the corroboration check has a denominator. */
const ATTRACTION_POI = ATTRACTION_IDS.map(attraction);

/** Mid-afternoon in Europe/Paris — outside the after-midnight window. */
const DAYTIME = new Date('2026-09-09T12:00:00Z');

function stubbedPark(
  latencies: ReturnType<typeof latency>[],
  schedules: ReturnType<typeof performance>[],
  poi: POIEntry[],
): ParcAsterix {
  const park = new ParcAsterix();
  vi.spyOn(park as any, 'getPolling').mockResolvedValue({latencies, schedules});
  vi.spyOn(park as any, 'getPOIData').mockResolvedValue({poi, calendar: []});
  return park;
}

describe('Parc Asterix shows dark today', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    CacheLib.clearByClassName('ParcAsterix', {includePersistent: true});
    vi.useFakeTimers();
    vi.setSystemTime(DAYTIME);
  });

  afterEach(() => vi.useRealTimers());

  it('closes a show that is not on today’s bill', async () => {
    const live = await stubbedPark(
      ATTRACTIONS,
      [performance('31483')],
      [...ATTRACTION_POI, show(31483), show(31513)],
    ).getLiveData();

    expect(live.find((l) => l.id === '31483')).toEqual({
      id: '31483',
      status: 'OPERATING',
      showtimes: [
        {
          type: 'Performance Time',
          startTime: '2026-09-09T14:00:00+02:00',
          endTime: '2026-09-09T14:00:00+02:00',
        },
      ],
    });
    expect(live.find((l) => l.id === '31513')).toEqual({id: '31513', status: 'CLOSED'});
  });

  it('publishes a closed row, not the last showtimes it saw', async () => {
    const poi = [...ATTRACTION_POI, show(31513)];
    const performing = await stubbedPark(ATTRACTIONS, [performance('31513')], poi).getLiveData();
    expect(performing.find((l) => l.id === '31513')?.showtimes).toHaveLength(1);

    const dark = await stubbedPark(ATTRACTIONS, [], poi).getLiveData();
    // Not `?.showtimes` — an optional chain here cannot tell a closed row with
    // no showtimes from no row at all, which is the whole point of the test.
    expect(dark.find((l) => l.id === '31513')).toEqual({id: '31513', status: 'CLOSED'});
  });

  it('closes a show whose run ended before this gate ever saw it perform', async () => {
    // The retirement gate can only close ids it has watched go absent, so a
    // show that stopped performing before the code shipped is invisible to it.
    // Reading the bill directly needs no such history.
    const live = await stubbedPark(
      ATTRACTIONS,
      [],
      [...ATTRACTION_POI, show(31509), show(31513)],
    ).getLiveData();

    expect(live.find((l) => l.id === '31509')).toEqual({id: '31509', status: 'CLOSED'});
    expect(live.find((l) => l.id === '31513')).toEqual({id: '31513', status: 'CLOSED'});
  });

  it('reopens the show the day it is back on the bill', async () => {
    const poi = [...ATTRACTION_POI, show(31513)];
    const dark = await stubbedPark(ATTRACTIONS, [], poi).getLiveData();
    expect(dark.find((l) => l.id === '31513')).toEqual({id: '31513', status: 'CLOSED'});

    const live = await stubbedPark(ATTRACTIONS, [performance('31513')], poi).getLiveData();
    expect(live.find((l) => l.id === '31513')).toMatchObject({status: 'OPERATING'});
  });

  it('closes only shows, never an attraction or a restaurant', async () => {
    const live = await stubbedPark(
      ATTRACTIONS,
      [],
      [...ATTRACTION_POI, attraction(99991), restaurant(99992), show(31513)],
    ).getLiveData();

    expect(live.find((l) => l.id === '99991')).toBeUndefined();
    expect(live.find((l) => l.id === '99992')).toBeUndefined();
    expect(live.find((l) => l.id === '31513')).toEqual({id: '31513', status: 'CLOSED'});
  });

  it('never publishes a row for a show with no usable id', async () => {
    const live = await stubbedPark(ATTRACTIONS, [], [
      ...ATTRACTION_POI,
      {...show(0), drupal_id: 0},
      {...show(1), drupal_id: undefined as unknown as number},
      show(31513),
    ]).getLiveData();

    for (const bad of ['0', 'undefined', 'NaN', 'null', '']) {
      expect(live.find((l) => l.id === bad)).toBeUndefined();
    }
    expect(live.find((l) => l.id === '31513')).toEqual({id: '31513', status: 'CLOSED'});
  });

  // A show on the bill with no performances left is already closed by the
  // showtime pass. It must not also collect a dark row.
  it('emits one row for a show on the bill with no times', async () => {
    const live = await stubbedPark(
      ATTRACTIONS,
      [performance('31513', [])],
      [...ATTRACTION_POI, show(31513)],
    ).getLiveData();

    expect(live.filter((l) => l.id === '31513')).toEqual([{id: '31513', status: 'CLOSED'}]);
  });

  // The two bills have always been disjoint, but if an id ever appeared in
  // both, the observation has to beat the inference — otherwise the build
  // carries OPERATING and CLOSED for one id and array order decides.
  it('lets a live observation win over an inferred closure', async () => {
    const live = await stubbedPark(
      [...ATTRACTIONS, latency('31513')],
      [],
      [...ATTRACTION_POI, show(31513)],
    ).getLiveData();

    expect(live.filter((l) => l.id === '31513')).toEqual([
      {id: '31513', status: 'OPERATING', queue: {STANDBY: {waitTime: 10}}},
    ]);
  });

  it('emits at most one row per id', async () => {
    const live = await stubbedPark(
      [...ATTRACTIONS, latency('31513')],
      [performance('31483'), performance('31513')],
      [...ATTRACTION_POI, show(31483), show(31513), show(31509)],
    ).getLiveData();

    const ids = live.map((l) => l.id);
    expect(ids).toHaveLength(new Set(ids).size);
  });
});

describe('Parc Asterix dark-show guards', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    CacheLib.clearByClassName('ParcAsterix', {includePersistent: true});
    vi.useFakeTimers();
    vi.setSystemTime(DAYTIME);
  });

  afterEach(() => vi.useRealTimers());

  // A gutted response reaching buildLiveData by any route must not be read as
  // a park where every show is dark.
  it('says nothing when the whole polling feed comes back empty', async () => {
    const live = await stubbedPark([], [], [...ATTRACTION_POI, show(31483), show(31513)]).getLiveData();

    expect(live).toHaveLength(0);
  });

  // The real shape of an upstream wobble is partial, not empty. One attraction
  // out of twenty is not a feed that can speak for what is dark.
  it('says nothing when the attraction bill comes back a fraction of itself', async () => {
    const live = await stubbedPark(
      ATTRACTIONS.slice(0, 1),
      [],
      [...ATTRACTION_POI, show(31483), show(31513)],
    ).getLiveData();

    expect(live.filter((l) => l.status === 'CLOSED' && !l.queue)).toEqual([]);
  });

  it('closes shows once the attraction bill is back over half', async () => {
    const live = await stubbedPark(
      ATTRACTIONS.slice(0, 10),
      [],
      [...ATTRACTION_POI, show(31513)],
    ).getLiveData();

    expect(live.find((l) => l.id === '31513')).toEqual({id: '31513', status: 'CLOSED'});
  });

  // Winter closure: every show leaves the bill at once while paxLatencies keeps
  // listing the attractions as shut. That is a real closure, not a broken feed.
  it('closes every show across a seasonal shutdown', async () => {
    const shut = ATTRACTIONS.map((a) => latency(a.drupalId, false, null));
    const live = await stubbedPark(
      shut,
      [],
      [...ATTRACTION_POI, show(31483), show(31513)],
    ).getLiveData();

    expect(live.find((l) => l.id === '31483')).toEqual({id: '31483', status: 'CLOSED'});
    expect(live.find((l) => l.id === '31513')).toEqual({id: '31513', status: 'CLOSED'});
  });

  // The bill rolls at local midnight while a Halloween night still has an hour
  // to run, and a show physically mid-performance would otherwise be absent
  // from a bill for a day that has not started.
  it('closes nothing in the after-midnight tail of an event night', async () => {
    vi.setSystemTime(new Date('2026-10-17T23:30:00Z')); // 01:30 Europe/Paris
    const live = await stubbedPark(
      ATTRACTIONS,
      [],
      [...ATTRACTION_POI, show(31483), show(31513)],
    ).getLiveData();

    expect(live.filter((l) => l.status === 'CLOSED' && !l.queue)).toEqual([]);
  });

  it('resumes closing once the small hours are over', async () => {
    vi.setSystemTime(new Date('2026-10-18T04:30:00Z')); // 06:30 Europe/Paris
    const live = await stubbedPark(
      ATTRACTIONS,
      [],
      [...ATTRACTION_POI, show(31513)],
    ).getLiveData();

    expect(live.find((l) => l.id === '31513')).toEqual({id: '31513', status: 'CLOSED'});
  });

  // The live path never used to touch the offline package. Putting a 23MB ZIP
  // between the bill and the wait times must not cost the wait times.
  it('keeps publishing wait times when the offline package is unreachable', async () => {
    const park = new ParcAsterix();
    vi.spyOn(park as any, 'getPolling').mockResolvedValue({
      latencies: ATTRACTIONS,
      schedules: [performance('31483')],
    });
    vi.spyOn(park as any, 'getPOIData').mockRejectedValue(new Error('package 503'));
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    const live = await park.getLiveData();

    expect(live.find((l) => l.id === '31303')).toEqual({
      id: '31303',
      status: 'OPERATING',
      queue: {STANDBY: {waitTime: 10}},
    });
    expect(live.find((l) => l.id === '31483')).toMatchObject({status: 'OPERATING'});
    expect(live.filter((l) => l.status === 'CLOSED' && !l.queue)).toEqual([]);
  });

  // A show that is only in the bill and in no package database still publishes
  // its performances; the POI list only supplies the ids that can be closed.
  it('keeps a scheduled show that has no POI row', async () => {
    const live = await stubbedPark(
      ATTRACTIONS,
      [performance('31497')],
      [...ATTRACTION_POI, show(31513)],
    ).getLiveData();

    expect(live.find((l) => l.id === '31497')).toMatchObject({status: 'OPERATING'});
    expect(live.find((l) => l.id === '31513')).toEqual({id: '31513', status: 'CLOSED'});
  });
});

describe('Parc Asterix polling response', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    CacheLib.clearByClassName('ParcAsterix', {includePersistent: true});
  });

  const withResponse = (body: unknown) => {
    const park = new ParcAsterix();
    vi.spyOn(park as any, 'fetchPolling').mockResolvedValue({json: async () => body});
    return park;
  };

  it('throws rather than reading a GraphQL error as an empty park', async () => {
    await expect(
      withResponse({errors: [{message: 'Internal server error'}]})['getPolling'](),
    ).rejects.toThrow(/Internal server error/);
  });

  // The dangerous shape: structurally valid, a full attraction bill, and an
  // empty show bill only because the resolver failed. Every guard downstream
  // reads that as a park where every show is dark.
  it('throws on a partial failure that still carried data', async () => {
    await expect(
      withResponse({
        data: {paxLatencies: [{drupalId: '31303'}], paxSchedules: []},
        errors: [{message: 'schedules resolver timed out'}],
      })['getPolling'](),
    ).rejects.toThrow(/schedules resolver timed out/);
  });

  it('throws when either bill is missing, naming the one that is', async () => {
    await expect(
      withResponse({data: {paxLatencies: []}})['getPolling'](),
    ).rejects.toThrow(/paxSchedules/);
    await expect(
      withResponse({data: {paxSchedules: []}})['getPolling'](),
    ).rejects.toThrow(/paxLatencies/);
    await expect(withResponse({data: {}})['getPolling']()).rejects.toThrow(
      /paxLatencies or paxSchedules/,
    );
  });

  // What an upstream schema change actually delivers: present, truthy, wrong.
  it('throws when a bill is not an array', async () => {
    await expect(
      withResponse({data: {paxLatencies: {}, paxSchedules: []}})['getPolling'](),
    ).rejects.toThrow(/paxLatencies/);
  });

  it('accepts a legitimately empty bill', async () => {
    await expect(
      withResponse({data: {paxLatencies: [], paxSchedules: []}})['getPolling'](),
    ).resolves.toEqual({latencies: [], schedules: []});
  });

  it('accepts an empty errors array beside good data', async () => {
    await expect(
      withResponse({data: {paxLatencies: [], paxSchedules: []}, errors: []})['getPolling'](),
    ).resolves.toEqual({latencies: [], schedules: []});
  });
});
