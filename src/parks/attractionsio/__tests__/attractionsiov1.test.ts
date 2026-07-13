/**
 * Integration tests for the Attractions.io v1 base class.
 *
 * Unlike showtimes.test.ts (which unit-tests the pure ShowTimes helpers), these
 * drive the real `buildEntityList()` and `buildLiveData()` on a live subclass —
 * the entity classification (including the wider category coverage), the
 * restaurant `IsOpen` fallback, and the malformed-ShowTimes containment. The raw
 * network methods (`getPOIData` / `fetchLiveData`) are stubbed with fixtures so
 * nothing hits the API. Full integration is exercised via `npm run dev -- <park>`.
 */

import {describe, test, expect, beforeEach, afterEach, vi} from 'vitest';
import {AttractionsIOV1, parseLiveOpeningTimes} from '../attractionsiov1.js';
import {CacheLib} from '../../../cache.js';

const TZ = 'Europe/Berlin';
const DATE = '2026-07-08';

// Berlin is +02:00 in July, so 12:00 local == 10:00Z.
const NOON = new Date('2026-07-08T10:00:00Z');

const range = (open: string, close: string) =>
  JSON.stringify({type: 'range', start: `${DATE} ${open}`, end: `${DATE} ${close}`});

// A daily point-start show (no range_length) at the given wall-clock time.
const pointShow = (time: string) =>
  JSON.stringify({type: 'period', offset_date: `2020-01-01 ${time}`, period_length: {day: 1}});

/**
 * Fixture records: two attractions (one via a child category), three shows
 * (one under the wider "4D Movies" label, one with a deliberately malformed
 * ShowTimes), three restaurants (one under "Food & Drinks", one with no live
 * IsOpen signal), and a shop that must NOT be classified as anything.
 */
function mkRecords(): any {
  return {
    Resort: [{_id: 1, Name: 'Probe Resort'}],
    Category: [
      {_id: 10, Name: 'Rides'},
      {_id: 11, Name: 'Thrill Rides', Parent: 10},
      {_id: 20, Name: 'Shows'},
      {_id: 21, Name: '4D Movies'},
      {_id: 30, Name: 'Restaurants'},
      {_id: 31, Name: 'Food & Drinks'},
      {_id: 40, Name: 'Shopping'},
    ],
    Item: [
      {_id: 100, Name: 'Big Coaster', Category: 10},
      {_id: 101, Name: 'Kiddie Coaster', Category: 11},
      {_id: 200, Name: 'Magic Show', Category: 20, ShowTimes: pointShow('14:00:00')},
      {_id: 201, Name: '4D Film', Category: 21, ShowTimes: pointShow('15:00:00')},
      {_id: 202, Name: 'Broken Show', Category: 20, ShowTimes: '{"type":"range","start":null,"end":null}'},
      {_id: 300, Name: 'Burger Place', Category: 30},
      {_id: 301, Name: 'Coffee Bar', Category: 31},
      {_id: 302, Name: 'Early Kiosk', Category: 30},
      {_id: 400, Name: 'Gift Shop', Category: 40},
    ],
  };
}

function mkLive(): any {
  return {
    entities: {
      Item: {
        records: [
          {_id: 100, IsOperational: true, QueueTime: 1800}, // 30 min
          {_id: 300, IsOpen: true, OpeningTimes: range('10:00:00', '20:00:00')},
          {_id: 301, OpeningTimes: range('10:00:00', '20:00:00')}, // no IsOpen → window fallback
          {_id: 302, OpeningTimes: range('10:00:00', '11:00:00')}, // no IsOpen, already closed by noon
        ],
      },
    },
  };
}

class Probe extends AttractionsIOV1 {
  private readonly _records: any;
  private readonly _live: any;

  constructor(records: any = mkRecords(), live: any = mkLive()) {
    super({config: {destinationId: 'probe-resort', parkId: 'probe-park', timezone: TZ}});
    this._records = records;
    this._live = live;
  }

  override async getPOIData(): Promise<any> {
    return this._records;
  }

  override async fetchLiveData(): Promise<any> {
    return {json: async () => this._live};
  }

  entities(): Promise<any[]> {
    return (this as any).buildEntityList();
  }

  live(): Promise<any[]> {
    return (this as any).buildLiveData();
  }
}

beforeEach(() => {
  // getCategoryIDs is @cache-decorated; clear between tests so fixtures with the
  // same destinationId can't leak category ids from a prior test.
  CacheLib.clearAll();
});

