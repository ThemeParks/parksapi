import {describe, it, expect, vi, beforeEach, afterEach} from 'vitest';
import {Chimelong} from '../chimelong.js';
import {CacheLib} from '../../../cache.js';
import type {WithRaw} from '../../../destination.js';
import type {HTTPObj} from '../../../http.js';

/**
 * With `includeRaw` on, every element carries the upstream piece it was built
 * from: the wait-time row for a live row and for the attraction it created,
 * and the calendar match for every day that match produced. Destinations and
 * parks come from constants and carry nothing. Off, nothing carries anything.
 */
// 10:00 in Asia/Shanghai, so "today" is 2026-09-21 for the calendar fallback
const NOW = new Date('2026-09-21T02:00:00Z');

const rideRow = {code: 'GZ51A', name: 'Dive Coaster', waitingTime: '30', parkId: 'GZ51'};
const closedRow = {code: 'ZH56B', name: 'Ocean Theatre', waitingTime: null, parkId: 'ZH56'};

const rangeHtml = '<p>10月1日-10月3日：10:00-19:00</p><p>10月8日-10月11日：周六至周日：11:00-18:00</p>';
const fallbackHtml = '<div>园区营业时间 09:30-18:00</div>';

function stubbedPark(includeRaw: boolean): Chimelong {
  const park = new Chimelong();
  park.includeRaw = includeRaw;
  vi.spyOn(park as any, 'getAllWaitTimes').mockResolvedValue([rideRow, closedRow]);
  vi.spyOn(park as any, 'fetchCalendarPage').mockImplementation(async (url: any) => {
    if (String(url).includes('chimelongparadise')) return {text: async () => rangeHtml} as any as HTTPObj;
    if (String(url).includes('oceankingdom')) return {text: async () => fallbackHtml} as any as HTTPObj;
    return {text: async () => ''} as any as HTTPObj;
  });
  return park;
}

const rawOf = (element: object) => (element as WithRaw<object>).raw;

describe('Chimelong raw upstream pieces', () => {
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

  it('attaches the wait-time row to each live row', async () => {
    const live = await stubbedPark(true).getLiveData();
    expect(live.map((l) => l.id)).toEqual(['attraction_GZ51A', 'attraction_ZH56B']);

    expect(rawOf(live[0])).toEqual({waitTimes: rideRow});
    expect(rawOf(live[0])!.waitTimes).toBe(rideRow);
    expect(live[0].queue).toEqual({STANDBY: {waitTime: 30}});

    expect(live[1]).toMatchObject({status: 'CLOSED'});
    expect(rawOf(live[1])!.waitTimes).toBe(closedRow);
  });

  it('attaches the wait-time row to each attraction, nothing to parks and destinations', async () => {
    const entities = await stubbedPark(true).getEntities();
    const attractions = entities.filter((e) => e.entityType === 'ATTRACTION');
    expect(attractions.map((e) => e.id)).toEqual(['attraction_GZ51A', 'attraction_ZH56B']);

    for (const other of entities.filter((e) => e.entityType !== 'ATTRACTION')) {
      expect(rawOf(other)).toBeUndefined();
    }

    expect(rawOf(attractions[0])).toEqual({waitTimes: rideRow});
    expect(rawOf(attractions[0])!.waitTimes).toBe(rideRow);
    expect(attractions[0].name).toBe('Dive Coaster');
    expect(rawOf(attractions[1])!.waitTimes).toBe(closedRow);
  });

  it('attaches the calendar match to every day it produced', async () => {
    const schedules = await stubbedPark(true).getSchedules();
    expect(schedules.map((s) => s.id)).toEqual(['park_GZ51', 'park_ZH56']);

    const days = schedules[0].schedule;
    expect(days.map((d) => d.date)).toEqual(['2026-10-01', '2026-10-02', '2026-10-03', '2026-10-10', '2026-10-11']);
    expect(days[0].openingTime).toBe('2026-10-01T10:00:00+08:00');
    expect(days[0].closingTime).toBe('2026-10-01T19:00:00+08:00');

    // One match, three days: the same object on each of them
    const range = rawOf(days[0])!.calendarPage;
    expect(range).toEqual({from: '10月1日', to: '10月3日', open: '10:00', close: '19:00'});
    expect(rawOf(days[1])!.calendarPage).toBe(range);
    expect(rawOf(days[2])!.calendarPage).toBe(range);

    // The weekend match keeps its day-of-week filter and covers its two days
    const weekend = rawOf(days[3])!.calendarPage;
    expect(weekend).toEqual({from: '10月8日', to: '10月11日', days: '周六至周日', open: '11:00', close: '18:00'});
    expect(rawOf(days[4])!.calendarPage).toBe(weekend);
    expect(days[3].openingTime).toBe('2026-10-10T11:00:00+08:00');

    // The fallback pattern gives today only, and the times it found
    const [today] = schedules[1].schedule;
    expect(today.date).toBe('2026-09-21');
    expect(today.closingTime).toBe('2026-09-21T18:00:00+08:00');
    expect(rawOf(today)).toEqual({calendarPage: {open: '09:30', close: '18:00'}});
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
