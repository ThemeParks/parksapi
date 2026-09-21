import {describe, it, expect, vi, beforeEach, afterEach} from 'vitest';
import {SeaWorldGoldCoast} from '../te2.js';
import {CacheLib} from '../../../cache.js';
import type {WithRaw} from '../../../destination.js';
import type {HTTPObj} from '../../../http.js';

/**
 * With `includeRaw` on, every live ride row carries the status entry it was
 * built from, under the name of the endpoint that served it, and a show row
 * carries every calendar slot behind its showtimes. Entities carry the venue,
 * the POI entry or the calendar event they were built from, and every schedule
 * entry carries its day and the hours block inside it. Off, nothing carries
 * anything.
 */
// 10:00 in Australia/Brisbane, before the day's first performance
const NOW = new Date('2026-09-21T00:00:00Z');

const CONFIG = {
  apiUser: 'user', apiPass: 'pass',
  baseUrl: 'https://te2.example', venueId: 'VRTP_SW',
  timezone: 'Australia/Brisbane',
};

const venue = {name: 'Sea World', location: {center: {lon: 153.4258, lat: -27.9575}}};

const leviathanPoi = {id: 'POI_LEVIATHAN', name: 'Leviathan', type: 'Ride', location: {lon: 153.4262, lat: -27.9571}};
const stormPoi = {id: 'POI_STORM', name: 'Storm Coaster', type: 'Ride', location: {lon: 153.4259, lat: -27.9569}};
const dinerPoi = {id: 'POI_DINER', name: 'Dockside Diner', type: 'Dining', location: {lon: 153.4265, lat: -27.9578}};
const jetSkiPoi = {id: 'POI_JETSKI', name: 'Jet Ski Spectacular', type: 'Shows', location: {lon: 153.4271, lat: -27.9581}};

// Entries of the external ride-status feed, keyed back by a `te2_rideid:` tag
const leviathanRide = {
  tags: ['te2_rideid:POI_LEVIATHAN'], isOpen: true, waitTimeMins: 25,
  queues: [{isPrimary: true, isOpen: true, waitTimeMins: 25}],
};
const stormRide = {tags: ['te2_rideid:POI_STORM'], isOpen: false, state: 'Closed', queues: []};
const retiredRide = {tags: ['te2_rideid:POI_GONE'], isOpen: true, waitTimeMins: 5, queues: []};

// Entry of the POI status endpoint, used when no ride-status URL is configured
const leviathanStatus = {id: 'POI_LEVIATHAN', status: {isOpen: true, waitTime: 15}};

const dolphinEvent = {
  id: 'EVT_DOLPHIN', title: 'Dolphin Presentation',
  associatedPois: [{id: 'POI_LEVIATHAN'}],
};
const morningSlot = {eventId: 'EVT_DOLPHIN', start: '2026-09-21T11:00:00+10:00', end: '2026-09-21T11:30:00+10:00'};
const afternoonSlot = {eventId: 'EVT_DOLPHIN', start: '2026-09-21T14:00:00+10:00', end: '2026-09-21T14:30:00+10:00'};
const eventCalendar = {events: [dolphinEvent], schedules: [afternoonSlot, morningSlot]};

const parkHours = {label: 'Park', status: 'OPEN', schedule: {start: '2026-09-21T10:00:00+10:00', end: '2026-09-21T17:00:00+10:00'}};
const coveHours = {label: 'Dolphin Cove', status: 'OPEN', schedule: {start: '2026-09-21T11:00:00+10:00', end: '2026-09-21T15:00:00+10:00'}};
const scheduleDay = {label: 'Park', hours: [parkHours, coveHours]};
const scheduleData = {days: [scheduleDay]};

function stubReaders(park: SeaWorldGoldCoast): void {
  vi.spyOn(park as any, 'getVenue').mockResolvedValue(venue);
  vi.spyOn(park as any, 'getPOIAll').mockResolvedValue([leviathanPoi, stormPoi, dinerPoi, jetSkiPoi]);
  vi.spyOn(park as any, 'getDisplayCategories').mockResolvedValue({
    ridePoiIds: {}, showPoiIds: {}, diningPoiIds: {},
  });
  vi.spyOn(park as any, 'getEventCalendar').mockResolvedValue(eventCalendar);
  vi.spyOn(park as any, 'getScheduleData').mockResolvedValue(scheduleData);
}

/** A park reading the external ride-status endpoint. */
function stubbedPark(includeRaw: boolean): SeaWorldGoldCoast {
  const park = new SeaWorldGoldCoast({config: {...CONFIG, rideStatusUrl: 'https://rides.example/status'}});
  park.includeRaw = includeRaw;
  stubReaders(park);
  vi.spyOn(park as any, 'fetchRideStatus').mockResolvedValue({
    json: async () => [leviathanRide, stormRide, retiredRide],
  } as any as HTTPObj);
  return park;
}

/** A park with no ride-status URL, falling back to the POI status endpoint. */
function stubbedParkOnPOIStatus(includeRaw: boolean): SeaWorldGoldCoast {
  const park = new SeaWorldGoldCoast({config: {...CONFIG, rideStatusUrl: ''}});
  park.includeRaw = includeRaw;
  stubReaders(park);
  vi.spyOn(park as any, 'fetchPOIStatus').mockResolvedValue({
    json: async () => [leviathanStatus],
  } as any as HTTPObj);
  return park;
}

