import {describe, it, expect, vi, beforeEach, afterEach} from 'vitest';
import {SeaworldSanDiego} from '../seaworld.js';
import type {WithRaw} from '../../../destination.js';

/**
 * With `includeRaw` on, a ride row carries its wait-time row and the park's
 * published hours, which decide how a reading is read, a show row its
 * show-times row and the same hours, and a ride marked for refurbishment from
 * its name carries nothing, because no response mentioned it. Entities carry
 * the park document or their own POI entry, a schedule day the hours blocks of
 * that day, as a list where a day has more than one. Off, nothing carries
 * anything.
 */
const NOW = new Date('2026-08-15T21:00:00Z');
const PARK_ID = '4325312F-FDF1-41FF-ABF4-361A4FF03443';
/** US Eastern wall time, three minutes before the pinned clock. */
const FRESH_STAMP = '2026-08-15T16:57:00';

const ridePoi = {Id: 'ride-001', Name: 'Manta', Type: 'Rides', Coordinate: {Latitude: 32.764, Longitude: -117.226}};
const refurbPoi = {Id: 'ride-002', Name: 'Journey To Atlantis (Closed)', Type: 'Rides'};
const showPoi = {Id: 'show-001', Name: 'Dolphin Adventures', Type: 'Shows'};
const diningPoi = {Id: 'dining-001', Name: 'Shipwreck Reef Cafe', Type: 'Dining'};

const daytimeBlock = {opens_at: '2026-08-15T09:00:00.0000000Z', closes_at: '2026-08-15T21:00:00.0000000Z', date: '08/15/2026'};
const eveningBlock = {opens_at: '2026-08-15T21:00:00.0000000Z', closes_at: '2026-08-15T23:00:00.0000000Z', date: '08/15/2026'};
const nextDayBlock = {opens_at: '2026-08-16T10:00:00.0000000Z', closes_at: '2026-08-16T18:00:00.0000000Z', date: '08/16/2026'};

const parkDetail = {
  Id: PARK_ID,
  park_Name: 'SeaWorld San Diego',
  TimeZone: 'America/Los_Angeles',
  map_center: {Latitude: 32.7645, Longitude: -117.2265},
  POIs: {Rides: [ridePoi, refurbPoi], Shows: [showPoi], Dining: [diningPoi]},
  open_hours: [daytimeBlock, eveningBlock, nextDayBlock],
};

const waitRow = {Id: 'ride-001', Minutes: 30, Status: '', StatusDisplay: '', Title: 'Manta', LastUpDateTime: FRESH_STAMP};
const showRow = {
  Id: 'show-001',
  ShowTimes: [{
    StartDateTime: '2026-08-15T22:00:00Z',
    EndDateTime: '2026-08-15T22:30:00Z',
    StartTime: '2026-08-15T15:00:00',
    EndTime: '2026-08-15T15:30:00',
  }],
};
const availability = {WaitTimes: [waitRow], ShowTimes: [showRow]};

function stubbedPark(includeRaw: boolean): SeaworldSanDiego {
  const park = new SeaworldSanDiego();
  park.includeRaw = includeRaw;
  vi.spyOn(park as any, 'getParkDetail').mockResolvedValue(parkDetail);
  vi.spyOn(park as any, 'getAvailability').mockResolvedValue(availability);
  return park;
}

const rawOf = (element: object) => (element as WithRaw<object>).raw;

describe('SeaWorld raw upstream pieces', () => {
  beforeEach(() => {
    vi.useFakeTimers({toFake: ['Date']});
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('attaches the availability row and the hours to a live row, nothing to a refurbishment', async () => {
    const live = await stubbedPark(true).getLiveData();
    expect(live.map((l) => l.id)).toEqual(['ride-001', 'show-001', 'ride-002']);

    expect(rawOf(live[0])).toEqual({availabilityWaitTimes: waitRow, parkDetail: parkDetail.open_hours});
    expect(rawOf(live[0])!.availabilityWaitTimes).toBe(waitRow);
    expect(rawOf(live[0])!.parkDetail).toBe(parkDetail.open_hours);
    expect(live[0].queue).toEqual({STANDBY: {waitTime: 30}});

    expect(rawOf(live[1])).toEqual({availabilityShowTimes: showRow, parkDetail: parkDetail.open_hours});
    expect(rawOf(live[1])!.availabilityShowTimes).toBe(showRow);
    expect(live[1].showtimes?.[0].startTime).toBe('2026-08-15T15:00:00-07:00');

    // Refurbishment read off the entity name: no response mentioned this ride.
    expect(live[2].status).toBe('REFURBISHMENT');
    expect(rawOf(live[2])).toBeUndefined();
  });

  it('attaches the POI entry to each child, nothing to the destination or the park', async () => {
    const entities = await stubbedPark(true).getEntities();
    expect(entities.map((e) => e.id)).toEqual([
      'seaworldsandiego', PARK_ID, 'ride-001', 'ride-002', 'show-001', 'dining-001',
    ]);

    expect(rawOf(entities[0])).toBeUndefined();
    expect(rawOf(entities[1])).toBeUndefined();
    expect(entities[1].name).toBe('SeaWorld San Diego');

    expect(rawOf(entities[2])).toEqual({parkDetail: ridePoi});
    expect(rawOf(entities[2])!.parkDetail).toBe(ridePoi);
    expect(rawOf(entities[4])!.parkDetail).toBe(showPoi);
    expect(rawOf(entities[5])!.parkDetail).toBe(diningPoi);
  });

  it('attaches the hours blocks of a day to every entry of that day', async () => {
    const [schedule] = await stubbedPark(true).getSchedules();
    expect(schedule.id).toBe(PARK_ID);
    expect(schedule.schedule.map((e) => e.date)).toEqual(['2026-08-15', '2026-08-15', '2026-08-16']);

    // Two blocks on one day decide each other's type, so both entries of that
    // day carry both blocks.
    const [daytime, evening, nextDay] = schedule.schedule;
    expect(daytime.type).toBe('OPERATING');
    expect(rawOf(daytime)).toEqual({parkDetail: [daytimeBlock, eveningBlock]});
    expect((rawOf(daytime)!.parkDetail as unknown[])[0]).toBe(daytimeBlock);
    expect(daytime.closingTime).toBe('2026-08-15T21:00:00-07:00');

    expect(evening.type).toBe('TICKETED_EVENT');
    expect(rawOf(evening)!.parkDetail).toEqual([daytimeBlock, eveningBlock]);

    // A day with one block carries that block, not a list of one.
    expect(rawOf(nextDay)).toEqual({parkDetail: nextDayBlock});
    expect(rawOf(nextDay)!.parkDetail).toBe(nextDayBlock);
  });

  it('carries nothing when includeRaw is off', async () => {
    const park = stubbedPark(false);
    for (const element of await park.getLiveData()) expect(rawOf(element)).toBeUndefined();
    for (const element of await park.getEntities()) expect(rawOf(element)).toBeUndefined();
    for (const element of (await park.getSchedules())[0].schedule) expect(rawOf(element)).toBeUndefined();
  });
});
