import {describe, it, expect, vi, beforeEach, afterEach} from 'vitest';
import {Cotaland} from '../cotaland.js';
import {CacheLib} from '../../../cache.js';
import type {WithRaw} from '../../../destination.js';
import type {HTTPObj} from '../../../http.js';

/**
 * With `includeRaw` on, every entity and every live row carries its point from
 * the app's feed, and a row the open calendar decided (an "Open" point without
 * a positive wait) also carries the calendar event in effect. A row the
 * calendar closed carries its point alone, because no single event says the
 * park is shut. Every schedule entry carries its calendar event. The
 * destination and the park, built from constants, carry nothing. Off, nothing
 * carries anything.
 */
// 12:00 in Austin, inside Saturday's block of hours
const OPEN_NOW = new Date('2026-10-03T17:00:00Z');
// 22:00 in Austin on the Friday before, with no block of hours
const CLOSED_NOW = new Date('2026-10-03T03:00:00Z');

const ATTRACTIONS = [{id: 41, name: 'Attractions'}];

// "Open" with no wait: only the calendar decides this one
const circuitBreaker = {id: 6181, name: 'Circuit Breaker ', status: 'Open', waitTime: null, latitude: 30.133144, longitude: -97.645005, categories: ATTRACTIONS, isActive: true};
// A positive wait is a live reading of its own
const fastLap = {id: 6182, name: 'Fast Lap', status: 'Open', waitTime: 15, latitude: 30.1335, longitude: -97.6452, categories: ATTRACTIONS, isActive: true};
const pitStop = {id: 6183, name: 'Pit Stop', status: 'Down', waitTime: null, latitude: 30.1338, longitude: -97.6455, categories: ATTRACTIONS, isActive: true};
// Not published at all
const restroom = {id: 7000, name: 'Restroom', status: 'Open', waitTime: 0, categories: [{id: 50, name: 'Restrooms'}], isActive: true};

const saturdayHours = {id: 901, title: 'Park Open', start_date: '2026-10-03 10:00:00', end_date: '2026-10-03 18:00:00', all_day: false, timezone: 'America/Chicago'};
const sundayBlackout = {id: 902, title: 'F1 Weekend Blackout (Must Have F1 Ticket)', start_date: '2026-10-04 10:00:00', end_date: '2026-10-04 17:00:00', all_day: false, timezone: 'America/Chicago'};

function stubbedPark(includeRaw: boolean, now: Date): Cotaland {
  const park = new Cotaland({config: {apiBase: 'https://app.example.invalid', webBase: 'https://web.example.invalid'}});
  park.includeRaw = includeRaw;
  const feed = {
    timestamp: new Date(now.getTime() - 2 * 60_000).toISOString(),
    data: [circuitBreaker, fastLap, pitStop, restroom],
  };
  vi.spyOn(park, 'fetchPointsOfInterest').mockResolvedValue({json: async () => feed} as any as HTTPObj);
  vi.spyOn(park, 'fetchCalendarPage').mockResolvedValue({
    json: async () => ({events: [saturdayHours, sundayBlackout], total_pages: 1}),
  } as any as HTTPObj);
  return park;
}

const rawOf = (element: object) => (element as WithRaw<object>).raw;

describe('COTALAND raw upstream pieces', () => {
  beforeEach(() => {
    CacheLib.clear();
    vi.useFakeTimers({toFake: ['Date']});
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    CacheLib.clear();
  });

  it('attaches the point to each live row, and the event in effect where the calendar decided', async () => {
    vi.setSystemTime(OPEN_NOW);
    const live = await stubbedPark(true, OPEN_NOW).getLiveData();
    expect(live.map((l) => l.id)).toEqual(['6181', '6182', '6183']);

    expect(live[0].status).toBe('OPERATING');
    expect(live[0].queue).toBeUndefined();
    expect(rawOf(live[0])).toEqual({pointsOfInterest: circuitBreaker, calendarPage: saturdayHours});
    expect(rawOf(live[0])!.pointsOfInterest).toBe(circuitBreaker);
    expect(rawOf(live[0])!.calendarPage).toBe(saturdayHours);

    expect(live[1].queue).toEqual({STANDBY: {waitTime: 15}});
    expect(rawOf(live[1])).toEqual({pointsOfInterest: fastLap});
    expect(rawOf(live[1])!.pointsOfInterest).toBe(fastLap);

    expect(live[2].status).toBe('DOWN');
    expect(rawOf(live[2])).toEqual({pointsOfInterest: pitStop});
  });

  it('attaches only the point to a row the calendar closed', async () => {
    vi.setSystemTime(CLOSED_NOW);
    const live = await stubbedPark(true, CLOSED_NOW).getLiveData();
    const closed = live.find((l) => l.id === '6181')!;

    expect(closed.status).toBe('CLOSED');
    expect(rawOf(closed)).toEqual({pointsOfInterest: circuitBreaker});
    expect(rawOf(closed)!.pointsOfInterest).toBe(circuitBreaker);
  });

  it('attaches the point to each entity, nothing to the destination or the park', async () => {
    vi.setSystemTime(OPEN_NOW);
    const entities = await stubbedPark(true, OPEN_NOW).getEntities();
    expect(entities.map((e) => e.id)).toEqual(['cotaland', 'cotaland-park', '6181', '6182', '6183']);

    expect(rawOf(entities[0])).toBeUndefined();
    expect(rawOf(entities[1])).toBeUndefined();

    expect(entities[2].name).toBe('Circuit Breaker');
    expect(rawOf(entities[2])).toEqual({pointsOfInterest: circuitBreaker});
    expect(rawOf(entities[2])!.pointsOfInterest).toBe(circuitBreaker);
    expect(rawOf(entities[4])!.pointsOfInterest).toBe(pitStop);
  });

  it('attaches the calendar event to each schedule entry', async () => {
    vi.setSystemTime(OPEN_NOW);
    const [schedule] = await stubbedPark(true, OPEN_NOW).getSchedules();
    expect(schedule.schedule.map((e) => e.date)).toEqual(['2026-10-03', '2026-10-04']);

    const [saturday, sunday] = schedule.schedule;
    expect(saturday.openingTime).toBe('2026-10-03T10:00:00-05:00');
    expect(rawOf(saturday)).toEqual({calendarPage: saturdayHours});
    expect(rawOf(saturday)!.calendarPage).toBe(saturdayHours);

    expect(sunday.description).toBe('F1 Weekend Blackout (Must Have F1 Ticket)');
    expect(rawOf(sunday)).toEqual({calendarPage: sundayBlackout});
    expect(rawOf(sunday)!.calendarPage).toBe(sundayBlackout);
  });

  it('carries nothing when includeRaw is off', async () => {
    vi.setSystemTime(OPEN_NOW);
    const park = stubbedPark(false, OPEN_NOW);
    for (const element of await park.getLiveData()) expect(rawOf(element)).toBeUndefined();
    for (const element of await park.getEntities()) expect(rawOf(element)).toBeUndefined();
    for (const element of (await park.getSchedules())[0].schedule) expect(rawOf(element)).toBeUndefined();
  });
});
