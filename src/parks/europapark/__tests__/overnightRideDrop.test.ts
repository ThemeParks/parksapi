/**
 * Rides the waiting-times feed drops overnight.
 *
 * Around midnight local time the feed stops listing rides (main park,
 * Rulantica and Traumatica alike) and keeps only restaurants and the
 * virtual-queue entries; the rides reappear one by one before opening. Seen
 * upstream every night from 2026-10-27: 151 live entities by day, 102 from
 * 00:00 to about 06:00 local. Without a carry-forward the dropped rides vanish
 * from live data for the night.
 *
 * Fixtures are the real 2026-09-28 payloads used by closedDayLiveStatus.test.ts.
 * The night feed is derived from them by removing every ride entry, which is
 * the shape the feed has overnight.
 */
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {describe, test, expect, vi, beforeEach, afterEach} from 'vitest';
import {
  EuropaPark,
  RECENT_RIDES_KEY,
  RECENT_RIDES_TTL_SECONDS,
  rememberRides,
  insideMainParkHours,
  insideSeasonHours,
} from '../europapark.js';
import {CacheLib} from '../../../cache.js';

const fixture = (name: string): any =>
  JSON.parse(readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), 'utf8'));

const WAITS = fixture('waiting-times-2026-09-28.json') as any[];
const CALENDAR = fixture('live-calendar-2026-09-28.json');
const SEASONS = fixture('seasons-2026-09-28.json') as any[];
const ENTITY_ROWS = fixture('entities-2026-09-28.json') as any[];
const GASTRONOMY = fixture('gastronomy-2026-09-28.json') as any[];

const ENTITIES = ENTITY_ROWS.map((e) => ({
  ...e,
  vQueue: e.vq !== undefined ? {code: e.vq, queueing: true} : undefined,
}));
const POIS = GASTRONOMY.map((g) => ({...g, type: 'gastronomy', name: `gastronomy ${g.id}`}));

const EXPRESS_IDS = new Set(['pois_60', 'pois_61', 'pois_62', 'pois_395']);
const RIDE_CODES = new Set(
  ENTITIES.filter((e) => e.entityType === 'ATTRACTION' && e.code).map((e) => e.code),
);
const VQ_CODES = new Set(ENTITIES.filter((e) => e.vq !== undefined).map((e) => e.vq));

/** Overnight feed: every ride entry removed; restaurants and VQ entries stay. */
const NIGHT_WAITS = WAITS.filter((w) => !RIDE_CODES.has(w.code) || VQ_CODES.has(w.code));

// 14:00 local on 2026-09-28: main park (09:00-18:30) and Rulantica (09:30-22:00) open.
const DAY_NOW = new Date('2026-09-28T12:00:00Z');
// 01:00 local on 2026-09-29: every park closed.
const NIGHT_NOW = new Date('2026-09-28T23:00:00Z');
// 07:30 local on 2026-09-29: before opening, rides starting to reappear.
const MORNING_NOW = new Date('2026-09-29T05:30:00Z');
// 20:00 local on 2026-09-28: main park closed, Rulantica still open.
const EVENING_NOW = new Date('2026-09-28T18:00:00Z');

/** The live calendar as served after midnight: `today` is the 29th. */
const CALENDAR_29 = {...CALENDAR, today: CALENDAR.tomorrow, tomorrow: null};

const VOLETARIUM = {id: 'pois_346', code: 9};
const RULANTICA_RIDE = {id: 'pois_14', code: 1001};

class LiveProbe extends EuropaPark {
  constructor(
    private readonly waits: any[],
    private readonly calendar: () => Promise<any>,
    private readonly seasons: () => Promise<any> = async () => SEASONS,
  ) {
    super();
    (this as any).hotelAppBase = '';
  }
  override async getParkEntities(): Promise<any> { return ENTITIES; }
  override async getPOIs(): Promise<any> { return POIS; }
  override async getWaitingTimes(): Promise<any> { return this.waits; }
  override async getShowTimes(): Promise<any> { return []; }
  override async getLiveCalendar(): Promise<any> { return this.calendar(); }
  override async getSeasons(): Promise<any> { return this.seasons(); }
  async live(): Promise<Map<string, any>> {
    const rows = await this.buildLiveData();
    return new Map(rows.map((r: any) => [r.id, r]));
  }
}

const failing = (what: string) => async (): Promise<never> => {
  throw new Error(`${what} HTTP 503`);
};

/** Ride rows (pois_* attractions, EP-Express excluded). */
const rideIds = (live: Map<string, any>): string[] =>
  [...live.keys()]
    .filter((id) => id.startsWith('pois_') && !EXPRESS_IDS.has(id)
      && ENTITIES.find((e) => e.id === id)?.entityType === 'ATTRACTION')
    .sort();

