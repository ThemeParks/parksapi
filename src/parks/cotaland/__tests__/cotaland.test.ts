import {describe, test, expect, vi, beforeEach, afterEach} from 'vitest';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {dirname, resolve} from 'node:path';
import {
  Cotaland,
  cotalandEntities,
  cotalandEntityType,
  cotalandFeedIsStale,
  cotalandLiveData,
  cotalandParkIsOpen,
  cotalandScheduleEntries,
  type CotalandCalendarEvent,
  type CotalandPoi,
  type CotalandPoiFeed,
} from '../cotaland.js';
import {CacheLib} from '../../../cache.js';
import type {HTTPObj} from '../../../http.js';
import {withoutRaw} from '../../../__tests__/helpers/withoutRaw.js';

const liveRows = (...args: Parameters<typeof cotalandLiveData>) => withoutRaw(cotalandLiveData(...args));

/**
 * COTALAND publishes two things this module joins:
 *
 *  - the app's point feed, republished every few minutes, carrying a `status`
 *    and `waitTime` per point;
 *  - the website's hours calendar, one event per block of park hours.
 *
 * The point feed's `status` is not a live reading on its own. The fixture was
 * captured on a Wednesday afternoon with the park shut (no calendar entry that
 * day), and every point reads "Open" with a null wait. The live-data rules
 * below exist because of that.
 *
 * Fixtures are trimmed from the live feeds on 2026-09-30.
 */

