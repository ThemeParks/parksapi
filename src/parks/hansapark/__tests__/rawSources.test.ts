import {describe, test, expect, vi, beforeEach, afterEach} from 'vitest';
import {HansaPark} from '../hansapark.js';
import type {WithRaw} from '../../../destination.js';

/**
 * With `includeRaw` on, every element carries the upstream piece it was built
 * from: the attractions entry for an entity and the season for every day that
 * season covers. The destination and the park are built from literals and
 * carry nothing, and the park publishes no live data at all. Off, nothing
 * carries anything.
 */
const NOW = new Date('2026-07-08T10:00:00Z');

const coaster = {id: 42, name: 'Nova Coaster', categories: [{name: 'Attractions'}]};
const show = {id: 43, name: 'Harbour Show', categories: [{name: 'Shows'}]};
const restaurant = {id: 44, name: 'Harbour Kitchen', categories: [{name: 'Restaurants'}]};
const shop = {id: 45, name: 'Souvenir Shop', categories: [{name: 'Shops'}]};

// Two days of this season fall inside the six-month window from "now"; the
// closed season that follows it produces no days at all.
const summerSeason = {
  id: 1,
  seasonStart: Date.UTC(2026, 6, 1) / 1000,
  seasonEnd: Date.UTC(2026, 6, 10) / 1000,
  isParkClosed: false,
  showOpeningHoursInCalendar: true,
  parkOpeningHoursFrom: '10:00',
  parkOpeningHoursTo: '18:00',
};
const closedSeason = {
  id: 2,
  seasonStart: Date.UTC(2026, 6, 11) / 1000,
  seasonEnd: Date.UTC(2026, 6, 20) / 1000,
  isParkClosed: true,
  showOpeningHoursInCalendar: true,
  parkOpeningHoursFrom: '10:00',
  parkOpeningHoursTo: '18:00',
};

function stubbedPark(includeRaw: boolean): HansaPark {
  const park = new HansaPark();
  park.includeRaw = includeRaw;
  vi.spyOn(park, 'getAttractions').mockResolvedValue([coaster, show, restaurant, shop]);
  vi.spyOn(park, 'getSeasons').mockResolvedValue([summerSeason, closedSeason]);
  return park;
}

const rawOf = (element: object) => (element as WithRaw<object>).raw;

describe('Hansa-Park raw upstream pieces', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  test('attaches the attractions entry to every child, nothing to destination or park', async () => {
    const entities = await stubbedPark(true).getEntities();
    expect(entities.map((e) => e.id)).toEqual(['hansa-park-resort', 'hansa-park', '42', '43', '44']);

    // Destination and park come from literals in this module.
    expect(rawOf(entities[0])).toBeUndefined();
    expect(rawOf(entities[1])).toBeUndefined();

    expect(rawOf(entities[2])).toEqual({attractions: coaster});
    expect(rawOf(entities[2])!.attractions).toBe(coaster);
    expect(entities[2].name).toBe('Nova Coaster');

    expect(rawOf(entities[3])!.attractions).toBe(show);
    expect(entities[3].entityType).toBe('SHOW');

    expect(rawOf(entities[4])).toEqual({attractions: restaurant});
    expect(rawOf(entities[4])!.attractions).toBe(restaurant);
  });

  test('attaches the same season object to every day it covers', async () => {
    const [schedule] = await stubbedPark(true).getSchedules();
    expect(schedule.schedule.map((e) => e.date)).toEqual(['2026-07-08', '2026-07-09']);

    expect(rawOf(schedule.schedule[0])).toEqual({seasons: summerSeason});
    expect(rawOf(schedule.schedule[0])!.seasons).toBe(summerSeason);
    // One season produced both days, so both carry the very same object.
    expect(rawOf(schedule.schedule[1])!.seasons).toBe(summerSeason);
    expect(schedule.schedule[0].openingTime).toBe('2026-07-08T10:00:00+02:00');
    expect(schedule.schedule[1].closingTime).toBe('2026-07-09T18:00:00+02:00');
  });

  test('publishes no live data, so there is nothing to attach', async () => {
    expect(await stubbedPark(true).getLiveData()).toEqual([]);
  });

  test('carries nothing when includeRaw is off', async () => {
    const park = stubbedPark(false);
    for (const element of await park.getEntities()) expect(rawOf(element)).toBeUndefined();
    for (const element of (await park.getSchedules())[0].schedule) expect(rawOf(element)).toBeUndefined();
  });
});
