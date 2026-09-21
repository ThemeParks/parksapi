import {describe, test, expect, vi, beforeEach, afterEach} from 'vitest';
import {TokyoDisneyResort} from '../tokyodisneyresort.js';
import type {WithRaw} from '../../../destination.js';

/**
 * With `includeRaw` on, every element carries the upstream piece it was built
 * from: the conditions row for live data, plus the published Premier Access
 * rate where one priced the paid queue; the facilities row for an entity; and
 * the calendar row for a day, on both entries of a day that also has special
 * hours. The resort and the two parks are built from constants and carry
 * nothing. Off, nothing carries anything.
 */
const NOON_JST_UTC = '2026-06-17T03:00:00.000Z'; // 12:00 JST = parks open

const openWindow = {
  startAt: '2026-06-17T00:00:00.000Z', // 09:00 JST
  endAt: '2026-06-17T12:00:00.000Z', // 21:00 JST
  operatingStatus: 'OPEN_NOTICE',
};

const splashFacility = {
  facilityCode: 'A1',
  facilityType: 'attractions',
  name: 'Splash Mountain',
  parkType: 'TDL',
  latitude: 35.632896,
  longitude: 139.880394,
  fastpass: true,
  restrictions: [{type: 'LOWER_HEIGHT', name: '90 cm'}],
};
const mansionFacility = {
  facilityCode: 'A2',
  facilityType: 'attractions',
  name: 'Haunted Mansion',
  parkType: 'TDL',
  latitude: 35.631,
  longitude: 139.881,
};
const showFacility = {
  facilityCode: 'S1',
  facilityType: 'entertainments',
  name: 'Big Band Beat',
  parkType: 'TDS',
  latitude: 35.626411,
  longitude: 139.885099,
};
const facilities = [splashFacility, mansionFacility, showFacility];

// Splash is sold as a paid return time, so the published rate fed its queue.
const splashCondition = {
  facilityCode: 'A1',
  standbyTimeDisplayType: 'NORMAL',
  standbyTime: 45,
  premierAccessStatus: 'SELLING',
  operatings: [openWindow],
};
const mansionCondition = {
  facilityCode: 'A2',
  standbyTimeDisplayType: 'NORMAL',
  standbyTime: 20,
  operatings: [openWindow],
};
const prices = {'Splash Mountain': 2000};

// One day that also opens early for special hours, one plain day, one closure.
const tdlDay = {
  parkType: 'TDL',
  date: '2026-12-31',
  openTime: '09:00',
  closeTime: '21:00',
  closedDay: false,
  spOpenTime: '08:00',
  spCloseTime: '09:00',
  undecided: false,
};
const tdsDay = {
  parkType: 'TDS',
  date: '2026-12-31',
  openTime: '09:00',
  closeTime: '21:00',
  closedDay: false,
  spOpenTime: '',
  spCloseTime: '',
  undecided: false,
};
const closedDay = {parkType: 'TDL', date: '2027-01-01', closedDay: true};

function stubbedPark(includeRaw: boolean): TokyoDisneyResort {
  const park = new TokyoDisneyResort({});
  park.includeRaw = includeRaw;
  vi.spyOn(park, 'getFacilities').mockResolvedValue(facilities as any);
  vi.spyOn(park, 'getConditions').mockResolvedValue({
    attractions: [splashCondition, mansionCondition],
  } as any);
  vi.spyOn(park, 'getPremierAccessPrices').mockResolvedValue(prices);
  vi.spyOn(park, 'getCalendar').mockResolvedValue([tdlDay, tdsDay, closedDay] as any);
  return park;
}

const rawOf = (element: object) => (element as WithRaw<object>).raw;

describe('Tokyo Disney Resort raw upstream pieces', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOON_JST_UTC));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  test('attaches the conditions row to each live element and the rate where one priced the queue', async () => {
    const live = await stubbedPark(true).getLiveData();
    expect(live.map((l) => l.id)).toEqual(['A1', 'A2']);

    expect(rawOf(live[0])).toEqual({conditions: splashCondition, premierAccessPrices: 2000});
    expect(rawOf(live[0])!.conditions).toBe(splashCondition);
    expect(live[0].queue!.STANDBY).toEqual({waitTime: 45});
    expect(live[0].queue!.PAID_RETURN_TIME!.price).toMatchObject({amount: 2000, currency: 'JPY'});

    // No paid queue, so no rate contributed anything to this one.
    expect(rawOf(live[1])).toEqual({conditions: mansionCondition});
    expect(rawOf(live[1])!.conditions).toBe(mansionCondition);
    expect(live[1].queue!.STANDBY).toEqual({waitTime: 20});
  });

  test('attaches the facilities row to every attraction and show, nothing to resort or parks', async () => {
    const entities = await stubbedPark(true).getEntities();
    expect(entities.map((e) => e.id)).toEqual(['tdr', 'tdl', 'tds', 'A1', 'A2', 'S1']);

    // Resort and parks come from constants in this module.
    expect(rawOf(entities[0])).toBeUndefined();
    expect(rawOf(entities[1])).toBeUndefined();
    expect(rawOf(entities[2])).toBeUndefined();

    expect(rawOf(entities[3])).toEqual({facilities: splashFacility});
    expect(rawOf(entities[3])!.facilities).toBe(splashFacility);
    expect(entities[3].name).toBe('Splash Mountain');

    expect(rawOf(entities[4])!.facilities).toBe(mansionFacility);

    expect(rawOf(entities[5])).toEqual({facilities: showFacility});
    expect(rawOf(entities[5])!.facilities).toBe(showFacility);
    expect(entities[5].parentId).toBe('tds');
  });

  test('attaches the calendar row to both entries of a day with special hours', async () => {
    const schedules = await stubbedPark(true).getSchedules();
    expect(schedules.map((s) => s.id)).toEqual(['tdl', 'tds']);

    const [operating, extra] = schedules[0].schedule;
    expect(operating.type).toBe('OPERATING');
    expect(extra.type).toBe('EXTRA_HOURS');
    expect(rawOf(operating)).toEqual({calendar: tdlDay});
    expect(rawOf(operating)!.calendar).toBe(tdlDay);
    // The one calendar row produced both entries of the day.
    expect(rawOf(extra)!.calendar).toBe(tdlDay);
    expect(operating.openingTime).toBe('2026-12-31T09:00:00+09:00');
    expect(extra.openingTime).toBe('2026-12-31T08:00:00+09:00');

    expect(rawOf(schedules[1].schedule[0])!.calendar).toBe(tdsDay);
  });

  test('carries nothing when includeRaw is off', async () => {
    const park = stubbedPark(false);
    for (const element of await park.getLiveData()) expect(rawOf(element)).toBeUndefined();
    for (const element of await park.getEntities()) expect(rawOf(element)).toBeUndefined();
    for (const schedule of await park.getSchedules()) {
      for (const element of schedule.schedule) expect(rawOf(element)).toBeUndefined();
    }
  });
});
