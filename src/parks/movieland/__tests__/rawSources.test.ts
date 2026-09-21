import {describe, it, expect, vi, beforeEach, afterEach} from 'vitest';
import {Movieland} from '../movieland.js';
import {CacheLib} from '../../../cache.js';
import type {WithRaw} from '../../../destination.js';

/**
 * With `includeRaw` on, every element carries the upstream piece it was built
 * from: the show row for a live row, both rows as a list where two of them
 * publish performances of the same show, the point entry for an entity, and
 * for a schedule day the two halves it was joined from, the day of the month
 * data and the legend entry that carries the hours. The destination and the
 * park, built from constants, carry nothing. Off, nothing carries anything.
 */
const NOW = new Date('2026-10-24T08:00:00Z');
const DATE = '2026-10-24';

const medusaPoint = {id: 'mv_show_medusa', nome: 'Medusa Show', categoria: 'show', lat: '45.47623', lng: '10.7262'};
const bugsPoint = {id: 'mv_show_bugstownshow', nome: 'Once upon a time in Bugs Town', categoria: 'show'};
const ridePoint = {id: 'mv_ride_diabolik', nome: 'Diabolik Invertigo', categoria: 'ride', lat: '45.4771', lng: '10.72705'};

const medusaShow = {id: 'mv_show_medusa', infoPointId: 'mv_show_medusa', parco: 'movieland', schedule: {[DATE]: ['14:30']}};
const bugsShow = {id: 'mv_show_bugstownshow', infoPointId: 'mv_show_bugstownshow', parco: 'movieland', schedule: {[DATE]: ['11:00']}};
const bugsShowLate = {id: 'mv_show_bugstowshow2', infoPointId: 'mv_show_bugstownshow', parco: 'movieland', schedule: {[DATE]: ['19:00']}};

const plainHours = {openingTime: '10:00', closingTime: '18:00'};
const halloweenHours = {openingTime: '10:00', closingTime: '00:00', closesNextDay: true, description: 'Halloween Night'};
const legend = {'895': plainHours, '900': halloweenHours};

const firstDay = {'895': {}};
const secondDay = {'895': {}};
const halloweenDay = {'900': {}};
const calendarMonth = {contents_calendars: {'3': {'2026-10-23': firstDay, '2026-10-24': secondDay, '2026-10-31': halloweenDay}}};

function stubbedPark(includeRaw: boolean): Movieland {
  const park = new Movieland();
  park.includeRaw = includeRaw;
  park.webBase = 'https://example.invalid';
  park.scheduleMonths = 1;
  vi.spyOn(park as any, 'getPoints').mockResolvedValue([medusaPoint, bugsPoint, ridePoint]);
  vi.spyOn(park as any, 'fetchShows').mockResolvedValue({json: async () => [medusaShow, bugsShow, bugsShowLate]});
  vi.spyOn(park as any, 'getCalendarLegend').mockResolvedValue(legend);
  vi.spyOn(park as any, 'fetchCalendarMonth').mockResolvedValue({json: async () => calendarMonth});
  return park;
}

const rawOf = (element: object) => (element as WithRaw<object>).raw;

describe('Movieland raw upstream pieces', () => {
  beforeEach(() => {
    CacheLib.clear();
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    CacheLib.clear();
  });

  it('attaches the show row to each live row, both rows where two feed one show', async () => {
    const live = await stubbedPark(true).getLiveData();
    expect(live.map((l) => l.id)).toEqual(['mv_show_medusa', 'mv_show_bugstownshow']);

    expect(rawOf(live[0])).toEqual({shows: medusaShow});
    expect(rawOf(live[0])!.shows).toBe(medusaShow);
    expect(live[0].showtimes).toEqual([{type: 'Performance', startTime: '2026-10-24T14:30:00+02:00'}]);

    expect(rawOf(live[1])).toEqual({shows: [bugsShow, bugsShowLate]});
    expect((rawOf(live[1])!.shows as unknown[])[1]).toBe(bugsShowLate);
    expect(live[1].showtimes?.map((s) => s.startTime)).toEqual([
      '2026-10-24T11:00:00+02:00',
      '2026-10-24T19:00:00+02:00',
    ]);
  });

  it('attaches the point entry to each entity, nothing to the destination and the park', async () => {
    const entities = await stubbedPark(true).getEntities();
    expect(entities.map((e) => e.id)).toEqual([
      'canevaworld-resort', 'movieland', 'mv_show_medusa', 'mv_show_bugstownshow', 'mv_ride_diabolik',
    ]);

    expect(rawOf(entities[0])).toBeUndefined();
    expect(rawOf(entities[1])).toBeUndefined();
    expect(rawOf(entities[2])).toEqual({points: medusaPoint});
    expect(rawOf(entities[2])!.points).toBe(medusaPoint);
    expect(rawOf(entities[4])!.points).toBe(ridePoint);
    expect(entities[4].name).toBe('Diabolik Invertigo');
  });

  it('attaches the day of the month data and the legend entry to each day', async () => {
    const [schedule] = await stubbedPark(true).getSchedules();
    expect(schedule.schedule.map((e) => e.date)).toEqual(['2026-10-23', '2026-10-24', '2026-10-31']);

    const [first, second, halloween] = schedule.schedule;
    expect(rawOf(first)).toEqual({calendarMonth: firstDay, calendarPage: plainHours});
    expect(rawOf(first)!.calendarMonth).toBe(firstDay);
    expect(first.closingTime).toBe('2026-10-23T18:00:00+02:00');

    // Two days painted in the same colour share the one legend entry.
    expect(rawOf(second)!.calendarMonth).toBe(secondDay);
    expect(rawOf(second)!.calendarPage).toBe(plainHours);

    expect(rawOf(halloween)).toEqual({calendarMonth: halloweenDay, calendarPage: halloweenHours});
    expect(rawOf(halloween)!.calendarPage).toBe(halloweenHours);
    expect(halloween.closingTime).toBe('2026-11-01T00:00:00+01:00');
  });

  it('carries nothing when includeRaw is off', async () => {
    const park = stubbedPark(false);
    for (const element of await park.getLiveData()) expect(rawOf(element)).toBeUndefined();
    for (const element of await park.getEntities()) expect(rawOf(element)).toBeUndefined();
    for (const element of (await park.getSchedules())[0].schedule) expect(rawOf(element)).toBeUndefined();
  });
});