async function tickAt(now: Date, waits: any[], calendar: () => Promise<any>, seasons?: () => Promise<any>) {
  vi.setSystemTime(now);
  return new LiveProbe(waits, calendar, seasons).live();
}

beforeEach(() => {
  vi.useFakeTimers({toFake: ['Date']});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  CacheLib.delete(RECENT_RIDES_KEY);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  CacheLib.delete(RECENT_RIDES_KEY);
});

describe('overnight ride drop', () => {
  test('the derived night feed lists no rides', () => {
    const rides = NIGHT_WAITS.filter((w) => RIDE_CODES.has(w.code) && !VQ_CODES.has(w.code));
    expect(rides).toEqual([]);
    expect(NIGHT_WAITS.length).toBeGreaterThan(0);
  });

  test('every ride seen by day is reported CLOSED overnight, none vanish', async () => {
    const day = await tickAt(DAY_NOW, WAITS, async () => CALENDAR);
    const dayRides = rideIds(day);
    expect(dayRides.length).toBeGreaterThan(40);

    const night = await tickAt(NIGHT_NOW, NIGHT_WAITS, async () => CALENDAR_29);
    expect(rideIds(night)).toEqual(dayRides);
    for (const id of dayRides) {
      expect(night.get(id)).toEqual({id, status: 'CLOSED'});
    }
  });

  test('carries Rulantica and Traumatica rides as well as main-park rides', async () => {
    await tickAt(DAY_NOW, WAITS, async () => CALENDAR);
    const night = await tickAt(NIGHT_NOW, NIGHT_WAITS, async () => CALENDAR_29);
    const scopes = new Set(rideIds(night).flatMap((id) => ENTITIES.find((e) => e.id === id)!.scopes));
    expect(scopes).toEqual(new Set(['europapark', 'resort', 'rulantica', 'traumatica']));
    expect(night.get(RULANTICA_RIDE.id)).toEqual({id: RULANTICA_RIDE.id, status: 'CLOSED'});
  });

  test('restaurants overnight are unchanged by the carry-forward', async () => {
    await tickAt(DAY_NOW, WAITS, async () => CALENDAR);
    const night = await tickAt(NIGHT_NOW, NIGHT_WAITS, async () => CALENDAR_29);
    CacheLib.delete(RECENT_RIDES_KEY);
    const cold = await tickAt(NIGHT_NOW, NIGHT_WAITS, async () => CALENDAR_29);
    const gastro = (m: Map<string, any>) => [...m.entries()].filter(([id]) => id.startsWith('gastronomy_'));
    expect(gastro(night)).toEqual(gastro(cold));
  });

  test('morning ramp: a ride the feed lists again keeps its reported status', async () => {
    await tickAt(DAY_NOW, WAITS, async () => CALENDAR);
    const refurb = WAITS.find((w) => w.code === VOLETARIUM.code)!;
    const morningWaits = [...NIGHT_WAITS, {...refurb, time: 222}];
    const morning = await tickAt(MORNING_NOW, morningWaits, async () => CALENDAR_29);
    expect(morning.get(VOLETARIUM.id)?.status).toBe('REFURBISHMENT');
    const others = rideIds(morning).filter((id) => id !== VOLETARIUM.id);
    expect(others.length).toBeGreaterThan(40);
    for (const id of others) expect(morning.get(id)?.status).toBe('CLOSED');
  });

  test('inside published hours an absent ride is still left out', async () => {
    await tickAt(DAY_NOW, WAITS, async () => CALENDAR);
    const waits = WAITS.filter((w) => w.code !== VOLETARIUM.code);
    const later = await tickAt(new Date('2026-09-28T12:05:00Z'), waits, async () => CALENDAR);
    expect(later.has(VOLETARIUM.id)).toBe(false);
  });

  test('each park uses its own hours: Rulantica open while the main park is closed', async () => {
    await tickAt(DAY_NOW, WAITS, async () => CALENDAR);
    const waits = WAITS.filter((w) => w.code !== VOLETARIUM.code && w.code !== RULANTICA_RIDE.code);
    const evening = await tickAt(EVENING_NOW, waits, async () => CALENDAR);
    expect(evening.get(VOLETARIUM.id)).toEqual({id: VOLETARIUM.id, status: 'CLOSED'});
    expect(evening.has(RULANTICA_RIDE.id)).toBe(false);
  });

  test('a ride the feed never listed is not invented', async () => {
    const day = await tickAt(DAY_NOW, WAITS, async () => CALENDAR);
    const night = await tickAt(NIGHT_NOW, NIGHT_WAITS, async () => CALENDAR_29);
    const neverListed = ENTITIES.filter((e) => e.entityType === 'ATTRACTION' && !day.has(e.id));
    expect(neverListed.length).toBeGreaterThan(0);
    for (const e of neverListed) expect(night.has(e.id)).toBe(false);
  });

  test('no memory yet (first tick is at night): nothing is carried', async () => {
    const night = await tickAt(NIGHT_NOW, NIGHT_WAITS, async () => CALENDAR_29);
    expect(rideIds(night)).toEqual([]);
  });

  test('calendar and seasons both unavailable: nothing is carried', async () => {
    await tickAt(DAY_NOW, WAITS, async () => CALENDAR);
    const night = await tickAt(NIGHT_NOW, NIGHT_WAITS, failing('calendar'), failing('seasons'));
    expect(rideIds(night)).toEqual([]);
  });

  test('calendar unavailable: the main park falls back to the seasons feed', async () => {
    await tickAt(DAY_NOW, WAITS, async () => CALENDAR);
    const night = await tickAt(NIGHT_NOW, NIGHT_WAITS, failing('calendar'));
    expect(night.get(VOLETARIUM.id)).toEqual({id: VOLETARIUM.id, status: 'CLOSED'});
  });

  test('a ride not listed for over a week is forgotten', async () => {
    await tickAt(DAY_NOW, WAITS, async () => CALENDAR);
    const weekLater = new Date(NIGHT_NOW.getTime() + RECENT_RIDES_TTL_SECONDS * 1000);
    const night = await tickAt(weekLater, NIGHT_WAITS, async () => null);
    expect(night.has(VOLETARIUM.id)).toBe(false);
  });
});

