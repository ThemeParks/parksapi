import {describe, it, expect, vi, beforeEach} from 'vitest';
import {DisneylandParis} from '../disneylandparis.js';
import {CacheLib} from '../../../cache.js';

/**
 * Single-rider capability comes from the POI `singleRider` facet, OR'd with
 * wait-feed sightings from the last 48h. The facet keeps a ride's queue
 * present overnight; the sighting bridges the POI cache lagging a fresh
 * addition, and lapses so a retired queue disappears.
 */
function stubbedPark(
  attractions: Array<Record<string, unknown>>,
  waitTimes: unknown[] = [],
): DisneylandParis {
  const park = new DisneylandParis();

  vi.spyOn(park as any, 'getPOIData').mockResolvedValue({
    ThemePark: [{id: 'P1', name: 'Disneyland Park', type: 'ThemePark'}],
    Attraction: attractions.map((a) => ({
      type: 'Attraction',
      location: {id: 'P1'},
      ...a,
    })),
  });
  vi.spyOn(park as any, 'getWaitTimes').mockResolvedValue(waitTimes);
  vi.spyOn(park as any, 'getPremierAccess').mockResolvedValue([]);
  vi.spyOn(park as any, 'getVirtualQueueData').mockResolvedValue([]);
  vi.spyOn(park as any, 'getScheduleForDate').mockResolvedValue([]);

  return park;
}

const RIDE = {id: 'P1RA00', name: 'Big Thunder Mountain'};

/** A wait-feed row, which is what marks a ride as queue-bearing. */
const feedRow = (over: Record<string, unknown> = {}) => ({
  entityId: 'P1RA00',
  type: 'Attraction',
  status: 'OPERATING',
  postedWaitMinutes: 30,
  ...over,
});

async function queueOf(park: DisneylandParis): Promise<any> {
  const live = await park.getLiveData();
  const row = live.find((l) => l.id === 'P1RA00');
  expect(row).toBeDefined();
  return (row as any)?.queue;
}

describe('DLP single rider', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    CacheLib.clearByClassName('DisneylandParis');
  });

  it('emits the queue from the POI facet while the feed is asleep', async () => {
    // The ride is known to be queue-bearing from an earlier live feed, but
    // right now the feed returns nothing at all.
    await stubbedPark([{...RIDE, singleRider: true}], [feedRow()]).getLiveData();

    const queue = await queueOf(stubbedPark([{...RIDE, singleRider: true}]));
    expect(queue.SINGLE_RIDER).toEqual({waitTime: null});
  });

  it('emits no queue for a ride the facet does not flag', async () => {
    await stubbedPark([RIDE], [feedRow()]).getLiveData();

    const queue = await queueOf(stubbedPark([RIDE]));
    expect(queue.SINGLE_RIDER).toBeUndefined();
  });

  it('lets the live feed set the wait time', async () => {
    const queue = await queueOf(stubbedPark(
      [{...RIDE, singleRider: true}],
      [feedRow({singleRider: {isAvailable: true, singleRiderWaitMinutes: 15}})],
    ));
    expect(queue.SINGLE_RIDER).toEqual({waitTime: 15});
  });

  it('nulls the wait time when the ride is closed', async () => {
    const queue = await queueOf(stubbedPark(
      [{...RIDE, singleRider: true}],
      [feedRow({status: 'CLOSED', singleRider: {isAvailable: true, singleRiderWaitMinutes: 15}})],
    ));
    expect(queue.SINGLE_RIDER).toEqual({waitTime: null});
  });

  it('keeps the queue when the live feed reports the flag false', async () => {
    const queue = await queueOf(stubbedPark(
      [{...RIDE, singleRider: true}],
      [feedRow({singleRider: {isAvailable: false}})],
    ));
    expect(queue.SINGLE_RIDER).toEqual({waitTime: null});
  });

  it('bridges a fresh addition the POI cache does not carry yet', async () => {
    // The feed advertised single rider this morning; the facet lags behind.
    await stubbedPark(
      [RIDE],
      [feedRow({singleRider: {isAvailable: true, singleRiderWaitMinutes: 10}})],
    ).getLiveData();

    const queue = await queueOf(stubbedPark([RIDE]));
    expect(queue.SINGLE_RIDER).toEqual({waitTime: null});
  });

  it('lets a retired single-rider queue disappear once the sighting lapses', async () => {
    vi.useFakeTimers();
    try {
      await stubbedPark(
        [{...RIDE, singleRider: true}],
        [feedRow({singleRider: {isAvailable: true, singleRiderWaitMinutes: 10}})],
      ).getLiveData();

      // Two days on: no facet, feed asleep, last sighting lapsed.
      vi.setSystemTime(Date.now() + 49 * 60 * 60 * 1000);
      const queue = await queueOf(stubbedPark([RIDE]));
      expect(queue.SINGLE_RIDER).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    ['a string', 'true'],
    ['a number', 1],
    ['null', null],
    ['absent', undefined],
  ])('emits no queue when the facet is %s', async (_label, singleRider) => {
    await stubbedPark([{...RIDE, singleRider}], [feedRow()]).getLiveData();

    const queue = await queueOf(stubbedPark([{...RIDE, singleRider}]));
    expect(queue.SINGLE_RIDER).toBeUndefined();
  });
});