describe('buildEntityList — classification', () => {
  test('classifies attractions, shows and restaurants by category name', async () => {
    const entities = await new Probe().entities();
    const byType = (t: string) => entities.filter(e => e.entityType === t);

    expect(byType('PARK')).toHaveLength(1);
    expect(byType('ATTRACTION').map(e => e.id).sort()).toEqual(['100', '101']);
    expect(byType('SHOW').map(e => e.id).sort()).toEqual(['200', '201', '202']);
    expect(byType('RESTAURANT').map(e => e.id).sort()).toEqual(['300', '301', '302']);
  });

  test('includes items nested under a child category (getCategoryIDs walks children)', async () => {
    const entities = await new Probe().entities();
    const kiddie = entities.find(e => e.id === '101');
    expect(kiddie?.entityType).toBe('ATTRACTION');
  });

  test('wider coverage: "4D Movies" is a SHOW and "Food & Drinks" is a RESTAURANT', async () => {
    const entities = await new Probe().entities();
    expect(entities.find(e => e.id === '201')?.entityType).toBe('SHOW');
    expect(entities.find(e => e.id === '301')?.entityType).toBe('RESTAURANT');
  });

  test('an item under an unrecognised category (Shopping) is not emitted', async () => {
    const entities = await new Probe().entities();
    expect(entities.find(e => e.id === '400')).toBeUndefined();
  });
});

describe('buildLiveData', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOON);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test('an operational attraction reports OPERATING with the standby wait in minutes', async () => {
    const live = await new Probe().live();
    const entry = live.find(l => l.id === '100');
    expect(entry.status).toBe('OPERATING');
    expect(entry.queue.STANDBY.waitTime).toBe(30);
  });

  test('a restaurant with a live IsOpen:true is OPERATING regardless of the window', async () => {
    const live = await new Probe().live();
    expect(live.find(l => l.id === '300').status).toBe('OPERATING');
  });

  test('a restaurant with no IsOpen falls back to the window: open now → OPERATING', async () => {
    const live = await new Probe().live();
    expect(live.find(l => l.id === '301').status).toBe('OPERATING');
  });

  test('a restaurant with no IsOpen falls back to the window: past its hours → CLOSED', async () => {
    const live = await new Probe().live();
    expect(live.find(l => l.id === '302').status).toBe('CLOSED');
  });

  test('a show with an upcoming point start is OPERATING and lists the time', async () => {
    const live = await new Probe().live();
    const show = live.find(l => l.id === '200'); // 14:00, after our noon "now"
    expect(show.status).toBe('OPERATING');
    expect(show.showtimes).toHaveLength(1);
    expect(show.showtimes[0].startTime.startsWith('2026-07-08T14:00:00')).toBe(true);
  });

  test('a malformed ShowTimes record does not crash live data for the whole park', async () => {
    const live = await new Probe().live();
    // The broken show (202) is contained — it neither throws nor emits bogus
    // times — while every other entity still gets live data.
    expect(() => live).not.toThrow();
    const broken = live.find(l => l.id === '202');
    expect(broken.showtimes).toBeUndefined();
    expect(broken.status).toBe('CLOSED');
    // The sibling attraction and restaurants still came through.
    expect(live.find(l => l.id === '100')).toBeDefined();
    expect(live.find(l => l.id === '300')).toBeDefined();
  });
});

describe('parseLiveOpeningTimes', () => {
  test('parses a single stringified range object into one OPERATING slot', () => {
    const slots = parseLiveOpeningTimes(range('10:00:00', '18:00:00'), TZ);
    expect(slots).toHaveLength(1);
    expect(slots[0].type).toBe('OPERATING');
    expect(slots[0].startTime.startsWith('2026-07-08T10:00:00')).toBe(true);
    expect(slots[0].endTime?.startsWith('2026-07-08T18:00:00')).toBe(true);
  });

  test('parses an array of ranges', () => {
    const raw = JSON.stringify([
      {type: 'range', start: `${DATE} 10:00:00`, end: `${DATE} 13:00:00`},
      {type: 'range', start: `${DATE} 14:00:00`, end: `${DATE} 18:00:00`},
    ]);
    expect(parseLiveOpeningTimes(raw, TZ)).toHaveLength(2);
  });

  test('returns [] for null / blank / non-JSON / non-range input', () => {
    expect(parseLiveOpeningTimes(null, TZ)).toEqual([]);
    expect(parseLiveOpeningTimes(undefined, TZ)).toEqual([]);
    expect(parseLiveOpeningTimes('', TZ)).toEqual([]);
    expect(parseLiveOpeningTimes('not json', TZ)).toEqual([]);
    expect(parseLiveOpeningTimes('{"type":"closed"}', TZ)).toEqual([]);
  });

  test('skips a range whose bounds are missing or non-string', () => {
    expect(parseLiveOpeningTimes('{"type":"range","start":123,"end":456}', TZ)).toEqual([]);
    expect(parseLiveOpeningTimes('{"type":"range","start":"bad","end":"also-bad"}', TZ)).toEqual([]);
  });
});
