import {describe, it, expect, vi, beforeEach, afterEach} from 'vitest';
import {FlamingoLand} from '../flamingoland.js';
import type {WithRaw} from '../../../destination.js';

/**
 * With `includeRaw` on, every live row and every entity carries the Firestore
 * ride document it was built from, an entity placed on the map also carries
 * its marker, and every schedule day carries the season window — the same
 * object on each day, with today adding the homepage closing time it used.
 * The park and the destination come from constants. Off, nothing carries
 * anything.
 */
// 10:00 in Europe/London (BST), so "today" is 2026-09-21
const NOW = new Date('2026-09-21T09:00:00Z');

const splashDoc = {
  name: 'projects/p/databases/(default)/documents/rides_data/216',
  fields: {
    title: {stringValue: 'Splash Battle'},
    categoriesId: {integerValue: '3'},
    statusOpen: {booleanValue: true},
    underMaintenance: {booleanValue: false},
    downAllDay: {booleanValue: false},
    queue_time: {integerValue: '15'},
    parkMapMarkerId: {stringValue: '216'},
    restrictions: {doubleValue: 91.44},
  },
};
const cliffhangerDoc = {
  name: 'projects/p/databases/(default)/documents/rides_data/217',
  fields: {
    title: {stringValue: 'Cliffhanger'},
    categoriesId: {integerValue: '3'},
    statusOpen: {booleanValue: false},
    underMaintenance: {booleanValue: false},
    downAllDay: {booleanValue: false},
    queue_time: {integerValue: '0'},
  },
};
const categoryDoc = {
  name: 'projects/p/databases/(default)/documents/ride_categories/3',
  fields: {id: {integerValue: '3'}, showQueueTime: {booleanValue: true}},
};

const splashMarker = {id: '216', title: 'Splash Battle', lat: 54.2113, lng: -0.8082, type: 'ride'};

const season = {start: '2026-09-20', end: '2026-09-22', openHour: 10};
const todayClose = '17:30';

function stubbedPark(includeRaw: boolean): FlamingoLand {
  const park = new FlamingoLand();
  park.includeRaw = includeRaw;
  vi.spyOn(park as any, 'getRides').mockResolvedValue([splashDoc, cliffhangerDoc]);
  vi.spyOn(park as any, 'getRideCategories').mockResolvedValue([categoryDoc]);
  vi.spyOn(park as any, 'getAttractionRideIds').mockResolvedValue(['216', '217']);
  vi.spyOn(park as any, 'scrapeMarkers').mockResolvedValue([splashMarker]);
  vi.spyOn(park as any, 'scrapeSeasonWindow').mockResolvedValue(season);
  vi.spyOn(park as any, 'scrapeTodayCloseTime').mockResolvedValue(todayClose);
  return park;
}

const rawOf = (element: object) => (element as WithRaw<object>).raw;

describe('Flamingo Land raw upstream pieces', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('attaches the ride document to each live row', async () => {
    const live = await stubbedPark(true).getLiveData();
    expect(live.map((l) => l.id)).toEqual(['216', '217']);

    expect(rawOf(live[0])).toEqual({rides: splashDoc});
    expect(rawOf(live[0])!.rides).toBe(splashDoc);
    expect(live[0].status).toBe('OPERATING');
    expect(live[0].queue).toEqual({STANDBY: {waitTime: 15}});

    expect(live[1].status).toBe('CLOSED');
    expect(rawOf(live[1])!.rides).toBe(cliffhangerDoc);
  });

  it('attaches the ride document and the map marker to each entity, nothing to the park', async () => {
    const entities = await stubbedPark(true).getEntities();
    expect(entities.map((e) => e.id)).toEqual(['flamingoland', 'flamingoland-park', '216', '217']);

    expect(rawOf(entities[0])).toBeUndefined();
    expect(rawOf(entities[1])).toBeUndefined();

    expect(rawOf(entities[2])).toEqual({mapPage: splashMarker, rides: splashDoc});
    expect(rawOf(entities[2])!.rides).toBe(splashDoc);
    expect(rawOf(entities[2])!.mapPage).toBe(splashMarker);
    expect(entities[2].name).toBe('Splash Battle');

    // No marker matched this ride, so only the document is behind it
    expect(rawOf(entities[3])).toEqual({rides: cliffhangerDoc});
  });

  it('attaches the season window to every day and the banner time to today', async () => {
    const [schedule] = await stubbedPark(true).getSchedules();
    expect(schedule.schedule.map((d) => d.date)).toEqual(['2026-09-21', '2026-09-22']);

    const [today, tomorrow] = schedule.schedule;
    expect(today.openingTime).toBe('2026-09-21T10:00:00+01:00');
    expect(today.closingTime).toBe('2026-09-21T17:30:00+01:00');
    expect(rawOf(today)).toEqual({webshopOverview: season, homepage: todayClose});
    expect(rawOf(today)!.webshopOverview).toBe(season);

    // The default closing time is ours, so the day carries only the season
    expect(tomorrow.closingTime).toBe('2026-09-22T17:00:00+01:00');
    expect(rawOf(tomorrow)).toEqual({webshopOverview: season});
    expect(rawOf(tomorrow)!.webshopOverview).toBe(season);
  });

  it('carries nothing when includeRaw is off', async () => {
    const park = stubbedPark(false);
    for (const element of await park.getLiveData()) expect(rawOf(element)).toBeUndefined();
    for (const element of await park.getEntities()) expect(rawOf(element)).toBeUndefined();
    for (const element of (await park.getSchedules())[0].schedule) expect(rawOf(element)).toBeUndefined();
  });
});
