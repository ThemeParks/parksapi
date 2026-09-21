import {describe, it, expect, vi, beforeEach, afterEach} from 'vitest';
import {FujiQHighland} from '../fujiq.js';
import type {WithRaw} from '../../../destination.js';

/**
 * With `includeRaw` on, every element carries the upstream piece it was
 * built from: the crawler entry for live data, the facility entry for an
 * entity, the parsed schedule row for a normal schedule day, and the list of
 * contributing `scheduleToday` strings for the single-day fallback. Off,
 * nothing carries anything.
 */
const NOW = new Date('2026-09-21T10:00:00Z');

const fujiyama = {id: 1, facilityCode: 'FQ001', type: 'attraction', name: 'Fujiyama', lat: 35.488, lon: 138.781, feature: {heightLimit: '110cm以上'}, priorityPass: true, scheduleToday: '9:00~18:00'};
const dodonpa = {id: 2, facilityCode: 'FQ002', type: 'attraction', name: 'Dodonpa', lat: 35.4875, lon: 138.7805, feature: {}, priorityPass: false, scheduleToday: '10:00~17:00'};
const diner = {id: 3, facilityCode: 'FQ101', type: 'foodAndRestaurant', name: 'Highland Diner', lat: 35.487, lon: 138.78, scheduleToday: '11:00~15:00'};

const crawlerFujiyama = {facilityId: 'FQ001', inOperation: true, waitingFor: '15分以内'};
const crawlerDodonpa = {facilityId: 'FQ002', inOperation: false, waitingFor: '施設点検'};

function stubbedPark(includeRaw: boolean): FujiQHighland {
  const park = new FujiQHighland();
  park.includeRaw = includeRaw;
  park.scheduleMonthsAhead = 1;
  vi.spyOn(park as any, 'getCrawler').mockResolvedValue([crawlerFujiyama, crawlerDodonpa]);
  vi.spyOn(park as any, 'getFacilities').mockResolvedValue([fujiyama, dodonpa, diner]);
  return park;
}

const rawOf = (element: object) => (element as WithRaw<object>).raw;

describe('FujiQHighland raw upstream pieces', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('attaches the crawler entry to each live row', async () => {
    const park = stubbedPark(true);
    vi.spyOn(park as any, 'getMonthSchedule').mockResolvedValue([]);
    const live = await park.getLiveData();
    expect(live.map((l) => l.id)).toEqual(['FQ001', 'FQ002']);

    expect(rawOf(live[0])).toEqual({crawler: crawlerFujiyama});
    expect(rawOf(live[0])!.crawler).toBe(crawlerFujiyama);
    expect(live[0].queue).toEqual({STANDBY: {waitTime: 15}});

    expect(live[1]).toMatchObject({status: 'REFURBISHMENT'});
    expect(rawOf(live[1])!.crawler).toBe(crawlerDodonpa);
  });

  it('attaches the facility entry to each attraction and restaurant, nothing to the park', async () => {
    const park = stubbedPark(true);
    vi.spyOn(park as any, 'getMonthSchedule').mockResolvedValue([]);
    const entities = await park.getEntities();
    expect(entities.map((e) => e.id)).toEqual(['fujiqhighland', 'fujiqhighland-park', 'FQ001', 'FQ002', 'FQ101']);

    expect(rawOf(entities[0])).toBeUndefined();
    expect(rawOf(entities[1])).toBeUndefined();

    expect(rawOf(entities[2])).toEqual({facilities: fujiyama});
    expect(rawOf(entities[2])!.facilities).toBe(fujiyama);
    expect(entities[2].location).toEqual({latitude: 35.488, longitude: 138.781});
    expect(entities[2].tags).toHaveLength(2);

    expect(rawOf(entities[3])).toEqual({facilities: dodonpa});
    expect(entities[3].tags).toBeUndefined();

    expect(rawOf(entities[4])).toEqual({facilities: diner});
    expect(rawOf(entities[4])!.facilities).toBe(diner);
  });

  it('attaches the parsed schedule row to each normal schedule day', async () => {
    const park = stubbedPark(true);
    const septToday = {date: '2026-09-21', open: '09:00', close: '18:00'};
    const septTomorrow = {date: '2026-09-22', open: '09:00', close: '19:00'};
    vi.spyOn(park as any, 'getMonthSchedule').mockResolvedValue([septToday, septTomorrow]);

    const [schedule] = await park.getSchedules();
    expect(schedule.schedule!.map((e) => e.date)).toEqual(['2026-09-21', '2026-09-22']);

    const [day1, day2] = schedule.schedule!;
    expect(rawOf(day1)).toEqual({scheduleHtml: septToday});
    expect(rawOf(day1)!.scheduleHtml).toBe(septToday);
    expect(day1.closingTime).toBe('2026-09-21T18:00:00+09:00');

    expect(rawOf(day2)).toEqual({scheduleHtml: septTomorrow});
    expect(day2.closingTime).toBe('2026-09-22T19:00:00+09:00');
  });

  it('falls back to a single day built from the contributing scheduleToday strings', async () => {
    const park = stubbedPark(true);
    vi.spyOn(park as any, 'getMonthSchedule').mockResolvedValue([]);

    const [schedule] = await park.getSchedules();
    expect(schedule.schedule!.map((e) => e.date)).toEqual(['2026-09-21']);

    const [day] = schedule.schedule!;
    expect(rawOf(day)).toEqual({facilities: [fujiyama.scheduleToday, dodonpa.scheduleToday]});
    expect(day.openingTime).toBe('2026-09-21T09:00:00+09:00');
    expect(day.closingTime).toBe('2026-09-21T18:00:00+09:00');
  });

  it('carries nothing when includeRaw is off', async () => {
    const park = stubbedPark(false);
    vi.spyOn(park as any, 'getMonthSchedule').mockResolvedValue([]);
    for (const element of await park.getLiveData()) expect(rawOf(element)).toBeUndefined();
    for (const element of await park.getEntities()) expect(rawOf(element)).toBeUndefined();
    for (const element of (await park.getSchedules())[0].schedule!) expect(rawOf(element)).toBeUndefined();
  });
});
