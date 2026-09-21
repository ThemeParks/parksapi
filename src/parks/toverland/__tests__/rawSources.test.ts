import {describe, it, expect, vi, beforeEach, afterEach} from 'vitest';
import {Toverland} from '../toverland.js';
import type {WithRaw} from '../../../destination.js';

/**
 * With `includeRaw` on, every live row and every entity carries the
 * ride/show/dining row it was built from, and every schedule day carries
 * the calendar day it came from. Off, nothing carries anything.
 */
const NOW = new Date('2026-09-21T10:00:00Z');

const rideFenix = {
  id: 301, name: 'Fenix', latitude: 51.398, longitude: 5.983,
  last_status: {status: {name: {en: 'Open'}}},
  last_waiting_time: {waiting_time: 20},
  opening_times: [{start: '2026-09-21 10:00:00', end: '2026-09-21 18:00:00'}],
};
const rideBooster = {
  id: 302, name: 'Booster Bike', latitude: 51.397, longitude: 5.982,
  last_status: {status: {name: {en: 'Open'}}},
  last_waiting_time: {waiting_time: 5},
  opening_times: [{start: '2026-01-01 10:00:00', end: '2026-01-01 18:00:00'}],
};
const rideNoStatus = {
  id: 303, name: 'Booster Bike VIP', latitude: 51.396, longitude: 5.981,
  last_status: null, opening_times: [],
};

const showSao = {id: 401, name: {en: 'Sao Show', nl: 'Sao Show NL'}, latitude: 51.399, longitude: 5.984};
const diningBaron = {id: 501, name: 'Restaurant De Baron', latitude: 51.4, longitude: 5.985};

const dayOperating = {dayNr: 21, openingHoursFrom: '10:00:00', openingHoursTo: '18:00:00'};
const dayInvalid = {dayNr: 22, openingHoursFrom: '00:00:00', openingHoursTo: '00:00:00'};

function stubbedPark(includeRaw: boolean): Toverland {
  const park = new Toverland();
  park.includeRaw = includeRaw;
  vi.spyOn(park as any, 'getRideData').mockResolvedValue([rideFenix, rideBooster, rideNoStatus]);
  vi.spyOn(park as any, 'getShowData').mockResolvedValue([showSao]);
  vi.spyOn(park as any, 'getDiningData').mockResolvedValue([diningBaron]);
  vi.spyOn(park as any, 'fetchCalendar').mockImplementation(async (month: any, year: any) => {
    if (month === 9 && year === 2026) {
      return {json: async () => ({days: [dayOperating, dayInvalid]})} as any;
    }
    return {json: async () => ({days: []})} as any;
  });
  return park;
}

const rawOf = (element: object) => (element as WithRaw<object>).raw;

describe('Toverland raw upstream pieces', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('attaches the ride row to each live row, drops rides without a status', async () => {
    const live = await stubbedPark(true).getLiveData();
    expect(live.map((l) => l.id)).toEqual(['301', '302']);

    expect(rawOf(live[0])).toEqual({rideData: rideFenix});
    expect(rawOf(live[0])!.rideData).toBe(rideFenix);
    expect(live[0].status).toBe('OPERATING');
    expect(live[0].queue).toEqual({STANDBY: {waitTime: 20}});

    expect(rawOf(live[1])).toEqual({rideData: rideBooster});
    expect(rawOf(live[1])!.rideData).toBe(rideBooster);
    expect(live[1].status).toBe('CLOSED');
    expect(live[1].queue).toBeUndefined();
  });

  it('attaches the source row to each ride, show and dining entity, nothing to the park', async () => {
    const entities = await stubbedPark(true).getEntities();
    expect(entities.map((e) => e.id)).toEqual(['toverlandresort', 'toverland', '301', '302', '303', 'show_401', 'dining_501']);

    expect(rawOf(entities[0])).toBeUndefined();
    expect(rawOf(entities[1])).toBeUndefined();

    expect(rawOf(entities[2])).toEqual({rideData: rideFenix});
    expect(rawOf(entities[2])!.rideData).toBe(rideFenix);
    expect(entities[2].name).toBe('Fenix');
    expect(rawOf(entities[4])!.rideData).toBe(rideNoStatus);

    expect(rawOf(entities[5])).toEqual({showData: showSao});
    expect(rawOf(entities[5])!.showData).toBe(showSao);
    expect(entities[5].name).toBe('Sao Show');

    expect(rawOf(entities[6])).toEqual({diningData: diningBaron});
    expect(rawOf(entities[6])!.diningData).toBe(diningBaron);
  });

  it('attaches the calendar day to the operating day, skips invalid windows', async () => {
    const [schedule] = await stubbedPark(true).getSchedules();
    expect(schedule.schedule).toHaveLength(1);

    const [today] = schedule.schedule;
    expect(today.date).toBe('2026-09-21');
    expect(rawOf(today)).toEqual({calendar: dayOperating});
    expect(rawOf(today)!.calendar).toBe(dayOperating);
    expect(today.openingTime).toBe('2026-09-21T10:00:00+02:00');
    expect(today.closingTime).toBe('2026-09-21T18:00:00+02:00');
  });

  it('carries nothing when includeRaw is off', async () => {
    const park = stubbedPark(false);
    for (const element of await park.getLiveData()) expect(rawOf(element)).toBeUndefined();
    for (const element of await park.getEntities()) expect(rawOf(element)).toBeUndefined();
    for (const element of (await park.getSchedules())[0].schedule) expect(rawOf(element)).toBeUndefined();
  });
});
