import {describe, it, expect, vi, beforeEach, afterEach} from 'vitest';
import {PaultonsPark} from '../paultonspark.js';
import type {WithRaw} from '../../../destination.js';

/**
 * With `includeRaw` on, every entity carries the points-of-interest row it
 * was built from, every live row carries its queue-times row, and every
 * schedule entry carries the opening-hours window it came from. Off,
 * nothing carries anything.
 */
const NOW = new Date('2026-09-21T10:00:00Z');

const poiRide = {id: 101, title: 'Cobra\'s Curse', type: 'ride', orms_id: 5001, entrance_location: {type: 'Point', coordinates: [-1.5523, 50.9482]}};
const poiShow = {id: 102, title: 'Sea Lion Show', type: 'show', orms_id: 5002};
const poiRestaurant = {id: 103, title: 'Lakeside Diner', type: 'restaurant', orms_id: 5003};

const queueRide = {rideId: 5001, statusOpen: true, queueTime: 20};
const queueShow = {rideId: 5002, statusOpen: false, queueTime: null};
const queueUnmapped = {rideId: 9999, statusOpen: true, queueTime: 5};

const windowToday = {start: '2026-09-21T08:00:00.000Z', end: '2026-09-21T17:00:00.000Z'};
const windowTomorrow = {start: '2026-09-22T08:00:00.000Z', end: '2026-09-22T17:00:00.000Z'};

function stubbedPark(includeRaw: boolean): PaultonsPark {
  const park = new PaultonsPark();
  park.includeRaw = includeRaw;
  vi.spyOn(park as any, 'getPOIData').mockResolvedValue([poiRide, poiShow, poiRestaurant]);
  vi.spyOn(park as any, 'getQueueTimes').mockResolvedValue([queueRide, queueShow, queueUnmapped]);
  vi.spyOn(park as any, 'fetchOpeningHours').mockResolvedValue({
    json: async () => ({open: {park: [windowToday, windowTomorrow]}}),
  });
  return park;
}

const rawOf = (element: object) => (element as WithRaw<object>).raw;

describe('PaultonsPark raw upstream pieces', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('attaches the queue-times row to each live row, drops unmapped rides', async () => {
    const live = await stubbedPark(true).getLiveData();
    expect(live.map((l) => l.id)).toEqual(['101', '102']);

    expect(rawOf(live[0])).toEqual({liveData: queueRide});
    expect(rawOf(live[0])!.liveData).toBe(queueRide);
    expect(live[0].queue).toEqual({STANDBY: {waitTime: 20}});

    expect(rawOf(live[1])).toEqual({liveData: queueShow});
    expect(live[1].status).toBe('CLOSED');
    expect(live[1].queue).toBeUndefined();
  });

  it('attaches the POI row to each entity, nothing to the park', async () => {
    const entities = await stubbedPark(true).getEntities();
    expect(entities.map((e) => e.id)).toEqual(['paultonsparkresort', 'paultonspark', '101', '102', '103']);

    expect(rawOf(entities[0])).toBeUndefined();
    expect(rawOf(entities[1])).toBeUndefined();

    expect(rawOf(entities[2])).toEqual({poiData: poiRide});
    expect(rawOf(entities[2])!.poiData).toBe(poiRide);
    expect(entities[2].name).toBe('Cobra\'s Curse');

    expect(rawOf(entities[3])!.poiData).toBe(poiShow);
    expect(rawOf(entities[4])!.poiData).toBe(poiRestaurant);
  });

  it('attaches the opening-hours window to each schedule entry', async () => {
    const [schedule] = await stubbedPark(true).getSchedules();
    expect(schedule.schedule.map((e) => e.date)).toEqual(['2026-09-21', '2026-09-22']);

    const [today, tomorrow] = schedule.schedule;
    expect(rawOf(today)).toEqual({openingHours: windowToday});
    expect(rawOf(today)!.openingHours).toBe(windowToday);
    expect(today.openingTime).toBe('2026-09-21T09:00:00+01:00');
    expect(today.closingTime).toBe('2026-09-21T18:00:00+01:00');

    expect(rawOf(tomorrow)!.openingHours).toBe(windowTomorrow);
  });

  it('carries nothing when includeRaw is off', async () => {
    const park = stubbedPark(false);
    for (const element of await park.getLiveData()) expect(rawOf(element)).toBeUndefined();
    for (const element of await park.getEntities()) expect(rawOf(element)).toBeUndefined();
    for (const element of (await park.getSchedules())[0].schedule) expect(rawOf(element)).toBeUndefined();
  });
});