describe('rememberRides', () => {
  const NOW = 1_800_000_000_000;
  test('adds seen ids at now and keeps recent ones', () => {
    expect(rememberRides({a: NOW - 1000}, ['b'], NOW)).toEqual({a: NOW - 1000, b: NOW});
  });
  test('refreshes a seen id', () => {
    expect(rememberRides({a: NOW - 1000}, ['a'], NOW)).toEqual({a: NOW});
  });
  test('drops ids older than the TTL', () => {
    const old = NOW - RECENT_RIDES_TTL_SECONDS * 1000;
    expect(rememberRides({a: old, b: old + 1}, [], NOW)).toEqual({b: old + 1});
  });
  test('ignores a malformed previous value', () => {
    expect(rememberRides('x' as any, ['a'], NOW)).toEqual({a: NOW});
    expect(rememberRides({a: 'y'} as any, [], NOW)).toEqual({});
    expect(rememberRides(null, [], NOW)).toEqual({});
  });
});

describe('insideMainParkHours', () => {
  test('inside, before and after the published window', () => {
    expect(insideMainParkHours(CALENDAR, '2026-09-28', new Date('2026-09-28T12:00:00Z'))).toBe(true);
    expect(insideMainParkHours(CALENDAR, '2026-09-28', new Date('2026-09-28T06:59:59Z'))).toBe(false);
    expect(insideMainParkHours(CALENDAR, '2026-09-28', new Date('2026-09-28T16:30:00Z'))).toBe(false);
  });
  test('a closed day is outside hours', () => {
    const closed = {...CALENDAR, today: {date: '2026-09-28T00:00:00+02:00', start: null, end: null}};
    expect(insideMainParkHours(closed, '2026-09-28', DAY_NOW)).toBe(false);
  });
  test('unknown when missing, stale or malformed', () => {
    expect(insideMainParkHours(null, '2026-09-28', DAY_NOW)).toBeNull();
    expect(insideMainParkHours(CALENDAR, '2026-09-29', DAY_NOW)).toBeNull();
    const bad = {...CALENDAR, today: {...CALENDAR.today, start: 'not a time'}};
    expect(insideMainParkHours(bad, '2026-09-28', DAY_NOW)).toBeNull();
  });
});

describe('insideSeasonHours', () => {
  const w = {openingTime: '2026-09-28T09:30:00+02:00', closingTime: '2026-09-28T22:00:00+02:00'};
  test('inside and outside a window, closing time exclusive', () => {
    expect(insideSeasonHours([w], new Date('2026-09-28T18:00:00Z'))).toBe(true);
    expect(insideSeasonHours([w], new Date('2026-09-28T20:00:00Z'))).toBe(false);
  });
  test('no windows is outside hours; unparsable windows are ignored', () => {
    expect(insideSeasonHours([], DAY_NOW)).toBe(false);
    expect(insideSeasonHours([{openingTime: 'x', closingTime: 'y'}], DAY_NOW)).toBe(false);
  });
  test('a window that closes after midnight still counts', () => {
    const late = {openingTime: '2026-09-28T19:00:00+02:00', closingTime: '2026-09-29T01:00:00+02:00'};
    expect(insideSeasonHours([late], new Date('2026-09-28T22:30:00Z'))).toBe(true);
  });
});

