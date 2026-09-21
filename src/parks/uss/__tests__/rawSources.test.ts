import {describe, test, expect, vi, beforeEach, afterEach} from 'vitest';
import {UniversalSingapore} from '../universalsingapore.js';
import {CacheLib} from '../../../cache.js';
import type {WithRaw} from '../../../destination.js';

/**
 * With `includeRaw` on, every element carries the upstream piece it was built
 * from: the attraction-list entry for a live row and for an entity, and for a
 * schedule entry the day object out of the website's embedded JSON plus the
 * availability entry of the calendar API, where that API covers the day. The
 * destination and the park are built from constants and carry nothing. Off,
 * nothing carries anything.
 */
const NOW = new Date('2026-09-21T04:00:00Z'); // 12:00 in Singapore

const ride = {
  AttractionId: 101,
  AttractionCategoryId: 1,
  Title: 'Battlestar Galactica: HUMAN',
  WaitTime: '25',
  isWaitTimeEnable: true,
  IsAvailable: true,
  AvgTime: 20,
  LatLng: '103.8215,1.2539',
  ReasonCode: '',
};
const unavailableRide = {
  AttractionId: 102,
  AttractionCategoryId: 1,
  Title: '[Temporarily unavailable] Revenge of the Mummy',
  WaitTime: '10:00AM',
  isWaitTimeEnable: false,
  IsAvailable: false,
  AvgTime: 0,
  LatLng: '103.8221,1.2545',
  ReasonCode: '',
};
const show = {
  AttractionId: 201,
  AttractionCategoryId: 2,
  Title: 'WaterWorld',
  WaitTime: '',
  isWaitTimeEnable: false,
  IsAvailable: true,
  AvgTime: 0,
  LatLng: '103.8230,1.2550',
  ReasonCode: '',
  OperatingHours: '01:30 PM | 03:30 PM',
};
const attractionsByCategory: Record<number, unknown[]> = {1: [ride, unavailableRide], 2: [show], 3: []};

// The day objects the website page embeds, as parseMonthsFromHtml hands them on.
const openDay = {Number: '21', StartHour: '10:00', EndHour: '20:00', Activities: []};
const closedDay = {Number: '22', StartHour: '11:00', EndHour: '19:00', Activities: []};
const uncoveredDay = {Number: '23', StartHour: '10:00', EndHour: '18:00', Activities: []};
const hoursEntries: [string, {start: string; end: string; day: unknown}][] = [
  ['2026-09-21', {start: '10:00', end: '20:00', day: openDay}],
  ['2026-09-22', {start: '11:00', end: '19:00', day: closedDay}],
  ['2026-09-23', {start: '10:00', end: '18:00', day: uncoveredDay}],
];

// The calendar API covers the first two days only.
const availableEntry = {Date: '2026-09-21', IsAvailable: true};
const unavailableEntry = {Date: '2026-09-22', IsAvailable: false};

const websiteHtml =
  '<html><script>{"months":{"Months":[{"Value":"9","Name":"September","Year":"2026",' +
  '"Days":[{"Number":"21","StartHour":"10:00","EndHour":"20:00","Activities":[]}]}]}}</script></html>';

function stubbedPark(includeRaw: boolean): UniversalSingapore {
  const park = new UniversalSingapore({config: {websiteBase: 'https://rws.example'}});
  park.includeRaw = includeRaw;
  vi.spyOn(park as any, '_init').mockResolvedValue(undefined);
  vi.spyOn(park, 'getAttractionEntities').mockImplementation(
    async (categoryId: number) => attractionsByCategory[categoryId] as any,
  );
  vi.spyOn(park, 'getAttractionLiveData').mockImplementation(
    async (categoryId: number) => attractionsByCategory[categoryId] as any,
  );
  vi.spyOn(park, 'getCalendar').mockImplementation(
    async (fromDate: string) => (fromDate === '2026-09-21' ? [availableEntry, unavailableEntry] : []),
  );
  vi.spyOn(park, 'getHoursMap').mockResolvedValue(hoursEntries as any);
  return park;
}

const rawOf = (element: object) => (element as WithRaw<object>).raw;

