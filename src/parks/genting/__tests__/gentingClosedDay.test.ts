import {describe, test, expect, vi, beforeEach, afterEach} from 'vitest';
import {GentingSkyworlds} from '../gentingskyworlds.js';
import {CacheLib} from '../../../cache.js';
import waitTimeFixture from './fixtures/wait-time-2026-09-29.json' with {type: 'json'};
import attractionFixture from './fixtures/attraction-all-rides-2026-09-29.json' with {type: 'json'};

/**
 * The wait-time feed's `operationHour` reads 10:00-18:00 every day, including
 * the Tuesdays the park is closed. On a calendar closed day it must not put
 * the day back into the schedule or make DOWN rides look like breakdowns,
 * unless enough rides are actually running to call it an opening (a Tuesday
 * opened for a holiday the calendar does not list). One ride running is not
 * enough: that is what a test run on a closed day looks like.
 *
 * Fixtures are the real feed, fetched at 18:21 local on Tuesday 29 September
 * 2026 (a closed day): 17 rides DOWN at 999, one future attraction COMINGSOON.
 * The attraction list is trimmed to the ride ids and titles.
 */

// Tuesday 29 September 2026, a closed day in the official calendar.
const CLOSED_TUESDAY = '2026-09-29';
// Tuesday 11 August 2026, a closed day on which one ride ran for 87 minutes.
const TEST_RUN_TUESDAY = '2026-08-11';
// Monday 28 September 2026, a normal operating day.
const OPEN_MONDAY = '2026-09-28';

const FIXTURE_DATE = '2026-09-29';

/** The fixture's operationHour, moved to `date`. */
function operationHour(date: string) {
  const oh = waitTimeFixture.result.operationHour as Record<string, string>;
  return Object.fromEntries(Object.entries(oh).map(([k, v]) => [k, v.replace(FIXTURE_DATE, date)]));
}

/** The 29 September rides, exactly as served. */
function closedDayRides(): any[] {
  return waitTimeFixture.result.rideWaitTimes.map((r) => ({...r}));
}

/**
 * The 11 August shape: one ride UP with a 5 minute wait from 10:00 local,
 * every other ride DOWN.
 */
function testRunRides(): any[] {
  return closedDayRides().map((r, i) => (i === 0
    ? {...r, status: 'UP', waitTime: 5}
    : {...r, status: 'DOWN', waitTime: 999}));
}

/**
 * A real opening: the first `up` rides UP with ordinary waits, the rest as
 * served. Openings run 15 or 16 of the 18 rides (one is a future attraction).
 */
function ridesWithUp(up: number): any[] {
  let n = 0;
  return closedDayRides().map((r) => (r.status === 'DOWN' && n++ < up
    ? {...r, status: 'UP', waitTime: 5 + 5 * (n % 6)}
    : r));
}

class Probe extends GentingSkyworlds {
  public wait: any = {};
  public all: any = {rides: [], shows: [], dining: []};

  constructor() {
    super({});
  }

  override async getWaitTimes(): Promise<any> {
    return this.wait;
  }

  override async getAll(): Promise<any> {
    return this.all;
  }

  override async getDesireItinerary(): Promise<any> {
    return [];
  }

  schedulesForTest() {
    return this.buildSchedules();
  }

  liveForTest() {
    return this.buildLiveData();
  }
}

function probeFor(date: string, rides: any[]) {
  const p = new Probe();
  p.wait = {operationHour: operationHour(date), rideWaitTimes: rides};
  p.all = {rides: attractionFixture.result.rides, shows: [], dining: []};
  return p;
}

async function scheduleDay(p: Probe, date: string) {
  const [park] = await p.schedulesForTest();
  return (park.schedule as any[]).filter((s) => s.date === date);
}

