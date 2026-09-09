import {describe, it, expect, vi, beforeEach} from 'vitest';
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

const ATTRACTIONS = Array.from({length: 20}, (_, i) => latency(String(31303 + i)));

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
  });

  it('closes a show that is not on today’s bill', async () => {
    const live = await stubbedPark(
      ATTRACTIONS,
      [performance('31483')],
      [show(31483), show(31513)],
    ).getLiveData();

    expect(live.find((l) => l.id === '31483')).toMatchObject({status: 'OPERATING'});
    expect(live.find((l) => l.id === '31513')).toEqual({id: '31513', status: 'CLOSED'});
  });

  it('publishes no showtimes on the closed row, rather than the last ones it saw', async () => {
    const park = stubbedPark(ATTRACTIONS, [performance('31513')], [show(31513)]);
    const performing = await park.getLiveData();
    expect(performing.find((l) => l.id === '31513')?.showtimes).toHaveLength(1);

    const dark = await stubbedPark(ATTRACTIONS, [], [show(31513)]).getLiveData();
    expect(dark.find((l) => l.id === '31513')?.showtimes).toBeUndefined();
  });

  it('closes a show whose run ended before this gate ever saw it perform', async () => {
    // The retirement gate can only close ids it has watched go absent, so a
    // show that stopped performing before the code shipped is invisible to it.
    // Reading the bill directly needs no such history.
    const live = await stubbedPark(ATTRACTIONS, [], [show(31509), show(31513)]).getLiveData();

    expect(live.find((l) => l.id === '31509')).toEqual({id: '31509', status: 'CLOSED'});
    expect(live.find((l) => l.id === '31513')).toEqual({id: '31513', status: 'CLOSED'});
  });

  it('reopens the show the day it is back on the bill', async () => {
    await stubbedPark(ATTRACTIONS, [], [show(31513)]).getLiveData();
    const live = await stubbedPark(
      ATTRACTIONS,
      [performance('31513')],
      [show(31513)],
    ).getLiveData();

    expect(live.find((l) => l.id === '31513')).toMatchObject({status: 'OPERATING'});
  });

  // A gutted GraphQL response parses cleanly into empty arrays. Reading that as
  // "every show is dark" would publish a confident CLOSED across a park that is
  // open, so the attraction bill has to corroborate that the feed is alive.
  it('says nothing when the whole polling feed comes back empty', async () => {
    const live = await stubbedPark([], [], [show(31483), show(31513)]).getLiveData();

    expect(live).toHaveLength(0);
  });

  // Winter closure: every show leaves the bill at once while paxLatencies keeps
  // listing the attractions as shut. That is a real closure, not a broken feed.
  it('closes every show across a seasonal shutdown', async () => {
    const shut = ATTRACTIONS.map((a) => latency(a.drupalId, false, null));
    const live = await stubbedPark(shut, [], [show(31483), show(31513)]).getLiveData();

    expect(live.find((l) => l.id === '31483')).toEqual({id: '31483', status: 'CLOSED'});
    expect(live.find((l) => l.id === '31513')).toEqual({id: '31513', status: 'CLOSED'});
  });

  // 31497 returned live showtimes for a spell while no package database carried
  // a POI row for it. The bill is the authority on what is performing; the POI
  // list only supplies the ids that can be closed.
  it('keeps a scheduled show that has no POI row', async () => {
    const live = await stubbedPark(ATTRACTIONS, [performance('31497')], []).getLiveData();

    expect(live.find((l) => l.id === '31497')).toMatchObject({status: 'OPERATING'});
  });

  it('emits one row per show, never a live row and a closed one', async () => {
    const live = await stubbedPark(
      ATTRACTIONS,
      [performance('31483')],
      [show(31483), show(31513)],
    ).getLiveData();

    const ids = live.map((l) => l.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('Parc Asterix polling response', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    CacheLib.clearByClassName('ParcAsterix', {includePersistent: true});
  });

  const withResponse = (body: unknown) => {
    const park = new ParcAsterix();
    vi.spyOn(park as any, 'fetchPolling').mockResolvedValue({
      json: async () => body,
    });
    return park;
  };

  it('throws rather than reading a GraphQL error as an empty park', async () => {
    await expect(
      withResponse({errors: [{message: 'Internal server error'}]})['getPolling'](),
    ).rejects.toThrow(/Internal server error/);
  });

  it('throws when the payload is missing either bill', async () => {
    await expect(
      withResponse({data: {paxLatencies: []}})['getPolling'](),
    ).rejects.toThrow(/paxSchedules/);
  });

  it('accepts a legitimately empty bill', async () => {
    await expect(
      withResponse({data: {paxLatencies: [], paxSchedules: []}})['getPolling'](),
    ).resolves.toEqual({latencies: [], schedules: []});
  });
});
