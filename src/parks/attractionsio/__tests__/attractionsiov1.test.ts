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
import {
  AttractionsIOV1,
  ChessingtonWorldOfAdventures,
  isOpeningWindowSchedule,
  parseLiveOpeningTimes,
  parseShowTimes,
} from '../attractionsiov1.js';
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

  _calendar: any = {Locations: [{days: []}]};

  override async fetchCalendar(): Promise<any> {
    return {json: async () => this._calendar};
  }

  schedules(): Promise<any[]> {
    return (this as any)._buildCalendarSchedules();
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

/**
 * Seasonal content is often filed under a category the name lists can never
 * know in advance: Chessington keeps "Howl’o’ween ", "Summer " and "Winter's
 * Tail " as top-level categories, Legoland Korea uses "Season Content", and
 * Legoland California nests "Brick or Treat" > "SHOWS". The feed's own
 * ShowTimes schedule is what marks a performance, so an otherwise unclassified
 * item carrying one is a SHOW.
 */
function mkSeasonalRecords(): any {
  const records = mkRecords();
  records.Category.push(
    {_id: 50, Name: 'Summer '},                       // top-level, trailing space (Chessington)
    {_id: 51, Name: 'Brick or Treat'},
    {_id: 52, Name: 'SHOWS', Parent: 51},             // not in the list (case differs)
    {_id: 60, Name: 'Ride Access Pass'},              // Thorpe Park's per-ride pass duplicates
  );
  records.Item.push(
    {_id: 500, Name: 'Lands Unite: A Grand Adventure', Category: 50, ShowTimes: pointShow('16:00:00')},
    {_id: 501, Name: 'Monster Rock Off', Category: 52, ShowTimes: pointShow('13:00:00')},
    {_id: 502, Name: 'Seasonal Walkthrough', Category: 50},
    {_id: 503, Name: 'Empty Schedule', Category: 50, ShowTimes: ''},
    {_id: 504, Name: 'Null Schedule', Category: 50, ShowTimes: null},
    {_id: 600, Name: 'Big Coaster | Ride Access Pass', Category: 60, MinimumHeightRequirement: 1.4},
    // A ride that also carries a ShowTimes blob keeps its category's type.
    {_id: 102, Name: 'Coaster With Schedule', Category: 10, ShowTimes: pointShow('12:00:00')},
    // Shopping item with a schedule (e.g. a demo): has a performance, so SHOW.
    {_id: 401, Name: 'Sweet Making Demo', Category: 40, ShowTimes: pointShow('15:30:00')},
  );
  return records;
}

describe('buildEntityList — ShowTimes fallback for unlisted categories', () => {
  test('an item with ShowTimes under a top-level seasonal category is a SHOW', async () => {
    const entities = await new Probe(mkSeasonalRecords()).entities();
    const show = entities.find(e => e.id === '500');
    expect(show?.entityType).toBe('SHOW');
    expect(show?.parentId).toBe('probe-park');
    expect(show?.name).toBe('Lands Unite: A Grand Adventure');
  });

  test('an item with ShowTimes under an unlisted child category is a SHOW', async () => {
    const entities = await new Probe(mkSeasonalRecords()).entities();
    expect(entities.find(e => e.id === '501')?.entityType).toBe('SHOW');
    expect(entities.find(e => e.id === '401')?.entityType).toBe('SHOW');
  });

  test('an unlisted item without a schedule is still not emitted', async () => {
    const entities = await new Probe(mkSeasonalRecords()).entities();
    for (const id of ['502', '503', '504', '400']) {
      expect(entities.find(e => e.id === id)).toBeUndefined();
    }
  });

  test('a height requirement alone does not make an unlisted item an attraction', async () => {
    const entities = await new Probe(mkSeasonalRecords()).entities();
    expect(entities.find(e => e.id === '600')).toBeUndefined();
  });

  test('an item already classified by category is not emitted a second time', async () => {
    const entities = await new Probe(mkSeasonalRecords()).entities();
    const coaster = entities.filter(e => e.id === '102');
    expect(coaster).toHaveLength(1);
    expect(coaster[0].entityType).toBe('ATTRACTION');
    const ids = entities.map(e => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test('a fallback SHOW gets its showtimes in live data', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOON);
    try {
      const live = await new Probe(mkSeasonalRecords()).live();
      const entry = live.find(l => l.id === '500');
      expect(entry?.status).toBe('OPERATING');
      expect(entry?.showtimes?.[0]?.startTime).toBe(`${DATE}T16:00:00+02:00`);
    } finally {
      vi.useRealTimers();
    }
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

  test('an attraction with IsOpen:true but IsOperational:false is OPERATING (unmetered rides, e.g. Djurs)', async () => {
    const live = mkLive();
    live.entities.Item.records.push(
      {_id: 101, IsOperational: false, IsOpen: true, OpeningTimes: range('10:00:00', '20:00:00')},
    );
    const result = await new Probe(mkRecords(), live).live();
    expect(result.find(l => l.id === '101').status).toBe('OPERATING');
  });

  test('an attraction with an explicit IsOpen:false is CLOSED even when IsOperational is true', async () => {
    const live = mkLive();
    live.entities.Item.records[0] = {_id: 100, IsOperational: true, IsOpen: false, QueueTime: 1800};
    const result = await new Probe(mkRecords(), live).live();
    expect(result.find(l => l.id === '100').status).toBe('CLOSED');
  });

  test('an attraction with no IsOpen falls back to IsOperational: false → CLOSED', async () => {
    const live = mkLive();
    live.entities.Item.records.push({_id: 101, IsOperational: false});
    const result = await new Probe(mkRecords(), live).live();
    expect(result.find(l => l.id === '101').status).toBe('CLOSED');
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
    expect(slots[0].startTime?.startsWith('2026-07-08T10:00:00')).toBe(true);
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


describe('_buildCalendarSchedules', () => {
  /** Build a probe whose calendar returns exactly these day rows. */
  function withDays(days: Array<{key: string; openingHours: string}>) {
    const p = new Probe();
    p._calendar = {Locations: [{days}]};
    return p;
  }

  test('keeps a day whose closing time carries minutes (issue #545)', async () => {
    // Verbatim rows from the LEGOLAND Windsor calendar for September 2026.
    // The "4:30pm" days were previously dropped, so the API returned only
    // Friday-Sunday for the rest of the month.
    const [{schedule}] = await withDays([
      {key: '20260906', openingHours: '10am - 6pm'},
      {key: '20260907', openingHours: '10am - 4:30pm'},
      {key: '20260908', openingHours: '10am - 4:30pm'},
      {key: '20260911', openingHours: '10am - 5pm'},
    ]).schedules();

    expect(schedule.map((s: any) => s.date)).toEqual([
      '2026-09-06',
      '2026-09-07',
      '2026-09-08',
      '2026-09-11',
    ]);
    const sept7 = schedule.find((s: any) => s.date === '2026-09-07');
    expect(sept7.type).toBe('OPERATING');
    expect(sept7.openingTime).toContain('T10:00:00');
    expect(sept7.closingTime).toContain('T16:30:00');
  });

  test('still drops a genuinely unparseable day, and warns about it', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const [{schedule}] = await withDays([
        {key: '20260906', openingHours: '10am - 6pm'},
        {key: '20260907', openingHours: 'Closed'},
        {key: '20260908', openingHours: 'Closed'},
      ]).schedules();

      expect(schedule.map((s: any) => s.date)).toEqual(['2026-09-06']);
      expect(warn).toHaveBeenCalledTimes(1);
      const msg = warn.mock.calls[0][0] as string;
      expect(msg).toContain('dropped 2 calendar day(s)');
      expect(msg).toContain('2x "Closed"');
    } finally {
      warn.mockRestore();
    }
  });

  test('does not warn when every day parses', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await withDays([{key: '20260906', openingHours: '10am - 6pm'}]).schedules();
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});

/**
 * Chessington's zoo sits in a top-level "Zoo Encounters" category holding both
 * walk-through animal areas and keeper talks. Sanitised from the live records:
 * Wanyama Village's ShowTimes is a daily 10:00 + 300-minute window inside
 * seasonal date ranges (weekends only in two of them).
 */
const WANYAMA_SHOWTIMES = JSON.stringify({
  type: 'union',
  children: [
    {type: 'intersection', children: [
      {type: 'range', start: '2025-01-25 00:00:00', end: '2025-02-17 00:00:00'},
      {type: 'period', offset_date: '2018-01-06 00:00:00', period_length: {day: 7}, range_length: {day: 2}},
      {type: 'period', offset_date: '2020-01-01 10:00:00', period_length: {day: 1}, range_length: {minute: 300}},
    ]},
    {type: 'intersection', children: [
      {type: 'range', start: '2025-02-17 00:00:00', end: '2025-02-24 00:00:00'},
      {type: 'period', offset_date: '2020-01-01 10:00:00', period_length: {day: 1}, range_length: {minute: 300}},
    ]},
  ],
});

// The same shape with its season moved onto the test date, for live data.
const WANYAMA_IN_SEASON = JSON.stringify({
  type: 'intersection',
  children: [
    {type: 'range', start: '2026-07-01 00:00:00', end: '2026-07-31 00:00:00'},
    {type: 'period', offset_date: '2020-01-01 10:00:00', period_length: {day: 1}, range_length: {minute: 300}},
  ],
});

// A keeper talk: one 20-minute slot a day.
const TALK_SHOWTIMES = JSON.stringify({
  type: 'period', offset_date: '2020-01-01 13:30:00', period_length: {day: 1}, range_length: {minute: 20},
});

function mkZooRecords(wanyamaShowTimes: string = WANYAMA_SHOWTIMES): any {
  const records = mkRecords();
  records.Category.push(
    {_id: 1666, Name: 'Zoo Encounters'},
    {_id: 1809, Name: 'Zoo Areas', Parent: 1666},
    {_id: 1810, Name: 'Animal Talks, Feeds & Presentation', Parent: 1666},
    {_id: 1595, Name: 'Character Meet & Greets', Parent: 469},
    {_id: 469, Name: 'Entertainment'},
  );
  records.Item.push(
    {_id: 10846, Name: 'Wanyama Village', Category: 1666, ShowTimes: wanyamaShowTimes,
      Location: '51.350113163735,-0.31766969444274'},
    {_id: 10844, Name: 'Trail of the Kings', Category: 1666},
    {_id: 4448, Name: 'Blacktip Reef Shark Talk', Category: 1666},
    {_id: 24671, Name: 'Penguin Talk & Feed', Category: 1666, ShowTimes: TALK_SHOWTIMES},
    {_id: 24672, Name: 'Otter Feed', Category: 1666, ShowTimes: pointShow('11:30:00')},
    {_id: 10462, Name: 'Gruffalo Meet & Greet', Category: 1595, ShowTimes: pointShow('14:00:00')},
  );
  return records;
}

function chessington(records: any, live: any = mkLive()): any {
  const park: any = new ChessingtonWorldOfAdventures();
  park.getPOIData = async () => records;
  park.fetchLiveData = async () => ({json: async () => live});
  return park;
}

describe('isOpeningWindowSchedule', () => {
  test('a daily multi-hour window is opening hours', () => {
    expect(isOpeningWindowSchedule(parseShowTimes(WANYAMA_SHOWTIMES))).toBe(true);
    expect(isOpeningWindowSchedule(parseShowTimes(WANYAMA_IN_SEASON))).toBe(true);
  });

  test('short slots and point starts are performances', () => {
    expect(isOpeningWindowSchedule(parseShowTimes(TALK_SHOWTIMES))).toBe(false);
    expect(isOpeningWindowSchedule(parseShowTimes(pointShow('14:00:00')))).toBe(false);
  });

  test('a long window alongside a short slot is not opening hours', () => {
    const mixed = JSON.stringify({type: 'union', children: [JSON.parse(WANYAMA_IN_SEASON), JSON.parse(TALK_SHOWTIMES)]});
    expect(isOpeningWindowSchedule(parseShowTimes(mixed))).toBe(false);
  });

  test('a schedule with no daily period, or none at all, is not opening hours', () => {
    expect(isOpeningWindowSchedule(parseShowTimes(range('10:00:00', '18:00:00')))).toBe(false);
    expect(isOpeningWindowSchedule(null)).toBe(false);
  });
});

describe('Chessington walk-through zoo areas', () => {
  test('Wanyama Village is an ATTRACTION with an explicit attractionType, under its existing id', async () => {
    const entities = await chessington(mkZooRecords()).getEntities();
    const wanyama = entities.find((e: any) => e.id === '10846');
    expect(wanyama).toMatchObject({
      id: '10846',
      name: 'Wanyama Village',
      entityType: 'ATTRACTION',
      attractionType: 'RIDE',
      parentId: 'chessingtonworldofadventures',
    });
  });

  test('scheduled talks and feeds in the same category stay SHOW', async () => {
    const entities = await chessington(mkZooRecords()).getEntities();
    expect(entities.find((e: any) => e.id === '24671')?.entityType).toBe('SHOW');
    expect(entities.find((e: any) => e.id === '24672')?.entityType).toBe('SHOW');
    expect(entities.find((e: any) => e.id === '10462')?.entityType).toBe('SHOW');
    expect((entities.find((e: any) => e.id === '24671') as any).attractionType).toBeUndefined();
  });

  test('zoo items without a schedule are still not emitted', async () => {
    const entities = await chessington(mkZooRecords()).getEntities();
    expect(entities.find((e: any) => e.id === '10844')).toBeUndefined();
    expect(entities.find((e: any) => e.id === '4448')).toBeUndefined();
  });

  test('ids are unique and every other entity keeps its type', async () => {
    const entities = await chessington(mkZooRecords()).getEntities();
    const ids = entities.map((e: any) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(entities.find((e: any) => e.id === '100')?.entityType).toBe('ATTRACTION');
    expect(entities.find((e: any) => e.id === '200')?.entityType).toBe('SHOW');
  });

  test('other parks do not opt in: the same record stays a SHOW', async () => {
    const entities = await new Probe(mkZooRecords()).entities();
    expect(entities.find(e => e.id === '10846')?.entityType).toBe('SHOW');
  });

  describe('live data', () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    // The live feed carries Wanyama Village at IsOperational:false with no
    // OpeningTimes regardless of the hour; that must not pin it CLOSED.
    const liveWithWanyama = () => {
      const live = mkLive();
      live.entities.Item.records.push({_id: 10846, IsOperational: false, OpeningTimes: null});
      return live;
    };

    test('inside its window it is OPERATING, with the window as operatingHours', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(NOON); // 11:00 London
      const live = await chessington(mkZooRecords(WANYAMA_IN_SEASON), liveWithWanyama()).getLiveData();
      const rows = live.filter((l: any) => l.id === '10846');
      expect(rows).toHaveLength(1);
      expect(rows[0].status).toBe('OPERATING');
      expect(rows[0].queue).toBeUndefined();
      expect(rows[0].showtimes).toBeUndefined();
      expect(rows[0].operatingHours).toEqual([{
        type: 'OPERATING',
        startTime: `${DATE}T10:00:00+01:00`,
        endTime: `${DATE}T15:00:00+01:00`,
      }]);
    });

    test('after its window it is CLOSED', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date(`${DATE}T15:30:00Z`)); // 16:30 London
      const live = await chessington(mkZooRecords(WANYAMA_IN_SEASON), liveWithWanyama()).getLiveData();
      expect(live.find((l: any) => l.id === '10846').status).toBe('CLOSED');
    });

    test('out of season it is CLOSED with no hours', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(NOON);
      const live = await chessington(mkZooRecords(), liveWithWanyama()).getLiveData();
      const row = live.find((l: any) => l.id === '10846');
      expect(row.status).toBe('CLOSED');
      expect(row.operatingHours).toBeUndefined();
    });
  });
});
