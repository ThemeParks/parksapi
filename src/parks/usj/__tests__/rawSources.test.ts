import {describe, it, expect, vi, beforeEach, afterEach} from 'vitest';
import {UniversalStudiosJapan} from '../universalstudiosjapan.js';
import type {WithRaw} from '../../../destination.js';

/**
 * With `includeRaw` on, every live row carries the queue object or show row
 * it was built from, every entity carries its place row, and every schedule
 * entry carries the venue-hours row for that month. Off, nothing carries
 * anything.
 */
const NOW = new Date('2026-09-21T10:00:00Z');

const placeRide = {place_id: 'flying-dinosaur', name: 'Flying Dinosaur', place_type: {type: 'Ride'}, geometry: {locations: [{location_type: 'map', lat_lng: {lat: 34.665, lng: 135.433}}]}};
const placeShow = {place_id: 'water-world', name: 'Water World', place_type: {type: 'Show'}};
const placeDining = {place_id: 'finnegan\'s', name: 'Finnegan\'s Bar & Grill', place_type: {type: 'Dining'}};
const placeOther = {place_id: 'restroom-1', name: 'Restroom', place_type: {type: 'Restroom'}};

const standbyQueue = {queue_id: 'q1', queue_type: 'STANDBY', status: 'OPEN', display_wait_time: 40};
const entryDinosaur = {wait_time_attraction_id: 'flying-dinosaur', resort_area_code: 'USJ', land_id: 'jw', name: 'Flying Dinosaur', venue_id: '10251', show_externally: true, category: 'ride', queues: [standbyQueue]};
const entryHidden = {wait_time_attraction_id: 'hidden-ride', resort_area_code: 'USJ', land_id: 'jw', name: 'Hidden', venue_id: '10251', show_externally: false, category: 'ride', queues: [{queue_id: 'q2', queue_type: 'STANDBY', status: 'OPEN', display_wait_time: 10}]};

const showWaterWorld = {
  show_id: 'water-world', name: 'Water World', status: 'OPEN',
  show_times: [
    {show_time_id: 's1', status: 'ENABLED', start_time: '2026-09-21T11:00:00'},
    {show_time_id: 's2', status: 'CANCELLED', start_time: '2026-09-21T15:00:00'},
  ],
};

const hoursDay = {Date: '2026-09-30', OpenTimeString: '9:00 AM', CloseTimeString: '8:00 PM'};

function stubbedPark(includeRaw: boolean): UniversalStudiosJapan {
  const park = new UniversalStudiosJapan();
  park.includeRaw = includeRaw;
  vi.spyOn(park as any, 'getPlaces').mockResolvedValue([placeRide, placeShow, placeDining, placeOther]);
  vi.spyOn(park as any, 'getWaitTimeData').mockResolvedValue([entryDinosaur, entryHidden]);
  vi.spyOn(park as any, 'getShowListData').mockResolvedValue([showWaterWorld]);
  let call = 0;
  vi.spyOn(park as any, 'fetchVenueHoursForMonth').mockImplementation(async () => ({
    json: async () => (call++ === 0 ? [hoursDay] : []),
  }));
  return park;
}

const rawOf = (element: object) => (element as WithRaw<object>).raw;

describe('UniversalStudiosJapan raw upstream pieces', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('attaches the queue object to each ride row and the show row to each show row', async () => {
    const live = await stubbedPark(true).getLiveData();
    expect(live.map((l) => l.id)).toEqual(['flying-dinosaur', 'water-world']);

    expect(rawOf(live[0])).toEqual({waitTimes: standbyQueue});
    expect(rawOf(live[0])!.waitTimes).toBe(standbyQueue);
    expect(live[0].status).toBe('OPERATING');
    expect(live[0].queue).toEqual({STANDBY: {waitTime: 40}});

    expect(rawOf(live[1])).toEqual({showList: showWaterWorld});
    expect(rawOf(live[1])!.showList).toBe(showWaterWorld);
    expect(live[1].showtimes).toEqual([
      {type: 'PERFORMANCE_TIME', startTime: '2026-09-21T11:00:00+09:00', endTime: null},
    ]);
  });

  it('attaches the place row to each entity, nothing to the park', async () => {
    const entities = await stubbedPark(true).getEntities();
    expect(entities.map((e) => e.id)).toEqual(['universalstudiosjapan', 'usj.usj', 'flying-dinosaur', 'water-world', 'finnegan_s']);

    expect(rawOf(entities[0])).toBeUndefined();
    expect(rawOf(entities[1])).toBeUndefined();

    expect(rawOf(entities[2])).toEqual({places: placeRide});
    expect(rawOf(entities[2])!.places).toBe(placeRide);
    expect(entities[2].location).toEqual({latitude: 34.665, longitude: 135.433});

    expect(rawOf(entities[3])!.places).toBe(placeShow);
    expect(rawOf(entities[4])!.places).toBe(placeDining);
  });

  it('attaches the venue-hours row to the day it describes', async () => {
    const [schedule] = await stubbedPark(true).getSchedules();
    expect(schedule.schedule).toHaveLength(1);

    const [day] = schedule.schedule;
    expect(day.date).toBe('2026-09-30');
    expect(rawOf(day)).toEqual({venueHoursForMonth: hoursDay});
    expect(rawOf(day)!.venueHoursForMonth).toBe(hoursDay);
    expect(day.openingTime).toBe('9:00 AM');
    expect(day.closingTime).toBe('8:00 PM');
  });

  it('carries nothing when includeRaw is off', async () => {
    const park = stubbedPark(false);
    for (const element of await park.getLiveData()) expect(rawOf(element)).toBeUndefined();
    for (const element of await park.getEntities()) expect(rawOf(element)).toBeUndefined();
    for (const element of (await park.getSchedules())[0].schedule) expect(rawOf(element)).toBeUndefined();
  });
});
