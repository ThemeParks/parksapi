import {describe, it, expect, vi, beforeEach, afterEach} from 'vitest';
import {Phantasialand} from '../phantasialand.js';
import type {WithRaw} from '../../../destination.js';

/**
 * With `includeRaw` on, every element carries the upstream piece it was built
 * from: the signage row for live data, the POI entry for an entity, the
 * calendar event for a day, plus the park-infos object on a day whose closing
 * time it overrode. Off, nothing carries anything.
 */
const NOW = new Date('2026-09-21T10:00:00Z');
const STAMP = '2026-09-21T09:58:00.000Z';
const OLD = '2026-01-01T09:58:00.000Z';

const rideRow = {poiId: '60', updatedAt: STAMP, createdAt: STAMP, updatedRow: STAMP, waitTime: 25, open: true, showTimes: null};
const showRow = {poiId: '70', updatedAt: STAMP, createdAt: STAMP, updatedRow: STAMP, waitTime: null, open: null, showTimes: ['2026-09-21 14:00:00']};
const staleRow = {poiId: '80', updatedAt: OLD, createdAt: OLD, updatedRow: OLD, waitTime: null, open: true, showTimes: null};

const ridePoi = {id: 60, category: 'ATTRACTIONS', seasons: ['SUMMER'], title: {en: 'Taron', de: 'Taron'}, tags: ['ATTRACTION_TYPE_SINGLE_RIDER_LINE'], minSize: 120};
const adminPoi = {id: 61, category: 'ATTRACTIONS', seasons: ['SUMMER'], title: 'Hidden', adminOnly: true};

const event = {title: '09 a.m. until 06 p.m.', days_selected: ['2026-09-21', '2026-09-22']};
const parkInfos = {isOpen: true, close: '2026-09-21 20:00:00'};

function stubbedPark(includeRaw: boolean): Phantasialand {
  const park = new Phantasialand();
  park.includeRaw = includeRaw;
  vi.spyOn(park as any, 'getSignage').mockResolvedValue([rideRow, showRow, staleRow]);
  vi.spyOn(park as any, 'getPOI').mockResolvedValue([ridePoi, adminPoi]);
  vi.spyOn(park as any, 'getCalendarJSON').mockResolvedValue([event]);
  vi.spyOn(park as any, 'getParkInfos').mockResolvedValue(parkInfos);
  return park;
}

const rawOf = (element: object) => (element as WithRaw<object>).raw;

describe('Phantasialand raw upstream pieces', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('attaches the signage row to each live row, stale rows included', async () => {
    const live = await stubbedPark(true).getLiveData();
    expect(live.map((l) => l.id)).toEqual(['60', '70', '80']);

    expect(rawOf(live[0])).toEqual({signage: rideRow});
    expect(rawOf(live[0])!.signage).toBe(rideRow);
    expect(live[0].queue).toEqual({STANDBY: {waitTime: 25}});

    expect(rawOf(live[1])!.signage).toBe(showRow);
    expect(live[1].showtimes).toHaveLength(1);

    expect(live[2]).toMatchObject({status: 'CLOSED'});
    expect(rawOf(live[2])!.signage).toBe(staleRow);
  });

  it('attaches the POI entry to each entity, nothing to the park', async () => {
    const entities = await stubbedPark(true).getEntities();
    expect(entities.map((e) => e.id)).toEqual(['phantasialanddest', 'phantasialand', '60']);

    expect(rawOf(entities[0])).toBeUndefined();
    expect(rawOf(entities[1])).toBeUndefined();
    expect(rawOf(entities[2])).toEqual({poi: ridePoi});
    expect(rawOf(entities[2])!.poi).toBe(ridePoi);
    expect(entities[2].tags).toHaveLength(2);
  });

  it('attaches the calendar event to each day and park-infos to the overridden day', async () => {
    const [schedule] = await stubbedPark(true).getSchedules();
    expect(schedule.schedule.map((e) => e.date)).toEqual(['2026-09-21', '2026-09-22']);

    const [today, tomorrow] = schedule.schedule;
    expect(rawOf(today)).toEqual({scheduleHTML: event, parkInfos});
    expect(rawOf(today)!.scheduleHTML).toBe(event);
    expect(rawOf(today)!.parkInfos).toBe(parkInfos);
    expect(today.closingTime).toBe('2026-09-21T20:00:00+02:00');

    expect(rawOf(tomorrow)).toEqual({scheduleHTML: event});
    expect(rawOf(tomorrow)!.scheduleHTML).toBe(event);
    expect(tomorrow.closingTime).toBe('2026-09-22T18:00:00+02:00');
  });

  it('carries nothing when includeRaw is off', async () => {
    const park = stubbedPark(false);
    for (const element of await park.getLiveData()) expect(rawOf(element)).toBeUndefined();
    for (const element of await park.getEntities()) expect(rawOf(element)).toBeUndefined();
    for (const element of (await park.getSchedules())[0].schedule) expect(rawOf(element)).toBeUndefined();
  });
});
