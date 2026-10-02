/**
 * Live status on days the main park is closed.
 *
 * During the winter closure the waiting-times feed keeps listing the main
 * park's rides but sends `time: 0` instead of the closed code 333, which the
 * status mapping read as OPERATING with a 0-minute wait.
 *
 * Fixtures under ./fixtures are real upstream payloads captured on
 * 2026-09-28 (in season, evening): the waiting-times feed, the live calendar,
 * the seasons feed, the entity list built from the POI feed, and the
 * attraction live data the pre-fix code produced from them. The winter-day
 * inputs are derived from those payloads in `winterWaits()` below, following
 * the shape seen in winter 2026 (every main-park ride at `time: 0`, a few
 * with real waits, Rulantica open as usual).
 */
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {describe, test, expect, vi, beforeEach, afterEach} from 'vitest';
import {EuropaPark} from '../europapark.js';

const fixture = (name: string): any =>
  JSON.parse(readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), 'utf8'));

const WAITS = fixture('waiting-times-2026-09-28.json') as any[];
const CALENDAR = fixture('live-calendar-2026-09-28.json');
const SEASONS = fixture('seasons-2026-09-28.json') as any[];
const ENTITY_ROWS = fixture('entities-2026-09-28.json') as any[];
const GASTRONOMY = fixture('gastronomy-2026-09-28.json') as any[];
const LIVE_BEFORE_FIX = fixture('live-before-fix-2026-09-28.json') as any[];

const ENTITIES = ENTITY_ROWS.map((e) => ({
  ...e,
  vQueue: e.vq !== undefined ? {code: e.vq, queueing: true} : undefined,
}));
const POIS = GASTRONOMY.map((g) => ({...g, type: 'gastronomy', name: `gastronomy ${g.id}`}));

const EXPRESS_IDS = new Set(['pois_60', 'pois_61', 'pois_62', 'pois_395']);
const byId = new Map(ENTITIES.map((e) => [e.id, e]));
const isMainParkOnly = (e: any): boolean =>
  e.scopes.includes('europapark') && !e.scopes.includes('rulantica') && !e.scopes.includes('traumatica');
const MAIN_PARK_ATTRACTIONS = ENTITIES.filter(
  (e) => e.entityType === 'ATTRACTION' && isMainParkOnly(e) && !EXPRESS_IDS.has(e.id),
);
const RULANTICA_CODES = new Set(
  ENTITIES.filter((e) => e.scopes.includes('rulantica') && e.code).map((e) => e.code),
);

// In season, captured at 22:10 local on 2026-09-28; the calendar says open 09:00-18:30.
const IN_SEASON_NOW = new Date('2026-09-28T20:10:10Z');
// Winter closure: the captured seasons feed has no main-park season between
// 2027-01-10 and 2027-03-06.
const WINTER_NOW = new Date('2027-02-10T11:00:00Z');

const VOLETARIUM = {id: 'pois_346', code: 9};
const SUPERSPLASH = {id: 'pois_47', code: 800};
const RULANTICA_RIDE = {id: 'pois_14', code: 1001};

/** Winter-day feed: main-park rides at time 0, one with a real wait, Rulantica unchanged except one ride at 0. */
function winterWaits(): any[] {
  return WAITS.map((w) => {
    if (RULANTICA_CODES.has(w.code)) {
      return w.code === RULANTICA_RIDE.code ? {...w, time: 0} : w;
    }
    if (w.code === VOLETARIUM.code) return {...w, time: 70};
    return {...w, time: 0};
  });
}

const closedCalendar = (date: string): any => ({
  scope: 'europapark',
  locale: 'en',
  today: {date: `${date}T00:00:00+01:00`, start: null, end: null},
  tomorrow: null,
  next: null,
});