describe('Genting calendar closed day', () => {
  beforeEach(() => {
    CacheLib.clear();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    CacheLib.clear();
  });

  test('the fixture is the closed-day shape: no ride UP, 17 DOWN', () => {
    const rides = closedDayRides();
    expect(rides).toHaveLength(18);
    expect(rides.filter((r) => r.status === 'UP')).toHaveLength(0);
    expect(rides.filter((r) => r.status === 'DOWN')).toHaveLength(17);
    expect(attractionFixture.result.rides.map((r) => r.id).sort())
      .toEqual(rides.map((r) => r.attractionId).sort());
  });

  test('a closed Tuesday stays out of the schedule when no ride is running', async () => {
    vi.setSystemTime(new Date(`${CLOSED_TUESDAY}T12:55:00+08:00`));
    const p = probeFor(CLOSED_TUESDAY, closedDayRides());

    expect(await scheduleDay(p, CLOSED_TUESDAY)).toEqual([]);
  });

  test('a closed Tuesday is scheduled when the park actually opens', async () => {
    vi.setSystemTime(new Date(`${CLOSED_TUESDAY}T12:55:00+08:00`));
    const p = probeFor(CLOSED_TUESDAY, ridesWithUp(16));

    const day = await scheduleDay(p, CLOSED_TUESDAY);
    expect(day).toHaveLength(1);
    expect(day[0].type).toBe('OPERATING');
    expect(day[0].openingTime).toBe('2026-09-29T10:00:00+08:00');
    expect(day[0].closingTime).toBe('2026-09-29T18:00:00+08:00');
  });

  test('a normal day keeps the feed hours even with every ride down', async () => {
    vi.setSystemTime(new Date(`${OPEN_MONDAY}T12:55:00+08:00`));
    const p = probeFor(OPEN_MONDAY, closedDayRides());

    const day = await scheduleDay(p, OPEN_MONDAY);
    expect(day).toHaveLength(1);
    expect(day[0].openingTime).toBe('2026-09-28T10:00:00+08:00');
  });

  test('the next closed Tuesday is still left out of the forward schedule', async () => {
    vi.setSystemTime(new Date(`${OPEN_MONDAY}T12:55:00+08:00`));
    const p = probeFor(OPEN_MONDAY, closedDayRides());

    expect(await scheduleDay(p, CLOSED_TUESDAY)).toEqual([]);
  });

  test('live data reads CLOSED, not DOWN, on a closed Tuesday', async () => {
    vi.setSystemTime(new Date(`${CLOSED_TUESDAY}T12:55:00+08:00`));
    const p = probeFor(CLOSED_TUESDAY, closedDayRides());

    const live = await p.liveForTest();
    expect(live).toHaveLength(18);
    expect(live.every((l) => l.status === 'CLOSED')).toBe(true);
    expect(live.some((l: any) => l.queue)).toBe(false);
  });

  test('live data keeps real statuses on a closed Tuesday the park opened', async () => {
    vi.setSystemTime(new Date(`${CLOSED_TUESDAY}T12:55:00+08:00`));
    const rides = ridesWithUp(15);
    const p = probeFor(CLOSED_TUESDAY, rides);

    const live = await p.liveForTest();
    const up = rides.find((r) => r.status === 'UP');
    const down = rides.find((r) => r.status === 'DOWN');
    expect(live.filter((l) => l.status === 'OPERATING')).toHaveLength(15);
    expect(live.find((l) => l.id === up.attractionId)?.queue?.STANDBY?.waitTime).toBe(up.waitTime);
    expect(live.find((l) => l.id === down.attractionId)?.status).toBe('DOWN');
  });

  test('live data keeps DOWN on a normal day', async () => {
    vi.setSystemTime(new Date(`${OPEN_MONDAY}T12:55:00+08:00`));
    const p = probeFor(OPEN_MONDAY, closedDayRides());

    const live = await p.liveForTest();
    expect(live.find((l) => l.id === '008')?.status).toBe('DOWN');
  });
});

/**
 * 11 August 2026 was a calendar closed Tuesday. One ride read UP with a
 * 5 minute wait for 87 minutes from 10:00 local while the other 17 read DOWN,
 * most likely a test run. The park was not open.
 */
describe('Genting closed day with a single ride test run', () => {
  beforeEach(() => {
    CacheLib.clear();
    vi.useFakeTimers();
    vi.setSystemTime(new Date(`${TEST_RUN_TUESDAY}T10:30:00+08:00`));
  });

  afterEach(() => {
    vi.useRealTimers();
    CacheLib.clear();
  });

  test('the shape is 1 UP and 17 DOWN', () => {
    const rides = testRunRides();
    expect(rides.filter((r) => r.status === 'UP')).toHaveLength(1);
    expect(rides.filter((r) => r.status === 'DOWN')).toHaveLength(17);
  });

  test('the park reads CLOSED with no queues', async () => {
    const live = await probeFor(TEST_RUN_TUESDAY, testRunRides()).liveForTest();
    expect(live).toHaveLength(18);
    expect(live.every((l) => l.status === 'CLOSED')).toBe(true);
    expect(live.some((l: any) => l.queue)).toBe(false);
  });

  test('the day stays off the schedule', async () => {
    const p = probeFor(TEST_RUN_TUESDAY, testRunRides());
    expect(await scheduleDay(p, TEST_RUN_TUESDAY)).toEqual([]);
  });
});

