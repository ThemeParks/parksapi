import {describe, test, expect, beforeEach, afterEach} from 'vitest';
import {WalibiHolland} from '../walibi.js';
import {CacheLib} from '../../../cache.js';
import {findDuplicateEntityIds} from '../../../duplicateCheck.js';
import type {HTTPObj} from '../../../http.js';

/**
 * Walibi Holland's two Walibi Express stations stand 150m apart, share one
 * queue board, and the CMS gives both rows the same `waitingTimeName`. Keying
 * attractions on that field emitted two entities under one id, and one of them
 * was silently discarded downstream: Station 2 has never existed on the wiki.
 *
 * The feed lists Station 2 first, which is why the fix names the loser rather
 * than picking by order. First-wins would hand the shared id to Station 2 and
 * rename Station 1, orphaning the record that holds it today.
 *
 * Fixtures are the real rows, paths and coordinates included.
 */
const SHARED_ID = '460e803c-6f87-442c-86b6-3cd80280beaf';

const STATION_2 = {
  title: 'Walibi Express Station 2',
  waitingTimeName: SHARED_ID,
  path: '/content/dam/who/en/attractions/walibi-express-station-2',
  latitude: 52.441642,
  longitude: 5.765361,
};

const STATION_1 = {
  title: 'Walibi Express Station 1',
  waitingTimeName: SHARED_ID,
  path: '/content/dam/who/en/attractions/walibi-express-station-1',
  latitude: 52.440204,
  longitude: 5.766208,
};

/** A ride with an id of its own, to prove the fix is narrow. */
const UNTAMED = {
  title: 'Untamed',
  waitingTimeName: 'c0ffee00-0000-4000-8000-000000000001',
  path: '/content/dam/who/en/attractions/untamed',
  latitude: 52.4402,
  longitude: 5.7661,
};

function stubbedPark(attractions: any[], waitTimes: any[] = []): WalibiHolland {
  const park = new WalibiHolland();
  park.fetchAttractions = (async () => ({json: async () => attractions} as any as HTTPObj)) as any;
  park.getRestaurants = async () => [];
  park.getWaitTimes = async () => waitTimes;
  return park;
}

describe('WalibiHolland — Walibi Express stations sharing one wait-time id', () => {
  beforeEach(() => CacheLib.clear());
  afterEach(() => CacheLib.clear());

  test('publishes both stations', async () => {
    const entities = await stubbedPark([STATION_2, STATION_1, UNTAMED]).getEntities();

    const names = entities.filter(e => e.entityType === 'ATTRACTION').map(e => e.name);
    expect(names).toContain('Walibi Express Station 1');
    expect(names).toContain('Walibi Express Station 2');
  });

  test('emits no duplicate ids', async () => {
    const entities = await stubbedPark([STATION_2, STATION_1, UNTAMED]).getEntities();

    expect(findDuplicateEntityIds(entities)).toEqual([]);
  });

  test('leaves the shared id with Station 1, which holds it on the wiki', async () => {
    // The whole point of naming the loser explicitly. If this flips, the live
    // record is orphaned and a new one minted in its place.
    const entities = await stubbedPark([STATION_2, STATION_1, UNTAMED]).getEntities();

    expect(entities.find(e => e.id === SHARED_ID)?.name).toBe('Walibi Express Station 1');
  });

  test('keys Station 2 on its CMS path', async () => {
    const entities = await stubbedPark([STATION_2, STATION_1, UNTAMED]).getEntities();

    const station2 = entities.find(e => e.name === 'Walibi Express Station 2');
    expect(station2?.id).toBe('attr_walibi-express-station-2');
    expect(station2?.location).toEqual({latitude: 52.441642, longitude: 5.765361});
  });

  test('holds the order-independence: Station 1 keeps the id whichever way the feed lists them', async () => {
    // A first-wins or last-wins rule passes one of these two and fails the
    // other. Naming the loser passes both.
    for (const order of [[STATION_2, STATION_1], [STATION_1, STATION_2]]) {
      const entities = await stubbedPark([...order, UNTAMED]).getEntities();
      expect(entities.find(e => e.id === SHARED_ID)?.name).toBe('Walibi Express Station 1');
      expect(findDuplicateEntityIds(entities)).toEqual([]);
      CacheLib.clear();
    }
  });

  test('leaves a ride with an unshared wait-time id keyed on it', async () => {
    const entities = await stubbedPark([STATION_2, STATION_1, UNTAMED]).getEntities();

    expect(entities.find(e => e.name === 'Untamed')?.id)
      .toBe('c0ffee00-0000-4000-8000-000000000001');
  });

  test('gives the shared queue board wait to Station 1', async () => {
    // One wait row for the shared id, and it stays with the entity that keeps
    // that id. Station 2 publishes without live data, like any path-keyed ride.
    const live = await stubbedPark(
      [STATION_2, STATION_1, UNTAMED],
      [{id: SHARED_ID, time: 600, status: 'open'}],
    ).getLiveData();

    expect(live.map(l => l.id)).toEqual([SHARED_ID]);
    expect(live[0]).toMatchObject({status: 'OPERATING', queue: {STANDBY: {waitTime: 10}}});
  });
});
