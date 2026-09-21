import {describe, it, expect, vi, beforeEach, afterEach} from 'vitest';
import {UniversalStudiosBeijing} from '../universalbeijing.js';
import type {WithRaw} from '../../../destination.js';

/**
 * With `includeRaw` on, every live row and entity carries the attraction or
 * show row it was built from, and every schedule day carries the month
 * overview that selected the day plus the daily schedule that gave its
 * times. Off, nothing carries anything.
 */
const NOW = new Date('2026-09-21T10:00:00Z');

const attractionKong = {id: 601, title: 'King Kong{1}', gems_status: '1', is_closed: false, waiting_time: 25, position: {latitude: '39.85', longitude: '116.67'}};
const attractionJurassic = {id: 602, title: 'Jurassic World{2}', gems_status: '3', is_closed: false, waiting_time: null, position: {latitude: '39.86', longitude: '116.68'}};

const showPanda = {id: 701, title: 'Kung Fu Panda Show', gems_status: '2', is_closed: false, show_time_arr: [{time: '11:00'}, {time: '15:00'}], position: {latitude: '39.855', longitude: '116.671'}};

const dayOverview = {date: '2026-09-21', status: 1};
const dailyPark = {gems_status: '1', open: '09:00', close: '21:00'};

function stubbedPark(includeRaw: boolean): UniversalStudiosBeijing {
  const park = new UniversalStudiosBeijing();
  park.includeRaw = includeRaw;
  vi.spyOn(park as any, 'getAttractionData').mockResolvedValue([attractionKong, attractionJurassic]);
  vi.spyOn(park as any, 'getShowData').mockResolvedValue([showPanda]);
  vi.spyOn(park as any, 'getMonthOverview').mockImplementation(async (...args: any[]) => {
    const [year, month] = args as [number, number];
    return year === 2026 && month === 9 ? [dayOverview] : [];
  });
  vi.spyOn(park as any, 'getDailySchedule').mockImplementation(async (...args: any[]) => {
    const [date] = args as [string];
    return date === '2026-09-21' ? {service_time: {park: dailyPark}} : null;
  });
  return park;
}

const rawOf = (element: object) => (element as WithRaw<object>).raw;

describe('UniversalStudiosBeijing raw upstream pieces', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('attaches the attraction row and the show row to their live rows', async () => {
    const live = await stubbedPark(true).getLiveData();
    expect(live.map((l) => l.id)).toEqual(['601', '602', '701']);

    expect(rawOf(live[0])).toEqual({attractionData: attractionKong});
    expect(rawOf(live[0])!.attractionData).toBe(attractionKong);
    expect(live[0].status).toBe('OPERATING');
    expect(live[0].queue).toEqual({STANDBY: {waitTime: 25}});

    expect(rawOf(live[1])).toEqual({attractionData: attractionJurassic});
    expect(live[1].status).toBe('CLOSED');
    expect(live[1].queue).toBeUndefined();

    expect(rawOf(live[2])).toEqual({showData: showPanda});
    expect(rawOf(live[2])!.showData).toBe(showPanda);
    expect(live[2].showtimes).toEqual([
      {type: 'Performance Time', startTime: '2026-09-21T11:00:00+08:00', endTime: null},
      {type: 'Performance Time', startTime: '2026-09-21T15:00:00+08:00', endTime: null},
    ]);
  });

  it('attaches the source row to each attraction and show entity, nothing to the park', async () => {
    const entities = await stubbedPark(true).getEntities();
    expect(entities.map((e) => e.id)).toEqual(['universalbeijingresort', 'universalstudiosbeijing', '601', '602', '701']);

    expect(rawOf(entities[0])).toBeUndefined();
    expect(rawOf(entities[1])).toBeUndefined();

    expect(rawOf(entities[2])).toEqual({attractionData: attractionKong});
    expect(rawOf(entities[2])!.attractionData).toBe(attractionKong);
    expect(entities[2].name).toBe('King Kong™');

    expect(rawOf(entities[3])!.attractionData).toBe(attractionJurassic);
    expect(rawOf(entities[4])).toEqual({showData: showPanda});
    expect(rawOf(entities[4])!.showData).toBe(showPanda);
  });

  it('attaches the month overview and the daily schedule to the open day', async () => {
    const [schedule] = await stubbedPark(true).getSchedules();
    expect(schedule.schedule).toHaveLength(1);

    const [today] = schedule.schedule;
    expect(today.date).toBe('2026-09-21');
    expect(rawOf(today)).toEqual({monthOverview: dayOverview, dailySchedule: dailyPark});
    expect(rawOf(today)!.monthOverview).toBe(dayOverview);
    expect(rawOf(today)!.dailySchedule).toBe(dailyPark);
    expect(today.openingTime).toBe('2026-09-21T09:00:00+08:00');
    expect(today.closingTime).toBe('2026-09-21T21:00:00+08:00');
  });

  it('carries nothing when includeRaw is off', async () => {
    const park = stubbedPark(false);
    for (const element of await park.getLiveData()) expect(rawOf(element)).toBeUndefined();
    for (const element of await park.getEntities()) expect(rawOf(element)).toBeUndefined();
    for (const element of (await park.getSchedules())[0].schedule) expect(rawOf(element)).toBeUndefined();
  });
});
