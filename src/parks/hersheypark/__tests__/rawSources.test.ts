import {describe, it, expect, vi, afterEach} from 'vitest';
import {Hersheypark} from '../hersheypark.js';
import type {WithRaw} from '../../../destination.js';

/**
 * With `includeRaw` on, every element carries the upstream piece it was
 * built from: the explore entry for the park and the status entry for a
 * live row, the ride entry for a ride entity, and the opening-hours string
 * for a schedule day. Off, nothing carries anything.
 */
const parkExplore = {id: 'P1', isHersheyPark: true, name: 'Hersheypark', latitude: '40.2870', longitude: '-76.6536'};
const stadiumExplore = {id: 'P2', isHersheyPark: false, name: 'Hersheypark Stadium'};

const skyrush = {id: 101, name: 'Skyrush', latitude: '40.2860', longitude: '-76.6530'};
const sidewinder = {id: 102, name: 'Sidewinder', latitude: null, longitude: null};

const poi = {
  explore: [parkExplore, stadiumExplore],
  rides: [skyrush, sidewinder],
  exploreHours: {
    '2026-09-21': {P1: '10:00 AM - 10:00 PM'},
    '2026-09-22': {P1: '10:00 AM - 8:00 PM'},
  },
};

const skyrushStatus = {id: 101, type: 'rides', status: '1', wait: 25};
const sidewinderStatus = {id: 102, type: 'rides', status: '2', wait: null};
const restaurantStatus = {id: 999, type: 'restaurant', status: '1'};

function stubbedPark(includeRaw: boolean): Hersheypark {
  const park = new Hersheypark();
  park.includeRaw = includeRaw;
  vi.spyOn(park as any, 'getPOI').mockResolvedValue(poi);
  vi.spyOn(park as any, 'getStatus').mockResolvedValue([skyrushStatus, sidewinderStatus, restaurantStatus]);
  return park;
}

const rawOf = (element: object) => (element as WithRaw<object>).raw;

describe('Hersheypark raw upstream pieces', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('attaches the status entry to each live row', async () => {
    const live = await stubbedPark(true).getLiveData();
    expect(live.map((l) => l.id)).toEqual(['rides_101', 'rides_102']);

    expect(rawOf(live[0])).toEqual({status: skyrushStatus});
    expect(rawOf(live[0])!.status).toBe(skyrushStatus);
    expect(live[0].queue).toEqual({STANDBY: {waitTime: 25}});

    expect(live[1]).toMatchObject({status: 'DOWN'});
    expect(rawOf(live[1])!.status).toBe(sidewinderStatus);
  });

  it('attaches the explore entry to the park and the ride entry to each ride', async () => {
    const entities = await stubbedPark(true).getEntities();
    expect(entities.map((e) => e.id)).toEqual(['hersheypark', 'hersheyparkthemepark', 'rides_101', 'rides_102']);

    expect(rawOf(entities[0])).toBeUndefined();

    expect(rawOf(entities[1])).toEqual({poi: parkExplore});
    expect(rawOf(entities[1])!.poi).toBe(parkExplore);
    expect(entities[1].location).toEqual({latitude: 40.287, longitude: -76.6536});

    expect(rawOf(entities[2])).toEqual({poi: skyrush});
    expect(rawOf(entities[2])!.poi).toBe(skyrush);
    expect(entities[2].location).toEqual({latitude: 40.286, longitude: -76.653});

    expect(rawOf(entities[3])).toEqual({poi: sidewinder});
    expect(entities[3].location).toBeUndefined();
  });

  it('attaches the opening-hours string to each schedule day', async () => {
    const [schedule] = await stubbedPark(true).getSchedules();
    expect(schedule.schedule!.map((e) => e.date)).toEqual(['2026-09-21', '2026-09-22']);

    const [day1, day2] = schedule.schedule!;
    expect(rawOf(day1)).toEqual({poi: '10:00 AM - 10:00 PM'});
    expect(day1.closingTime).toBe('2026-09-21T22:00:00-04:00');

    expect(rawOf(day2)).toEqual({poi: '10:00 AM - 8:00 PM'});
    expect(day2.closingTime).toBe('2026-09-22T20:00:00-04:00');
  });

  it('carries nothing when includeRaw is off', async () => {
    const park = stubbedPark(false);
    for (const element of await park.getLiveData()) expect(rawOf(element)).toBeUndefined();
    for (const element of await park.getEntities()) expect(rawOf(element)).toBeUndefined();
    for (const element of (await park.getSchedules())[0].schedule!) expect(rawOf(element)).toBeUndefined();
  });
});