const TZ = 'America/Chicago';
const FIXTURES = resolve(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const fixture = <T>(name: string): T => JSON.parse(readFileSync(resolve(FIXTURES, name), 'utf8'));

const feed = fixture<CotalandPoiFeed>('pointsOfInterest.json');
const calendarPages = [fixture<any>('calendar-page1.json'), fixture<any>('calendar-page2.json')];
const allEvents: CotalandCalendarEvent[] = calendarPages.flatMap(page => page.events);

const byId = (id: string) => feed.data!.find(poi => String(poi.id) === id)!;
const poi = (overrides: Partial<CotalandPoi>): CotalandPoi => ({
  id: 6181,
  name: 'Circuit Breaker ',
  status: 'Open',
  waitTime: null,
  latitude: 30.133144,
  longitude: -97.645005,
  categories: [{id: 41, name: 'Attractions'}],
  isActive: true,
  ...overrides,
});

describe('cotalandEntityType', () => {
  test('rides, shows and restaurants come from the feed category', () => {
    expect(cotalandEntityType(byId('6181'))).toEqual({entityType: 'ATTRACTION', attractionType: 'RIDE'}); // Circuit Breaker
    expect(cotalandEntityType(byId('6322'))).toEqual({entityType: 'SHOW'}); // Fang's Magnificent Magic Show!
    expect(cotalandEntityType(byId('6149'))).toEqual({entityType: 'RESTAURANT'}); // T20 Restaurant & Terrace
  });

  test('attractions-category points that are not attractions are dropped', () => {
    for (const id of ['6333', '6307', '6313']) { // Speed City, "Perfect Hug", Rose Garden
      expect(byId(id).categories!.map(c => c.name)).toEqual(['Attractions']);
      expect(cotalandEntityType(byId(id)), byId(id).name).toBeUndefined();
    }
  });

  test('the splash pad is a play area, not a ride', () => {
    expect(cotalandEntityType(byId('6324'))).toEqual({entityType: 'ATTRACTION', attractionType: 'OTHER'});
  });

  test('the uncategorised butterfly walk-through is published as a ride', () => {
    expect(byId('6319').categories).toEqual([]);
    expect(cotalandEntityType(byId('6319'))).toEqual({entityType: 'ATTRACTION', attractionType: 'RIDE'});
  });

  test('restrooms, services, shops, games and uncategorised areas are not published', () => {
    for (const id of ['6332', '6331', '6182', '6150', '6335', '6317', '6328']) {
      expect(cotalandEntityType(byId(id)), byId(id).name).toBeUndefined();
    }
  });
});

describe('cotalandEntities', () => {
  const entities = cotalandEntities(feed.data!, TZ);

  test('publishes the expected mix from the live feed', () => {
    const count = (type: string) => entities.filter(e => e.entityType === type).length;
    expect(count('ATTRACTION')).toBe(30); // 32 in the category, less 3 non-attractions, plus the walk-through
    expect(count('SHOW')).toBe(6);
    expect(count('RESTAURANT')).toBe(15);
    expect(entities).toHaveLength(51);
  });

  test('ids are strings and unique', () => {
    expect(entities.every(e => typeof e.id === 'string')).toBe(true);
    expect(new Set(entities.map(e => e.id)).size).toBe(entities.length);
  });

  test('names are trimmed and descriptions are plain text', () => {
    // `description` is emitted by several parks but is not on typelib's Entity.
    const circuitBreaker = entities.find(e => e.id === '6181')! as typeof entities[number] & {description?: string};
    expect(circuitBreaker.name).toBe('Circuit Breaker');
    expect(circuitBreaker.description).toMatch(/^Texas's only tilt coaster/);
    expect(circuitBreaker.description).not.toMatch(/<|&#/);
  });

  test('every entity hangs off the park with its own coordinates', () => {
    for (const entity of entities) {
      expect(entity.parentId).toBe('cotaland-park');
      expect(entity.destinationId).toBe('cotaland');
      expect(entity.timezone).toBe(TZ);
    }
    expect(entities.find(e => e.id === '6181')!.location).toEqual({latitude: 30.133144, longitude: -97.645005});
  });

  test('a missing or empty coordinate publishes no location rather than 0,0', () => {
    const [missing] = cotalandEntities([poi({latitude: null, longitude: null})], TZ);
    const [empty] = cotalandEntities([poi({latitude: '', longitude: ''})], TZ);
    expect(missing.location).toBeUndefined();
    expect(empty.location).toBeUndefined();
  });

  test('an inactive point is not published', () => {
    expect(cotalandEntities([poi({isActive: false})], TZ)).toEqual([]);
  });
});

describe('cotalandScheduleEntries', () => {
  const schedule = cotalandScheduleEntries(allEvents, TZ);

  test('every calendar entry becomes a block of operating hours', () => {
    expect(schedule).toHaveLength(allEvents.length);
    expect(schedule.every(entry => entry.type === 'OPERATING')).toBe(true);
  });

  test('times are park-local, across the end of daylight saving', () => {
    const on = (date: string) => schedule.find(entry => entry.date === date)!;
    expect(on('2026-10-31')).toMatchObject({openingTime: '2026-10-31T10:00:00-05:00', closingTime: '2026-10-31T19:00:00-05:00'});
    expect(on('2026-11-01')).toMatchObject({openingTime: '2026-11-01T10:00:00-06:00', closingTime: '2026-11-01T18:00:00-06:00'});
  });

  test('plain opening days carry no description; restricted ones keep the restriction', () => {
    const on = (date: string) => schedule.find(entry => entry.date === date)!;
    expect(on('2026-10-03').description).toBeUndefined(); // "Park Open"
    expect(on('2026-10-10').description).toBeUndefined(); // "PARK OPEN"
    expect(on('2026-10-23')).toMatchObject({
      description: 'F1 Weekend Blackout (Must Have F1 Ticket)',
      openingTime: '2026-10-23T09:00:00-05:00',
      closingTime: '2026-10-23T22:00:00-05:00',
    });
    expect(on('2026-09-26').description).toBe('Grand Opening');
  });

  test('closed days are absent, not published as zero-length hours', () => {
    expect(schedule.find(entry => entry.date === '2026-09-30')).toBeUndefined();
  });

  test('an unrecognised title is skipped with a warning', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const entries = cotalandScheduleEntries([
      {id: 1, title: 'Fireworks Spectacular', start_date: '2026-10-03 20:00:00', end_date: '2026-10-03 20:30:00', timezone: TZ},
    ], TZ);
    expect(entries).toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Fireworks Spectacular'));
    warn.mockRestore();
  });

  test('an all-day entry has no hours to publish and is skipped', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const entries = cotalandScheduleEntries([
      {id: 1, title: 'PARK OPEN', start_date: '2026-10-03 00:00:00', end_date: '2026-10-03 23:59:59', all_day: true, timezone: TZ},
    ], TZ);
    expect(entries).toEqual([]);
    warn.mockRestore();
  });

  test('a closing time on the following day keeps its own date', () => {
    const [entry] = cotalandScheduleEntries([
      {id: 1, title: 'PARK OPEN', start_date: '2026-12-31 18:00:00', end_date: '2027-01-01 01:00:00', timezone: TZ},
    ], TZ);
    expect(entry).toMatchObject({date: '2026-12-31', closingTime: '2027-01-01T01:00:00-06:00'});
  });
});

describe('cotalandParkIsOpen', () => {
  const schedule = cotalandScheduleEntries(allEvents, TZ);

  test('inside, at the edges of, and outside a block of hours', () => {
    // 2026-10-03 10:00-19:00 CDT = 15:00-00:00 UTC
    expect(cotalandParkIsOpen(schedule, new Date('2026-10-03T14:59:59Z'))).toBe(false);
    expect(cotalandParkIsOpen(schedule, new Date('2026-10-03T15:00:00Z'))).toBe(true);
    expect(cotalandParkIsOpen(schedule, new Date('2026-10-03T23:59:59Z'))).toBe(true);
    expect(cotalandParkIsOpen(schedule, new Date('2026-10-04T00:00:00Z'))).toBe(false);
  });

  test('a day with no calendar entry is closed all day', () => {
    // Wednesday 2026-09-30, 16:51 CDT: the moment the fixture was captured.
    expect(cotalandParkIsOpen(schedule, new Date('2026-09-30T21:51:02Z'))).toBe(false);
  });
});

describe('cotalandLiveData', () => {
  const ids = new Set(['6181']);
  const one = (overrides: Partial<CotalandPoi>, parkOpen: boolean | null) =>
    liveRows([poi(overrides)], ids, parkOpen);

  test('the captured feed, park shut: every published point is CLOSED, not "Open"', () => {
    const entityIds = new Set(cotalandEntities(feed.data!, TZ).map(e => e.id));
    const live = liveRows(feed.data!, entityIds, false);
    expect(live).toHaveLength(entityIds.size);
    expect(live.every(ld => ld.status === 'CLOSED')).toBe(true);
    expect(live.some(ld => ld.queue)).toBe(false);
  });

  test('"Open" with no reading is OPERATING only while the park is open', () => {
    expect(one({status: 'Open', waitTime: null}, true)).toEqual([{id: '6181', status: 'OPERATING'}]);
    expect(one({status: 'Open', waitTime: null}, false)).toEqual([{id: '6181', status: 'CLOSED'}]);
  });

  test('a positive wait is a live reading and wins over the calendar', () => {
    expect(one({status: 'Open', waitTime: 25}, false)).toEqual([
      {id: '6181', status: 'OPERATING', queue: {STANDBY: {waitTime: 25}}},
    ]);
  });

  test('a zero wait is not a reading outside hours, but is published inside them', () => {
    expect(one({status: 'Open', waitTime: 0}, false)).toEqual([{id: '6181', status: 'CLOSED'}]);
    expect(one({status: 'Open', waitTime: 0}, true)).toEqual([
      {id: '6181', status: 'OPERATING', queue: {STANDBY: {waitTime: 0}}},
    ]);
  });

  test('a non-"Open" status is published as given, whatever the calendar says', () => {
    expect(one({status: 'Closed'}, true)).toEqual([{id: '6181', status: 'CLOSED'}]);
    expect(one({status: 'Down', waitTime: 30}, true)).toEqual([{id: '6181', status: 'DOWN'}]);
  });

  test('an unknown status warns and falls back to CLOSED', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(one({status: 'Swapped for a sheep'}, true)).toEqual([{id: '6181', status: 'CLOSED'}]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Swapped for a sheep'));
    warn.mockRestore();
  });

  test('with no calendar, only rows that carry their own reading are published', () => {
    expect(one({status: 'Open', waitTime: null}, null)).toEqual([]);
    expect(one({status: 'Open', waitTime: 0}, null)).toEqual([]);
    expect(one({status: 'Open', waitTime: 15}, null)).toEqual([
      {id: '6181', status: 'OPERATING', queue: {STANDBY: {waitTime: 15}}},
    ]);
    expect(one({status: 'Closed'}, null)).toEqual([{id: '6181', status: 'CLOSED'}]);
  });

  test('non-numeric and negative waits are no reading', () => {
    expect(one({status: 'Open', waitTime: '' as any}, false)).toEqual([{id: '6181', status: 'CLOSED'}]);
    expect(one({status: 'Open', waitTime: -1}, true)).toEqual([{id: '6181', status: 'OPERATING'}]);
  });

  test('points that are not published entities are ignored', () => {
    expect(liveRows([poi({id: 6332, waitTime: 10})], ids, true)).toEqual([]);
  });
});

describe('cotalandFeedIsStale', () => {
  const now = new Date('2026-10-03T18:00:00Z');
  test('fresh, just inside, just outside, in the future, and missing', () => {
    expect(cotalandFeedIsStale('2026-10-03T17:55:00Z', now, 30)).toBe(false);
    expect(cotalandFeedIsStale('2026-10-03T17:30:00Z', now, 30)).toBe(false);
    expect(cotalandFeedIsStale('2026-10-03T17:29:59Z', now, 30)).toBe(true);
    expect(cotalandFeedIsStale('2026-10-03T18:01:00Z', now, 30)).toBe(false);
    expect(cotalandFeedIsStale(undefined, now, 30)).toBe(true);
    expect(cotalandFeedIsStale('not a date', now, 30)).toBe(true);
  });
});

describe('Cotaland destination', () => {
  const asJson = (body: any) => (async () => ({json: async () => body}) as any as HTTPObj) as any;

  function stubbedPark(points: CotalandPoiFeed, pages = calendarPages) {
    const park = new Cotaland({config: {apiBase: 'https://feed.invalid', webBase: 'https://web.invalid'}});
    park.fetchPointsOfInterest = asJson(points);
    const calendar = vi.fn(async (_start: string, _end: string, page: number) => ({json: async () => pages[page - 1]}) as any as HTTPObj);
    park.fetchCalendarPage = calendar as any;
    return {park, calendar};
  }

  beforeEach(() => {
    CacheLib.clearAll();
    vi.useFakeTimers({toFake: ['Date']});
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  test('entities: destination, park and the published points', async () => {
    const {park} = stubbedPark(feed);
    const entities = await park.getEntities();
    expect(entities.find(e => e.id === 'cotaland')?.entityType).toBe('DESTINATION');
    expect(entities.find(e => e.id === 'cotaland-park')?.entityType).toBe('PARK');
    expect(entities.find(e => e.id === '6181')?.parkId).toBe('cotaland-park');
    expect(entities).toHaveLength(53);
  });

  test('schedules: follows every page of the calendar from the park-local today', async () => {
    // 23:30 CDT on 2026-09-30 is already 2026-10-01 in UTC.
    vi.setSystemTime(new Date('2026-10-01T04:30:00Z'));
    const {park, calendar} = stubbedPark(feed);
    const [schedule] = await park.getSchedules();
    expect(calendar).toHaveBeenCalledTimes(2);
    expect(calendar.mock.calls[0].slice(0, 2)).toEqual(['2026-09-30', '2027-01-27']);
    expect(schedule.id).toBe('cotaland-park');
    expect(schedule.schedule).toHaveLength(allEvents.length);
  });

  test('live data at capture time (park shut): all CLOSED', async () => {
    vi.setSystemTime(new Date('2026-09-30T21:52:00Z'));
    const {park} = stubbedPark(feed);
    const live = await park.getLiveData();
    expect(live.length).toBeGreaterThan(0);
    expect(live.every(ld => ld.status === 'CLOSED')).toBe(true);
  });

  test('live data during published hours: OPERATING', async () => {
    vi.setSystemTime(new Date('2026-10-03T18:00:00Z'));
    const {park} = stubbedPark({...feed, timestamp: '2026-10-03T17:58:00Z'});
    const live = await park.getLiveData();
    expect(live.find(ld => ld.id === '6181')).toEqual({id: '6181', status: 'OPERATING'});
    expect(live.every(ld => ld.status === 'OPERATING')).toBe(true);
  });

  test('live data from a feed that stopped publishing is withheld', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.setSystemTime(new Date('2026-10-03T18:00:00Z'));
    const {park} = stubbedPark(feed); // published 2026-09-30
    expect(await park.getLiveData()).toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('withholding live data'));
    warn.mockRestore();
  });

  test('live data when the calendar is down: readings only, no guesses', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.setSystemTime(new Date('2026-10-03T18:00:00Z'));
    const points: CotalandPoiFeed = {
      timestamp: '2026-10-03T17:58:00Z',
      data: [poi({id: 6181, waitTime: 20}), poi({id: 6180, name: 'Palindrome', waitTime: null})],
    };
    const {park} = stubbedPark(points);
    park.fetchCalendarPage = (async () => { throw new Error('403'); }) as any;
    expect(await park.getLiveData()).toEqual([
      {id: '6181', status: 'OPERATING', queue: {STANDBY: {waitTime: 20}}},
    ]);
    warn.mockRestore();
  });

  test('an empty point feed fails the entity list rather than publishing a partial one', async () => {
    const {park} = stubbedPark({timestamp: feed.timestamp, data: []});
    await expect(park.getEntities()).rejects.toThrow(/no points/);
  });
});
