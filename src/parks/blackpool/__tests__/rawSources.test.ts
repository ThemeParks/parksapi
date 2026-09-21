import {describe, it, expect, vi, afterEach} from 'vitest';
import {BlackpoolPleasureBeach} from '../blackpoolpleasurebeach.js';
import type {WithRaw} from '../../../destination.js';

/**
 * With `includeRaw` on, every element carries the upstream piece it was
 * built from: the queue-times row for live data and for an attraction
 * entity, the marker for a restaurant entity (and for an attraction that has
 * one), and the opening-times day for a schedule entry. Off, nothing carries
 * anything.
 */
const rideRow = {id: 101, rideId: 101, ride: 'Icon', active: true, holding: false, closed: false, enabled: true, queueTime: 45};
const closedRow = {id: 102, rideId: 102, ride: 'Big One', active: false, holding: false, closed: true, enabled: true, queueTime: 0};
const disabledRow = {id: 103, rideId: 103, ride: 'Ice Blast', active: false, holding: false, closed: false, enabled: false, queueTime: 0};

const rideMarker = {id: 1, type: 'ride', title: 'Icon', lat: '53.7930', lon: '-3.0550', linkable_type: 'App\\Rides', linkable_id: 101};
const disabledRideMarker = {id: 2, type: 'ride', title: 'Ice Blast', lat: '53.7940', lon: '-3.0560', linkable_type: 'App\\Rides', linkable_id: 103};
const restaurantMarker = {id: 201, type: 'catering', title: 'Burger Kitchen', lat: '53.7935', lon: '-3.0555', linkable_type: 'App\\CateringUnit', linkable_id: null};

const today = {open_date: '2026-09-21', time_from: '10:00am', time_to: '6:00pm'};
const tomorrow = {open_date: '2026-09-22', time_from: '10:00am', time_to: '9:00pm'};

function stubbedPark(includeRaw: boolean): BlackpoolPleasureBeach {
  const park = new BlackpoolPleasureBeach();
  park.includeRaw = includeRaw;
  vi.spyOn(park as any, 'getQueueTimes').mockResolvedValue([rideRow, closedRow, disabledRow]);
  vi.spyOn(park as any, 'getMarkers').mockResolvedValue([rideMarker, disabledRideMarker, restaurantMarker]);
  vi.spyOn(park as any, 'getCalendar').mockResolvedValue([today, tomorrow]);
  return park;
}

const rawOf = (element: object) => (element as WithRaw<object>).raw;

describe('BlackpoolPleasureBeach raw upstream pieces', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('attaches the queue-times row to each live row', async () => {
    const live = await stubbedPark(true).getLiveData();
    expect(live.map((l) => l.id)).toEqual(['101', '102', '103']);

    expect(rawOf(live[0])).toEqual({queueTimes: rideRow});
    expect(rawOf(live[0])!.queueTimes).toBe(rideRow);
    expect(live[0].queue).toEqual({STANDBY: {waitTime: 45}});

    expect(live[1]).toMatchObject({status: 'CLOSED'});
    expect(rawOf(live[1])!.queueTimes).toBe(closedRow);

    expect(live[2]).toMatchObject({status: 'CLOSED'});
    expect(rawOf(live[2])!.queueTimes).toBe(disabledRow);
  });

  it('attaches the queue-times row and marker to an attraction, only the marker to a restaurant, nothing to the park', async () => {
    const entities = await stubbedPark(true).getEntities();
    expect(entities.map((e) => e.id)).toEqual([
      'blackpoolpleasurebeach',
      'blackpoolpleasurebeach-park',
      '101',
      '102',
      '103',
      'restaurant-201',
    ]);

    expect(rawOf(entities[0])).toBeUndefined();
    expect(rawOf(entities[1])).toBeUndefined();

    expect(rawOf(entities[2])).toEqual({queueTimes: rideRow, markers: rideMarker});
    expect(rawOf(entities[2])!.markers).toBe(rideMarker);
    expect(entities[2].location).toEqual({latitude: 53.793, longitude: -3.055});

    expect(rawOf(entities[3])).toEqual({queueTimes: closedRow});

    expect(rawOf(entities[4])).toEqual({queueTimes: disabledRow, markers: disabledRideMarker});

    expect(rawOf(entities[5])).toEqual({markers: restaurantMarker});
    expect(rawOf(entities[5])!.markers).toBe(restaurantMarker);
  });

  it('attaches the opening-times day to each schedule entry', async () => {
    const [schedule] = await stubbedPark(true).getSchedules();
    expect(schedule.schedule!.map((e) => e.date)).toEqual(['2026-09-21', '2026-09-22']);

    const [day1, day2] = schedule.schedule!;
    expect(rawOf(day1)).toEqual({openingTimesHtml: today});
    expect(rawOf(day1)!.openingTimesHtml).toBe(today);
    expect(day1.closingTime).toBe('2026-09-21T18:00:00+01:00');

    expect(rawOf(day2)).toEqual({openingTimesHtml: tomorrow});
    expect(rawOf(day2)!.openingTimesHtml).toBe(tomorrow);
    expect(day2.closingTime).toBe('2026-09-22T21:00:00+01:00');
  });

  it('carries nothing when includeRaw is off', async () => {
    const park = stubbedPark(false);
    for (const element of await park.getLiveData()) expect(rawOf(element)).toBeUndefined();
    for (const element of await park.getEntities()) expect(rawOf(element)).toBeUndefined();
    for (const element of (await park.getSchedules())[0].schedule!) expect(rawOf(element)).toBeUndefined();
  });
});
