import {describe, test, expect, vi, beforeEach, afterEach} from 'vitest';
import {AttractionsIOV1, HeidePark, DjursSommerland} from '../attractionsiov1.js';
import {CacheLib} from '../../../cache.js';
import type {WithRaw} from '../../../destination.js';

/**
 * With `includeRaw` on, every element carries the upstream piece it was built
 * from: the live-feed record for an attraction or a restaurant, the records.json
 * item for a show and for every entity, the resort record for the destination
 * and the park, and the calendar entry for a day — `calendar` for the standard
 * calendar API, `heideParkSchedule` for Heide Park's own endpoint and
 * `calendarHTML` for the object Djurs Sommerland's page carries. Off, nothing
 * carries anything.
 */
const TZ = 'Europe/Berlin';
const DATE = '2026-07-08';

// Berlin is +02:00 in July, so 12:00 local == 10:00Z.
const NOON = new Date('2026-07-08T10:00:00Z');

const range = (open: string, close: string) =>
  JSON.stringify({type: 'range', start: `${DATE} ${open}`, end: `${DATE} ${close}`});

// A daily point-start show (no range_length) at the given wall-clock time.
const pointShow = (time: string) =>
  JSON.stringify({type: 'period', offset_date: `2020-01-01 ${time}`, period_length: {day: 1}});

const resort = {_id: 1, Name: 'Probe Resort', Location: '52.90,9.85'};
const coaster = {_id: 100, Name: 'Raw Coaster', Category: 10, MinimumHeightRequirement: 1.2};
const show = {_id: 200, Name: 'Raw Show', Category: 20, ShowTimes: pointShow('14:00:00')};
const diner = {_id: 300, Name: 'Raw Diner', Category: 30};

const records = {
  Resort: [resort],
  Category: [
    {_id: 10, Name: 'Rides'},
    {_id: 20, Name: 'Shows'},
    {_id: 30, Name: 'Restaurants'},
  ],
  Item: [coaster, show, diner],
};

const coasterRecord = {_id: 100, IsOperational: true, QueueTime: 1800};
const dinerRecord = {_id: 300, IsOpen: true, OpeningTimes: range('10:00:00', '20:00:00')};
const liveResponse = {entities: {Item: {records: [coasterRecord, dinerRecord]}}};

const calendarDay = {key: '20260708', openingHours: '10am - 6pm'};
const calendarNextDay = {key: '20260709', openingHours: '9:30am - 7pm'};

class Probe extends AttractionsIOV1 {
  constructor() {
    super({config: {destinationId: 'rawprobe-resort', parkId: 'rawprobe-park', timezone: TZ}});
  }
}

function stubbedProbe(includeRaw: boolean): Probe {
  const park = new Probe();
  park.includeRaw = includeRaw;
  vi.spyOn(park as any, 'getPOIData').mockResolvedValue(records);
  vi.spyOn(park as any, 'fetchLiveData').mockResolvedValue({json: async () => liveResponse});
  vi.spyOn(park as any, 'fetchCalendar').mockResolvedValue({
    json: async () => ({Locations: [{days: [calendarDay, calendarNextDay]}]}),
  });
  return park;
}

const heideDay = {date: '2026-07-08', status: 'open', openingTimes: {open: '10:00', close: '18:00'}};
const heideClosedDay = {date: '2026-07-09', status: 'closed'};

function stubbedHeidePark(includeRaw: boolean): HeidePark {
  const park = new HeidePark();
  park.includeRaw = includeRaw;
  vi.spyOn(park as any, 'fetchHeideParkSchedule').mockResolvedValue({
    json: async () => ({openingTimes: [heideDay, heideClosedDay]}),
  });
  return park;
}

// dayIndex encoding: monthIndex * 31 + (dayOfMonth - 1), so July 8 and 9 of the
// current year are 193 and 194.
const djursEvent = {type: 1, start: '10:00', end: '18:00', days: {ranges: [193, 194]}};
const djursHTML =
  `<html><body data-model='${JSON.stringify({parkEvents: [djursEvent]}).replace(/"/g, '&quot;')}'>` +
  '</body></html>';

function stubbedDjurs(includeRaw: boolean): DjursSommerland {
  const park = new DjursSommerland();
  park.includeRaw = includeRaw;
  vi.spyOn(park as any, 'fetchCalendarHTML').mockResolvedValue({text: async () => djursHTML});
  return park;
}

const rawOf = (element: object) => (element as WithRaw<object>).raw;