describe('Universal Singapore raw upstream pieces', () => {
  beforeEach(() => {
    // getHoursMap is cached and takes no arguments, so every instance shares
    // one key — the parser cases below would otherwise read each other's result.
    CacheLib.clearByClassName('UniversalSingapore');
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  test('attaches the attraction-list entry to every live row', async () => {
    const live = await stubbedPark(true).getLiveData();
    expect(live.map((l) => l.id)).toEqual(['101', '102', '201']);

    expect(rawOf(live[0])).toEqual({attractionList: ride});
    expect(rawOf(live[0])!.attractionList).toBe(ride);
    expect(live[0].queue).toEqual({STANDBY: {waitTime: 25}});

    expect(rawOf(live[1])).toEqual({attractionList: unavailableRide});
    expect(rawOf(live[1])!.attractionList).toBe(unavailableRide);
    expect(live[1].status).toBe('DOWN');

    expect(rawOf(live[2])!.attractionList).toBe(show);
    expect((live[2] as any).showtimes.map((s: any) => s.startTime)).toEqual([
      '2026-09-21T13:30:00+08:00',
      '2026-09-21T15:30:00+08:00',
    ]);
  });

  test('attaches the attraction-list entry to every child, nothing to destination or park', async () => {
    const entities = await stubbedPark(true).getEntities();
    expect(entities.map((e) => e.id)).toEqual(['universalsingapore', 'uss.uss', '101', '102', '201']);

    // Both are built from constants in this module.
    expect(rawOf(entities[0])).toBeUndefined();
    expect(rawOf(entities[1])).toBeUndefined();

    expect(rawOf(entities[2])).toEqual({attractionList: ride});
    expect(rawOf(entities[2])!.attractionList).toBe(ride);

    expect(rawOf(entities[3])!.attractionList).toBe(unavailableRide);
    expect(entities[3].name).toBe('Revenge of the Mummy');

    expect(rawOf(entities[4])).toEqual({attractionList: show});
    expect(entities[4].entityType).toBe('SHOW');
  });

  test('attaches the page day and, where the calendar covers it, its entry', async () => {
    const schedules = await stubbedPark(true).getSchedules();
    expect(schedules.map((s) => s.id)).toEqual(['uss.uss']);
    // The 22nd is explicitly unavailable, so no entry exists for it.
    expect(schedules[0].schedule.map((e) => e.date)).toEqual(['2026-09-21', '2026-09-23']);

    const [covered, uncovered] = schedules[0].schedule;
    expect(rawOf(covered)).toEqual({websitePage: openDay, calendarApi: availableEntry});
    expect(rawOf(covered)!.websitePage).toBe(openDay);
    expect(rawOf(covered)!.calendarApi).toBe(availableEntry);
    expect(covered.openingTime).toBe('2026-09-21T10:00:00+08:00');
    expect(covered.closingTime).toBe('2026-09-21T20:00:00+08:00');

    // Beyond the calendar API's window, so only the page said anything.
    expect(rawOf(uncovered)).toEqual({websitePage: uncoveredDay});
    expect(rawOf(uncovered)!.websitePage).toBe(uncoveredDay);
    expect(uncovered.closingTime).toBe('2026-09-23T18:00:00+08:00');
  });

  test('the page parser carries the day object when asked', async () => {
    const park = new UniversalSingapore({config: {websiteBase: 'https://rws.example'}});
    park.includeRaw = true;
    vi.spyOn(park as any, 'fetchWebsitePage').mockResolvedValue({text: async () => websiteHtml} as any);

    expect(await park.getHoursMap()).toEqual([
      ['2026-09-21', {start: '10:00', end: '20:00', day: openDay}],
    ]);
  });

  test('the page parser leaves the day object out by default', async () => {
    const park = new UniversalSingapore({config: {websiteBase: 'https://rws.example'}});
    vi.spyOn(park as any, 'fetchWebsitePage').mockResolvedValue({text: async () => websiteHtml} as any);

    expect(await park.getHoursMap()).toEqual([['2026-09-21', {start: '10:00', end: '20:00'}]]);
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
