import {describe, test, expect, vi, beforeEach, afterEach} from 'vitest';
import {GentingSkyworlds} from '../gentingskyworlds.js';
import {CacheLib} from '../../../cache.js';

/**
 * The wait-time feed's `operationHour` reads 10:00-18:00 every day, including
 * the Tuesdays the park is closed. On a calendar closed day it must not put
 * the day back into the schedule or make DOWN rides look like breakdowns,
 * unless a ride is actually running (a Tuesday opened for a holiday the
 * calendar does not list).
 */

// Tuesday 29 September 2026, a closed day in the official calendar.
const CLOSED_TUESDAY = '2026-09-29';
// Monday 28 September 2026, a normal operating day.
const OPEN_MONDAY = '2026-09-28';

function operationHour(date: string) {
  return {
    itineraryStartTime: `${date}T08:00:00+08:00`,
    itineraryEndTime: `${date}T17:00:00+08:00`,
    startTime: `${date}T10:00:00+08:00`,
    endTime: `${date}T18:00:00+08:00`,
  };
}

// The shape the feed served at 12:55 local on 29 September 2026.
function closedDayRides() {
  const rides: any[] = [];
  for (let i = 1; i <= 17; i++) {
    rides.push({attractionId: String(i).padStart(3, '0'), waitTime: 999, status: 'DOWN', vqReservation: true, fullVqReservation: false});
  }
  rides.push({attractionId: '018', waitTime: 999, status: 'COMINGSOON', vqReservation: false, fullVqReservation: false});
  return rides;
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
  p.all = {rides: rides.map((r) => ({id: r.attractionId, title: `Ride ${r.attractionId}`})), shows: [], dining: []};
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

  test('a closed Tuesday stays out of the schedule when no ride is running', async () => {
    vi.setSystemTime(new Date(`${CLOSED_TUESDAY}T12:55:00+08:00`));
    const p = probeFor(CLOSED_TUESDAY, closedDayRides());

    expect(await scheduleDay(p, CLOSED_TUESDAY)).toEqual([]);
  });

  test('a closed Tuesday is scheduled when a ride is actually running', async () => {
    vi.setSystemTime(new Date(`${CLOSED_TUESDAY}T12:55:00+08:00`));
    const rides = closedDayRides();
    rides[0] = {...rides[0], status: 'UP', waitTime: 15};
    const p = probeFor(CLOSED_TUESDAY, rides);

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
    const rides = closedDayRides();
    rides[0] = {...rides[0], status: 'UP', waitTime: 15};
    const p = probeFor(CLOSED_TUESDAY, rides);

    const live = await p.liveForTest();
    expect(live.find((l) => l.id === '001')?.status).toBe('OPERATING');
    expect(live.find((l) => l.id === '002')?.status).toBe('DOWN');
  });

  test('live data keeps DOWN on a normal day', async () => {
    vi.setSystemTime(new Date(`${OPEN_MONDAY}T12:55:00+08:00`));
    const p = probeFor(OPEN_MONDAY, closedDayRides());

    const live = await p.liveForTest();
    expect(live.find((l) => l.id === '001')?.status).toBe('DOWN');
  });
});