describe('Attractions.io raw upstream pieces', () => {
  beforeEach(() => {
    // getCategoryIDs is @cache-decorated; clear between tests so one case
    // cannot leak category ids into the next.
    CacheLib.clearAll();
    vi.useFakeTimers();
    vi.setSystemTime(NOON);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  test('attaches the live record to rides and restaurants and the records item to shows', async () => {
    const live = await stubbedProbe(true).getLiveData();
    expect(live.map((l) => l.id)).toEqual(['100', '300', '200']);

    expect(rawOf(live[0])).toEqual({liveData: coasterRecord});
    expect(rawOf(live[0])!.liveData).toBe(coasterRecord);
    expect(live[0].queue).toEqual({STANDBY: {waitTime: 30}});

    expect(rawOf(live[1])).toEqual({liveData: dinerRecord});
    expect(rawOf(live[1])!.liveData).toBe(dinerRecord);
    expect(live[1].status).toBe('OPERATING');

    expect(rawOf(live[2])).toEqual({poiData: show});
    expect(rawOf(live[2])!.poiData).toBe(show);
    expect(live[2].showtimes).toHaveLength(1);
  });

  test('attaches the resort record to the destination and the park, the item to every child', async () => {
    const entities = await stubbedProbe(true).getEntities();
    expect(entities.map((e) => e.id)).toEqual(['rawprobe-resort', 'rawprobe-park', '100', '200', '300']);

    expect(rawOf(entities[0])).toEqual({poiData: resort});
    expect(rawOf(entities[0])!.poiData).toBe(resort);

    expect(rawOf(entities[1])).toEqual({poiData: resort});
    expect(rawOf(entities[1])!.poiData).toBe(resort);
    expect(entities[1].name).toBe('Probe');

    expect(rawOf(entities[2])).toEqual({poiData: coaster});
    expect(rawOf(entities[2])!.poiData).toBe(coaster);
    expect(entities[2].name).toBe('Raw Coaster');

    expect(rawOf(entities[3])!.poiData).toBe(show);
    expect(rawOf(entities[4])!.poiData).toBe(diner);
  });

  test('attaches the calendar day to each day of the standard calendar', async () => {
    const [schedule] = await stubbedProbe(true).getSchedules();
    expect(schedule.schedule.map((e) => e.date)).toEqual(['2026-07-08', '2026-07-09']);

    expect(rawOf(schedule.schedule[0])).toEqual({calendar: calendarDay});
    expect(rawOf(schedule.schedule[0])!.calendar).toBe(calendarDay);
    expect(schedule.schedule[0].closingTime).toBe('2026-07-08T18:00:00+02:00');

    expect(rawOf(schedule.schedule[1])!.calendar).toBe(calendarNextDay);
    expect(schedule.schedule[1].openingTime).toBe('2026-07-09T09:30:00+02:00');
  });

  test('attaches the opening-times entry to each Heide Park day', async () => {
    const [schedule] = await stubbedHeidePark(true).getSchedules();
    expect(schedule.schedule.map((e) => e.date)).toEqual(['2026-07-08']);

    expect(rawOf(schedule.schedule[0])).toEqual({heideParkSchedule: heideDay});
    expect(rawOf(schedule.schedule[0])!.heideParkSchedule).toBe(heideDay);
    expect(schedule.schedule[0].openingTime).toBe('2026-07-08T10:00:00+02:00');
  });

  test('attaches the same Djurs Sommerland event object to every day it covers', async () => {
    const [schedule] = await stubbedDjurs(true).getSchedules();
    expect(schedule.schedule.map((e) => e.date)).toEqual(['2026-07-08', '2026-07-09']);

    expect(rawOf(schedule.schedule[0])).toEqual({calendarHTML: djursEvent});
    expect(rawOf(schedule.schedule[1])).toEqual({calendarHTML: djursEvent});
    // One event produced both days, so both carry the very same object.
    expect(rawOf(schedule.schedule[0])!.calendarHTML).toBe(rawOf(schedule.schedule[1])!.calendarHTML);
    expect(schedule.schedule[0].closingTime).toBe('2026-07-08T18:00:00+02:00');
  });

  test('carries nothing when includeRaw is off', async () => {
    const park = stubbedProbe(false);
    for (const element of await park.getLiveData()) expect(rawOf(element)).toBeUndefined();
    for (const element of await park.getEntities()) expect(rawOf(element)).toBeUndefined();
    for (const element of (await park.getSchedules())[0].schedule) expect(rawOf(element)).toBeUndefined();

    for (const element of (await stubbedHeidePark(false).getSchedules())[0].schedule) {
      expect(rawOf(element)).toBeUndefined();
    }
    for (const element of (await stubbedDjurs(false).getSchedules())[0].schedule) {
      expect(rawOf(element)).toBeUndefined();
    }
  });
});
