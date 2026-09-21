import {describe, it, expect, vi, beforeEach, afterEach} from 'vitest';
import {Everland} from '../everland.js';
import type {WithRaw} from '../../../destination.js';

/**
 * With `includeRaw` on, every element carries the upstream piece it was
 * built from: the facility row for an entity and a live row, the
 * park-open-time entry for a schedule day. Off, nothing carries anything.
 */
const NOW = new Date('2026-09-21T12:00:00Z');

const tExpress = {faciltId: 'FA001', faciltNameEng: 'T Express', faciltName: 'T Express KR', operStatusCd: 'OPEN', waitTime: '30', locList: [{latud: '37.2960', lgtud: '127.2050'}]};
const rollingX = {faciltId: 'FA002', faciltNameEng: 'Rolling X-Train', faciltName: 'Rolling X-Train KR', operStatusCd: 'CONR', waitTime: '', locList: []};
const wavePool = {faciltId: 'FB001', faciltNameEng: 'Wave Pool', faciltName: 'Wave Pool KR', operStatusCd: 'CLOS', waitTime: null, locList: [{latud: '37.2965', lgtud: '127.2035'}]};

const everlandToday = {openTime: '10:00', closeTime: '18:00'};
const everlandTomorrow = {openTime: '09:00', closeTime: '20:00'};
const caribbeanToday = {openTime: '10:30', closeTime: '17:00'};

function stubbedPark(includeRaw: boolean): Everland {
  const park = new Everland();
  park.includeRaw = includeRaw;
  vi.spyOn(park as any, 'getFacilities').mockImplementation(async (parkKindCd: unknown) =>
    parkKindCd === '01' ? [tExpress, rollingX] : [wavePool],
  );
  vi.spyOn(park as any, 'fetchParkOpenTime').mockImplementation(async (salesDate: unknown, parkKindCd: unknown) => {
    let data: unknown[] = [];
    if (parkKindCd === '01') {
      if (salesDate === '20260921') data = [everlandToday];
      else if (salesDate === '20260922') data = [everlandTomorrow];
    } else if (parkKindCd === '02' && salesDate === '20260921') {
      data = [caribbeanToday];
    }
    return {json: async () => data} as any;
  });
  return park;
}

const rawOf = (element: object) => (element as WithRaw<object>).raw;

describe('Everland raw upstream pieces', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('attaches the facility row to each live row', async () => {
    const live = await stubbedPark(true).getLiveData();
    expect(live.map((l) => l.id)).toEqual(['FA001', 'FA002', 'FB001']);

    expect(rawOf(live[0])).toEqual({facilities: tExpress});
    expect(rawOf(live[0])!.facilities).toBe(tExpress);
    expect(live[0].queue).toEqual({STANDBY: {waitTime: 30}});

    expect(live[1]).toMatchObject({status: 'REFURBISHMENT'});
    expect(rawOf(live[1])!.facilities).toBe(rollingX);

    expect(live[2]).toMatchObject({status: 'CLOSED'});
    expect(rawOf(live[2])!.facilities).toBe(wavePool);
  });

  it('attaches the facility row to each attraction, nothing to a park', async () => {
    const entities = await stubbedPark(true).getEntities();
    expect(entities.map((e) => e.id)).toEqual(['everlandresort', 'everland', 'caribbeanbay', 'FA001', 'FA002', 'FB001']);

    expect(rawOf(entities[0])).toBeUndefined();
    expect(rawOf(entities[1])).toBeUndefined();
    expect(rawOf(entities[2])).toBeUndefined();

    expect(rawOf(entities[3])).toEqual({facilities: tExpress});
    expect(rawOf(entities[3])!.facilities).toBe(tExpress);
    expect(entities[3].location).toEqual({latitude: 37.296, longitude: 127.205});

    expect(rawOf(entities[4])).toEqual({facilities: rollingX});
    expect(entities[4].location).toBeUndefined();

    expect(rawOf(entities[5])).toEqual({facilities: wavePool});
  });

  it('attaches the park-open-time entry to each schedule day', async () => {
    const schedules = await stubbedPark(true).getSchedules();
    expect(schedules.map((s) => s.id)).toEqual(['everland', 'caribbeanbay']);

    const [everlandSchedule, caribbeanSchedule] = schedules;
    expect(everlandSchedule.schedule!.map((e) => e.date)).toEqual(['2026-09-21', '2026-09-22']);

    const [day1, day2] = everlandSchedule.schedule!;
    expect(rawOf(day1)).toEqual({parkOpenTime: everlandToday});
    expect(rawOf(day1)!.parkOpenTime).toBe(everlandToday);
    expect(day1.closingTime).toBe('2026-09-21T18:00:00+09:00');

    expect(rawOf(day2)).toEqual({parkOpenTime: everlandTomorrow});
    expect(day2.closingTime).toBe('2026-09-22T20:00:00+09:00');

    expect(caribbeanSchedule.schedule!.map((e) => e.date)).toEqual(['2026-09-21']);
    expect(rawOf(caribbeanSchedule.schedule![0])).toEqual({parkOpenTime: caribbeanToday});
    expect(rawOf(caribbeanSchedule.schedule![0])!.parkOpenTime).toBe(caribbeanToday);
  });

  it('carries nothing when includeRaw is off', async () => {
    const park = stubbedPark(false);
    for (const element of await park.getLiveData()) expect(rawOf(element)).toBeUndefined();
    for (const element of await park.getEntities()) expect(rawOf(element)).toBeUndefined();
    for (const s of await park.getSchedules()) {
      for (const element of s.schedule!) expect(rawOf(element)).toBeUndefined();
    }
  });
});
