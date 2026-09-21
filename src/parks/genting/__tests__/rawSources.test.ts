import {describe, it, expect, vi, beforeEach, afterEach} from 'vitest';
import {GentingSkyworlds} from '../gentingskyworlds.js';
import {CacheLib} from '../../../cache.js';
import type {WithRaw} from '../../../destination.js';

/**
 * With `includeRaw` on, every element carries the upstream pieces it was built
 * from: the catalogue entry for an entity and for every live row, the
 * wait-time row where the feed has one, the virtual-queue entry where it hands
 * out a return time, and the park's operation hour, which every status is
 * decided against. The 90-day schedule is synthesised from the published
 * default, so only today, which the live hours overlay, carries anything. Off,
 * nothing carries anything.
 */
const NOW = new Date('2026-09-21T06:00:00Z');

const ridePoi = {
  id: 'r1', categoryId: 'RIDE', title: 'Bumblebee Boogie Bots',
  latLng: [3.4222, 101.795], height: {min: 100}, mayGetWet: true,
};
const quietRidePoi = {id: 'r2', categoryId: 'RIDE', title: 'Robots Rumble'};
const showPoi = {
  id: 's1', categoryId: 'SHOW', title: 'Ice Age Live', operationStatus: {title: 'OPEN'},
};
const diningPoi = {id: 'd1', categoryId: 'DINING', title: 'Hidden Valley Diner'};

const all = {
  openingHour: {startTime: '2026-09-21T10:00:00+08:00', endTime: '2026-09-21T18:00:00+08:00'},
  rides: [ridePoi, quietRidePoi],
  shows: [showPoi],
  dining: [diningPoi],
};

const operationHour = {
  startTime: '2026-09-21T10:00:00+08:00',
  endTime: '2026-09-21T18:00:00+08:00',
  itineraryStartTime: '2026-09-21T10:00:00+08:00',
  itineraryEndTime: '2026-09-21T17:00:00+08:00',
};
const rideWait = {
  attractionId: 'r1', waitTime: 15, status: 'UP',
  vqReservation: true, fullVqReservation: false,
};
const waitTimes = {operationHour, rideWaitTimes: [rideWait]};

const vQueueEntry = {id: 'r1', title: 'Bumblebee Boogie Bots', fullVqReservation: false};

function stubbedPark(includeRaw: boolean): GentingSkyworlds {
  const park = new GentingSkyworlds();
  park.includeRaw = includeRaw;

  vi.spyOn(park as any, 'getAll').mockResolvedValue(all);
  vi.spyOn(park as any, 'getWaitTimes').mockResolvedValue(waitTimes);
  vi.spyOn(park as any, 'getDesireItinerary').mockResolvedValue([vQueueEntry]);

  return park;
}

const rawOf = (element: object) => (element as WithRaw<object>).raw;

describe('Genting SkyWorlds raw upstream pieces', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    CacheLib.clearByClassName('GentingSkyworlds', {includePersistent: true});
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('attaches every request that fed a live row', async () => {
    const live = await stubbedPark(true).getLiveData();
    expect(live.map((l) => l.id)).toEqual(['r1', 'r2', 's1']);

    // A ride with a wait row and a virtual queue carries all four pieces.
    expect(rawOf(live[0])).toEqual({
      all: ridePoi,
      waitTimesOperationHour: operationHour,
      waitTimes: rideWait,
      desireItinerary: vQueueEntry,
    });
    expect(rawOf(live[0])!.all).toBe(ridePoi);
    expect(rawOf(live[0])!.waitTimesOperationHour).toBe(operationHour);
    expect(rawOf(live[0])!.waitTimes).toBe(rideWait);
    expect(rawOf(live[0])!.desireItinerary).toBe(vQueueEntry);
    expect(live[0].status).toBe('OPERATING');
    expect(live[0].queue?.STANDBY).toEqual({waitTime: 15});
    expect(live[0].queue?.RETURN_TIME?.state).toBe('AVAILABLE');

    // A ride the wait feed does not mention keeps the catalogue entry and the
    // window its CLOSED was decided against.
    expect(rawOf(live[1])).toEqual({all: quietRidePoi, waitTimesOperationHour: operationHour});
    expect(live[1].status).toBe('CLOSED');

    // A show's status comes from the catalogue entry, gated by the same window.
    expect(rawOf(live[2])).toEqual({all: showPoi, waitTimesOperationHour: operationHour});
    expect(rawOf(live[2])!.all).toBe(showPoi);
    expect(live[2].status).toBe('OPERATING');
  });

  it('attaches the catalogue entry to each entity, nothing to park or destination', async () => {
    const entities = await stubbedPark(true).getEntities();
    expect(entities.map((e) => e.id)).toEqual([
      'gentingskyworldsresort', 'gentingskyworlds', 'r1', 'r2', 's1', 'd1',
    ]);

    // Destination and park are built from constants.
    expect(rawOf(entities[0])).toBeUndefined();
    expect(rawOf(entities[1])).toBeUndefined();

    expect(rawOf(entities[2])).toEqual({all: ridePoi});
    expect(rawOf(entities[2])!.all).toBe(ridePoi);
    expect(entities[2].name).toBe('Bumblebee Boogie Bots');

    expect(rawOf(entities[4])).toEqual({all: showPoi});
    expect(rawOf(entities[5])).toEqual({all: diningPoi});
    expect(rawOf(entities[5])!.all).toBe(diningPoi);
  });

  it('attaches the live hours to today and nothing to the synthesised days', async () => {
    const [schedule] = await stubbedPark(true).getSchedules();
    expect(schedule.id).toBe('gentingskyworlds');

    // Today, then the next open day: 2026-09-22 is one of the closed Tuesdays.
    const [today, next] = schedule.schedule;
    expect(today.date).toBe('2026-09-21');
    expect(rawOf(today)).toEqual({waitTimesOperationHour: operationHour});
    expect(rawOf(today)!.waitTimesOperationHour).toBe(operationHour);
    expect(today.openingTime).toBe('2026-09-21T10:00:00+08:00');
    expect(today.closingTime).toBe('2026-09-21T18:00:00+08:00');

    expect(next.date).toBe('2026-09-23');
    expect(rawOf(next)).toBeUndefined();
    expect(next.openingTime).toBe('2026-09-23T10:00:00+08:00');
  });

  it('carries nothing when includeRaw is off', async () => {
    const park = stubbedPark(false);
    for (const element of await park.getLiveData()) expect(rawOf(element)).toBeUndefined();
    for (const element of await park.getEntities()) expect(rawOf(element)).toBeUndefined();
    for (const entity of await park.getSchedules()) {
      for (const element of entity.schedule) expect(rawOf(element)).toBeUndefined();
    }
  });
});