/**
 * Where the line sits on a calendar closed day: 2 rides UP is still a test,
 * 3 is an opening. Real openings run 15 or 16.
 */
describe('Genting closed day opening threshold', () => {
  beforeEach(() => {
    CacheLib.clear();
    vi.useFakeTimers();
    vi.setSystemTime(new Date(`${CLOSED_TUESDAY}T12:55:00+08:00`));
  });

  afterEach(() => {
    vi.useRealTimers();
    CacheLib.clear();
  });

  test.each([
    [0, false],
    [1, false],
    [2, false],
    [3, true],
    [15, true],
    [16, true],
  ])('%i rides UP opens the day: %s', async (up, open) => {
    const p = probeFor(CLOSED_TUESDAY, ridesWithUp(up));

    expect(await scheduleDay(p, CLOSED_TUESDAY)).toHaveLength(open ? 1 : 0);
    const live = await p.liveForTest();
    expect(live.filter((l) => l.status === 'OPERATING')).toHaveLength(open ? up : 0);
  });
});

/**
 * The 2026 closed days, read from the official calendar PDF's shaded cells
 * (every Tuesday checked). 15 September and 3 November are open; 24 March is
 * closed.
 */
describe('Genting 2026 calendar transcription', () => {
  const CLOSED_2026 = [
    '2026-01-13', '2026-01-20', '2026-01-27', '2026-02-03', '2026-02-10', '2026-02-24',
    '2026-03-03', '2026-03-10', '2026-03-17', '2026-03-24', '2026-03-31',
    '2026-04-07', '2026-04-14', '2026-04-21', '2026-04-28', '2026-05-05', '2026-05-12', '2026-05-19',
    '2026-06-09', '2026-06-16', '2026-06-23', '2026-06-30', '2026-07-07', '2026-07-14', '2026-07-21', '2026-07-28',
    '2026-08-04', '2026-08-11', '2026-08-18', '2026-09-08', '2026-09-22', '2026-09-29',
    '2026-10-06', '2026-10-13', '2026-10-20', '2026-10-27', '2026-11-10', '2026-11-17', '2026-11-24', '2026-12-01',
  ];

  beforeEach(() => {
    CacheLib.clear();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    CacheLib.clear();
  });

  test('every 2026 Tuesday matches the calendar', async () => {
    // The forward schedule spans 90 days, so read the year in 60-day windows.
    const scheduled = new Set<string>();
    for (const start of ['2026-01-01', '2026-03-01', '2026-05-01', '2026-07-01', '2026-09-01', '2026-11-01']) {
      CacheLib.clear();
      vi.setSystemTime(new Date(`${start}T09:00:00+08:00`));
      const p = new Probe();
      p.wait = {rideWaitTimes: []};
      const [park] = await p.schedulesForTest();
      for (const s of park.schedule as any[]) scheduled.add(s.date);
    }

    const wrong: string[] = [];
    let tuesdays = 0;
    for (let d = new Date('2026-01-06T12:00:00Z'); d.getUTCFullYear() === 2026; d = new Date(d.getTime() + 7 * 86400000)) {
      const date = d.toISOString().slice(0, 10);
      tuesdays++;
      if (scheduled.has(date) === CLOSED_2026.includes(date)) wrong.push(date);
    }
    expect(tuesdays).toBe(52);
    expect(wrong).toEqual([]);
  });

  test.each([
    ['2026-09-15', true],
    ['2026-11-03', true],
    ['2026-09-22', false],
    ['2026-11-10', false],
  ])('%s is scheduled: %s', async (date, open) => {
    vi.setSystemTime(new Date('2026-09-01T09:00:00+08:00'));
    const p = new Probe();
    p.wait = {rideWaitTimes: []};
    const [park] = await p.schedulesForTest();
    expect((park.schedule as any[]).some((s) => s.date === date)).toBe(open);
  });

  test('24 March is closed', async () => {
    vi.setSystemTime(new Date('2026-03-01T09:00:00+08:00'));
    const p = new Probe();
    p.wait = {rideWaitTimes: []};
    const [park] = await p.schedulesForTest();
    expect((park.schedule as any[]).some((s) => s.date === '2026-03-24')).toBe(false);
  });
});
