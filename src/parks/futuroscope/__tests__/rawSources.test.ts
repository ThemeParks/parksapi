import {describe, it, expect, vi, beforeEach, afterEach} from 'vitest';
import {Futuroscope} from '../futuroscope.js';
import type {WithRaw} from '../../../destination.js';

/**
 * With `includeRaw` on, every element carries the upstream piece it was
 * built from: the POI entry for an attraction or a show entity, the
 * live-data entry for a live row, and the parsed calendar item for a
 * schedule day, the same object on every day of the period it covers. Off,
 * nothing carries anything. The destination and the park, built from
 * literals, carry nothing either way.
 */
const NOW = new Date('2026-09-21T10:00:00Z');

const arthurExpress = {id: 501, title: 'Arthur Express', type: 'attraction', theme: 'Discovery', latitude: '46.6670', longitude: '0.3675'};
const extraordinaryShow = {id: 502, title: 'Extraordinary Show', type: 'attraction', theme: 'Shows', latitude: '46.6672', longitude: '0.3680'};

const arthurLive = {id: 501, status: 3, minutes_left: null, infos: {textCard: '15 min wait', texts: []}};
const showLive = {id: 502, status: 6, minutes_left: null, infos: {texts: ['Temporarily closed']}};
const unknownLive = {id: 999, status: 1, infos: null};

// The enriched item buildSchedules matches for a date: the parsed calendar
// entry plus the [hour, minute] pairs split out of its hours strings.
const scheduleJSONItem = {
  type: 'schedule',
  periods: [{from: '2020-01-01T00:00:00.000Z', to: '2030-01-01T00:00:00.000Z'}],
  detailsSchedule: {space: 'Futuroscope', hours: {from: '09:00', to: '19:00'}},
};
const expectedScheduleItem = {...scheduleJSONItem, open: [9, 0], close: [19, 0]};

/** Build the Next.js page HTML buildSchedules scrapes its calendar JSON from. */
function buildCalendarHTML(): string {
  const escaped = JSON.stringify({items: [scheduleJSONItem]}).replace(/"/g, '\\"');
  return `<script>self.__next_f.push([1,"${escaped}]\\n"])</script>`;
}

function stubbedPark(includeRaw: boolean): Futuroscope {
  const park = new Futuroscope();
  park.includeRaw = includeRaw;
  vi.spyOn(park as any, 'getPOIData').mockResolvedValue({poi: [arthurExpress, extraordinaryShow]});
  vi.spyOn(park as any, 'getRawLiveData').mockResolvedValue([arthurLive, showLive, unknownLive]);
  vi.spyOn(park as any, 'getCalendarHTML').mockResolvedValue(buildCalendarHTML());
  return park;
}

const rawOf = (element: object) => (element as WithRaw<object>).raw;

describe('Futuroscope raw upstream pieces', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('attaches the live-data entry to each live row', async () => {
    const live = await stubbedPark(true).getLiveData();
    expect(live.map((l) => l.id)).toEqual(['501', '502']);

    expect(rawOf(live[0])).toEqual({liveData: arthurLive});
    expect(rawOf(live[0])!.liveData).toBe(arthurLive);
    expect(live[0].queue).toEqual({STANDBY: {waitTime: 15}});

    expect(live[1]).toMatchObject({status: 'DOWN'});
    expect(rawOf(live[1])!.liveData).toBe(showLive);
  });

  it('attaches the POI entry to the attraction and the show, nothing to the destination or the park', async () => {
    const entities = await stubbedPark(true).getEntities();
    expect(entities.map((e) => e.id)).toEqual(['futuroscopedestination', 'futuroscope', '501', '502']);

    expect(rawOf(entities[0])).toBeUndefined();
    expect(rawOf(entities[1])).toBeUndefined();

    expect(rawOf(entities[2])).toEqual({poiData: arthurExpress});
    expect(rawOf(entities[2])!.poiData).toBe(arthurExpress);
    expect(entities[2].location).toEqual({latitude: 46.667, longitude: 0.3675});

    expect(rawOf(entities[3])).toEqual({poiData: extraordinaryShow});
    expect(entities[3].entityType).toBe('SHOW');
  });

  it('attaches the same parsed calendar item to every day of the period', async () => {
    const [schedule] = await stubbedPark(true).getSchedules();
    expect(schedule.schedule!.length).toBe(120);

    const [day0, day1] = schedule.schedule!;
    const lastDay = schedule.schedule![119];
    expect(day0.date).toBe('2026-09-21');
    expect(day1.date).toBe('2026-09-22');
    expect(day0.openingTime).toBe('2026-09-21T09:00:00+02:00');
    expect(day0.closingTime).toBe('2026-09-21T19:00:00+02:00');

    expect(rawOf(day0)).toEqual({calendarHTML: expectedScheduleItem});
    expect(rawOf(day0)!.calendarHTML).toBe(rawOf(day1)!.calendarHTML);
    expect(rawOf(day0)!.calendarHTML).toBe(rawOf(lastDay)!.calendarHTML);
  });

  it('carries nothing when includeRaw is off', async () => {
    const park = stubbedPark(false);
    for (const element of await park.getLiveData()) expect(rawOf(element)).toBeUndefined();
    for (const element of await park.getEntities()) expect(rawOf(element)).toBeUndefined();
    for (const element of (await park.getSchedules())[0].schedule!) expect(rawOf(element)).toBeUndefined();
  });
});