const rawOf = (element: object) => (element as WithRaw<object>).raw;

describe('TE2 raw upstream pieces', () => {
  beforeEach(() => {
    CacheLib.clear({includePersistent: true});
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    CacheLib.clear({includePersistent: true});
  });

  it('attaches the ride-status entry to each live ride row', async () => {
    const live = await stubbedPark(true).getLiveData();
    // The third feed entry has no entity of its own and never becomes a row.
    expect(live.map((l) => l.id)).toEqual(['POI_LEVIATHAN', 'POI_STORM', 'EVT_DOLPHIN']);

    expect(live[0].queue).toEqual({STANDBY: {waitTime: 25}});
    // The normalised entries are cached, so the piece is the feed entry as it
    // comes back out of the cache rather than the fixture object itself.
    expect(rawOf(live[0])).toEqual({rideStatus: leviathanRide});

    expect(live[1].status).toBe('CLOSED');
    expect(live[1].queue).toBeUndefined();
    expect(rawOf(live[1])).toEqual({rideStatus: stormRide});
  });

  it('attaches the POI status entry when that is the endpoint in use', async () => {
    const live = await stubbedParkOnPOIStatus(true).getLiveData();
    expect(live.map((l) => l.id)).toEqual(['POI_LEVIATHAN', 'EVT_DOLPHIN']);

    expect(live[0].queue).toEqual({STANDBY: {waitTime: 15}});
    expect(rawOf(live[0])).toEqual({poiStatus: leviathanStatus});
  });

  it('attaches every calendar slot behind a show row, in the order it publishes them', async () => {
    const live = await stubbedPark(true).getLiveData();
    const show = live.find((l) => l.id === 'EVT_DOLPHIN')!;

    expect(show.status).toBe('OPERATING');
    expect(show.showtimes!.map((s) => s.startTime)).toEqual([
      '2026-09-21T11:00:00+10:00', '2026-09-21T14:00:00+10:00',
    ]);
    expect(rawOf(show)).toEqual({eventCalendarSchedules: [morningSlot, afternoonSlot]});
    expect((rawOf(show)!.eventCalendarSchedules as unknown[])[0]).toBe(morningSlot);
    expect((rawOf(show)!.eventCalendarSchedules as unknown[])[1]).toBe(afternoonSlot);
  });

  it('attaches the venue, the POI entry and the calendar event to the entities', async () => {
    const entities = await stubbedPark(true).getEntities();
    const byId = new Map(entities.map((e) => [e.id, e]));

    const destination = byId.get('vrtp_sw_te2_destination')!;
    expect(destination.name).toBe('Sea World');
    expect(rawOf(destination)).toEqual({venue});
    expect(rawOf(destination)!.venue).toBe(venue);
    expect(rawOf(byId.get('vrtp_sw_te2')!)!.venue).toBe(venue);

    const leviathan = byId.get('POI_LEVIATHAN')!;
    expect(leviathan.entityType).toBe('ATTRACTION');
    expect(rawOf(leviathan)).toEqual({poiAll: leviathanPoi});
    expect(rawOf(leviathan)!.poiAll).toBe(leviathanPoi);

    const diner = byId.get('POI_DINER')!;
    expect(diner.entityType).toBe('RESTAURANT');
    expect(rawOf(diner)!.poiAll).toBe(dinerPoi);

    // A show the POI list does not carry comes from the calendar instead.
    const dolphin = byId.get('EVT_DOLPHIN')!;
    expect(dolphin.name).toBe('Dolphin Presentation');
    expect(rawOf(dolphin)).toEqual({eventCalendarEvents: dolphinEvent});
    expect(rawOf(dolphin)!.eventCalendarEvents).toBe(dolphinEvent);
  });

  it('attaches the day and its hours block to each schedule entry', async () => {
    const [schedule] = await stubbedPark(true).getSchedules();
    expect(schedule.schedule.map((e) => e.type)).toEqual(['OPERATING', 'INFO']);

    const [parkEntry, coveEntry] = schedule.schedule;
    expect(parkEntry.openingTime).toBe('2026-09-21T10:00:00+10:00');
    expect(rawOf(parkEntry)).toEqual({schedule: [scheduleDay, parkHours]});
    expect((rawOf(parkEntry)!.schedule as unknown[])[1]).toBe(parkHours);

    expect(coveEntry.description).toBe('Dolphin Cove');
    // The same day object stands behind both of its entries.
    expect((rawOf(coveEntry)!.schedule as unknown[])[0]).toBe(scheduleDay);
    expect((rawOf(coveEntry)!.schedule as unknown[])[1]).toBe(coveHours);
  });

  it('carries nothing when includeRaw is off', async () => {
    const park = stubbedPark(false);
    for (const element of await park.getLiveData()) expect(rawOf(element)).toBeUndefined();
    for (const element of await park.getEntities()) expect(rawOf(element)).toBeUndefined();
    for (const schedule of await park.getSchedules()) {
      for (const element of schedule.schedule) expect(rawOf(element)).toBeUndefined();
    }
  });
});