class LiveProbe extends EuropaPark {
  constructor(
    private readonly waits: any[],
    private readonly calendar: () => Promise<any>,
    private readonly seasons: () => Promise<any> = async () => SEASONS,
  ) {
    super();
    // No EP-Express feed in these tests.
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

/** Attraction rows (pois_*, EP-Express excluded) in a stable order. */
const attractionRows = (live: Map<string, any>): any[] =>
  [...live.values()]
    .filter((r) => r.id.startsWith('pois_') && !EXPRESS_IDS.has(r.id))
    .sort((a, b) => a.id.localeCompare(b.id));

beforeEach(() => {
  vi.useFakeTimers({toFake: ['Date']});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('in season (real 2026-09-28 payloads)', () => {
  test('calendar open: attraction output is identical to the pre-fix mapping', async () => {
    vi.setSystemTime(IN_SEASON_NOW);
    const live = await new LiveProbe(WAITS, async () => CALENDAR).live();
    const expected = [...LIVE_BEFORE_FIX].sort((a, b) => a.id.localeCompare(b.id));
    expect(attractionRows(live)).toEqual(expected);
  });

  test('calendar open: 333 is CLOSED and a real wait stays OPERATING', async () => {
    vi.setSystemTime(IN_SEASON_NOW);
    const live = await new LiveProbe(WAITS, async () => CALENDAR).live();
    const closedCodes = WAITS.filter((w) => w.time === 333).map((w) => w.code);
    for (const e of MAIN_PARK_ATTRACTIONS.filter((x) => closedCodes.includes(x.code))) {
      expect(live.get(e.id)?.status).toBe('CLOSED');
    }
    expect(live.get(RULANTICA_RIDE.id)).toMatchObject({status: 'OPERATING', queue: {STANDBY: {waitTime: 1}}});
  });

  test('calendar open: time 0 on a main-park ride is still a 0-minute walk-on', async () => {
    vi.setSystemTime(IN_SEASON_NOW);
    const waits = WAITS.map((w) => (w.code === SUPERSPLASH.code ? {...w, time: 0} : w));
    const live = await new LiveProbe(waits, async () => CALENDAR).live();
    expect(live.get(SUPERSPLASH.id)).toEqual({
      id: SUPERSPLASH.id,
      status: 'OPERATING',
      queue: {STANDBY: {waitTime: 0}},
    });
  });

  test('calendar unavailable inside published hours: output unchanged', async () => {
    vi.setSystemTime(new Date('2026-09-28T10:00:00Z'));
    const waits = WAITS.map((w) => (w.code === SUPERSPLASH.code ? {...w, time: 0} : w));
    const withCalendar = await new LiveProbe(waits, async () => ({...CALENDAR})).live();
    const without = await new LiveProbe(waits, failing('calendar')).live();
    expect(attractionRows(without)).toEqual(attractionRows(withCalendar));
    expect(without.get(SUPERSPLASH.id)?.status).toBe('OPERATING');
  });
});

describe('winter closure, calendar says closed', () => {
  test('every main-park attraction is CLOSED with no queue', async () => {
    vi.setSystemTime(WINTER_NOW);
    const live = await new LiveProbe(winterWaits(), async () => closedCalendar('2027-02-10')).live();

    expect(MAIN_PARK_ATTRACTIONS.length).toBeGreaterThan(50);
    for (const e of MAIN_PARK_ATTRACTIONS) {
      expect(live.get(e.id), e.id).toEqual({id: e.id, status: 'CLOSED'});
    }
    // Including a ride that reported a real wait, and rides the feed left out.
    expect(live.get(VOLETARIUM.id)).toEqual({id: VOLETARIUM.id, status: 'CLOSED'});
    const waitCodes = new Set(WAITS.map((w) => w.code));
    const absent = MAIN_PARK_ATTRACTIONS.filter((e) => !waitCodes.has(e.code));
    expect(absent.length).toBeGreaterThan(0);
    for (const e of absent) expect(live.get(e.id)?.status).toBe('CLOSED');
  });

  test('no main-park attraction publishes OPERATING', async () => {
    vi.setSystemTime(WINTER_NOW);
    const live = await new LiveProbe(winterWaits(), async () => closedCalendar('2027-02-10')).live();
    const operating = attractionRows(live).filter((r) => r.status === 'OPERATING' && isMainParkOnly(byId.get(r.id)));
    expect(operating).toEqual([]);
  });

  test('Rulantica shares the feed but is untouched, time 0 included', async () => {
    vi.setSystemTime(WINTER_NOW);
    const live = await new LiveProbe(winterWaits(), async () => closedCalendar('2027-02-10')).live();
    expect(live.get(RULANTICA_RIDE.id)).toEqual({
      id: RULANTICA_RIDE.id,
      status: 'OPERATING',
      queue: {STANDBY: {waitTime: 0}},
    });
    expect(live.get('pois_1')).toMatchObject({status: 'OPERATING', queue: {STANDBY: {waitTime: 1}}});
  });

  test('restaurants are not touched', async () => {
    vi.setSystemTime(WINTER_NOW);
    const live = await new LiveProbe(winterWaits(), async () => closedCalendar('2027-02-10')).live();
    for (const r of live.values()) {
      if (r.id.startsWith('gastronomy_')) expect(r.queue).toBeUndefined();
    }
  });

  test('a closed "today" dated for another day is ignored (stale response)', async () => {
    vi.setSystemTime(WINTER_NOW);
    // Calendar claims closed, but for yesterday; seasons fallback still applies.
    const live = await new LiveProbe(winterWaits(), async () => closedCalendar('2027-02-09')).live();
    // Fallback keeps the real wait, which the calendar path would have closed.
    expect(live.get(VOLETARIUM.id)).toMatchObject({status: 'OPERATING', queue: {STANDBY: {waitTime: 70}}});
    expect(live.get(SUPERSPLASH.id)).toEqual({id: SUPERSPLASH.id, status: 'CLOSED'});
  });
});

describe('winter closure, calendar missing', () => {
  for (const [label, calendar] of [
    ['fetch fails', failing('calendar')],
    ['no today block', async () => ({scope: 'europapark', today: null, next: null})],
    ['empty object', async () => ({})],
  ] as const) {
    test(`${label}: seasons publish no hours, so time 0 becomes CLOSED and real waits stay`, async () => {
      vi.setSystemTime(WINTER_NOW);
      const live = await new LiveProbe(winterWaits(), calendar).live();

      expect(live.get(SUPERSPLASH.id)).toEqual({id: SUPERSPLASH.id, status: 'CLOSED'});
      expect(live.get(VOLETARIUM.id)).toMatchObject({
        status: 'OPERATING',
        queue: {STANDBY: {waitTime: 70}},
      });
      expect(live.get(RULANTICA_RIDE.id)).toMatchObject({status: 'OPERATING', queue: {STANDBY: {waitTime: 0}}});

      const zeroOperating = attractionRows(live).filter(
        (r) => isMainParkOnly(byId.get(r.id)) && r.status === 'OPERATING' && r.queue?.STANDBY?.waitTime === 0,
      );
      expect(zeroOperating).toEqual([]);
    });
  }

  test('seasons also unavailable: feed mapping is left exactly as before', async () => {
    vi.setSystemTime(WINTER_NOW);
    const live = await new LiveProbe(winterWaits(), failing('calendar'), failing('seasons')).live();
    expect(live.get(SUPERSPLASH.id)).toEqual({
      id: SUPERSPLASH.id,
      status: 'OPERATING',
      queue: {STANDBY: {waitTime: 0}},
    });
  });

  test('a day with published season hours is not treated as closed', async () => {
    // 2026-11-10 sits inside the captured 2026-11-02..11-27 main-park season.
    vi.setSystemTime(new Date('2026-11-10T11:00:00Z'));
    const live = await new LiveProbe(winterWaits(), failing('calendar')).live();
    expect(live.get(SUPERSPLASH.id)).toMatchObject({status: 'OPERATING', queue: {STANDBY: {waitTime: 0}}});
  });
});

describe('_mainParkDayStatus', () => {
  class StatusProbe extends EuropaPark {
    status(cal: any, now: Date): string { return this._mainParkDayStatus(cal, now); }
  }
  const probe = new StatusProbe();
  const now = new Date('2027-02-10T11:00:00Z');
  const today = (start: any, end: any, date = '2027-02-10T00:00:00+01:00'): any => ({today: {date, start, end}});

  test.each([
    ['open', today('2027-02-10T09:00:00+01:00', '2027-02-10T18:00:00+01:00'), 'OPEN'],
    ['start null', today(null, null), 'CLOSED'],
    ['only end null', today('2027-02-10T09:00:00+01:00', null), 'CLOSED'],
    ['other date', today(null, null, '2027-02-09T00:00:00+01:00'), 'UNKNOWN'],
    ['start missing', today(undefined, undefined), 'UNKNOWN'],
    ['today null', {today: null}, 'UNKNOWN'],
    ['no calendar', null, 'UNKNOWN'],
  ])('%s -> %s', (_label, cal, expected) => {
    expect(probe.status(cal, now)).toBe(expected);
  });

  test('uses the park timezone date, not UTC (23:30 UTC is already the next day in Berlin)', () => {
    const lateUtc = new Date('2027-02-09T23:30:00Z');
    expect(probe.status(today(null, null), lateUtc)).toBe('CLOSED');
  });
});
