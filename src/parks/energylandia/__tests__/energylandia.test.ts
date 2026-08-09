import {describe, test, expect, beforeEach, afterEach} from 'vitest';
import {
  Energylandia,
  fsId,
  fsLocalised,
  parseWaitMinutes,
  stripCatalogueNumber,
  buildScheduleIndex,
  isWithinOperatingWindow,
  parkLocalDateTime,
  buildLocationIndex,
} from '../energylandia.js';
import {CacheLib} from '../../../cache.js';

const doc = (id: string, fields: Record<string, any>) => ({
  name: `projects/p/databases/(default)/documents/attractions/${id}`,
  fields,
});

const str = (v: string) => ({stringValue: v});
const int = (v: string | number) => ({integerValue: String(v)});
const bool = (v: boolean) => ({booleanValue: v});
const nameMap = (m: Record<string, string>) => ({
  mapValue: {fields: Object.fromEntries(Object.entries(m).map(([k, v]) => [k, {stringValue: v}]))},
});

/**
 * `queueTimeId` is stored as BOTH integerValue and stringValue in the live
 * collection — 39 numeric, 50 string, 47 of those the empty string. Reading
 * only one shape produced a park that looked healthy (89 attractions, all
 * OPERATING) while silently publishing wait times for 3 rides instead of 42.
 * It is the single highest-value thing to keep pinned.
 */
describe('fsId — the two-shaped Firestore identifier', () => {
  test('reads a stringValue id', () => {
    expect(fsId(str('265'))).toBe('265');
  });

  test('reads an integerValue id — the shape that was silently dropped', () => {
    expect(fsId(int(153))).toBe('153');
  });

  test('treats the empty string as absent rather than coercing it to 0', () => {
    // Number('') is 0, which would collide with the real counter id 0.
    expect(fsId(str(''))).toBeUndefined();
    expect(fsId(str('   '))).toBeUndefined();
  });

  test('returns undefined for a missing field', () => {
    expect(fsId(undefined)).toBeUndefined();
  });
});

describe('parseWaitMinutes', () => {
  test('accepts a normal wait', () => {
    expect(parseWaitMinutes(30)).toBe(30);
  });

  test('accepts 0 as a genuine walk-on', () => {
    expect(parseWaitMinutes(0)).toBe(0);
  });

  test('accepts a numeric string', () => {
    expect(parseWaitMinutes('20')).toBe(20);
  });

  test('passes through an odd-but-real value the park actually publishes', () => {
    // One ride has been observed reporting 310, which the official app renders
    // verbatim as "310 min". Suppressing it would misreport the park and would
    // equally hide a genuine multi-hour queue.
    expect(parseWaitMinutes(310)).toBe(310);
  });

  test('rejects the empty string instead of turning it into a 0-minute wait', () => {
    expect(parseWaitMinutes('')).toBeUndefined();
  });

  test('rejects null, undefined and non-numeric junk', () => {
    expect(parseWaitMinutes(null)).toBeUndefined();
    expect(parseWaitMinutes(undefined)).toBeUndefined();
    expect(parseWaitMinutes('n/a')).toBeUndefined();
  });

  test('rejects negative and impossible values', () => {
    expect(parseWaitMinutes(-1)).toBeUndefined();
    expect(parseWaitMinutes(600)).toBeUndefined();
    expect(parseWaitMinutes(99999)).toBeUndefined();
  });
});

describe('name handling', () => {
  test('lowercases language keys so localisation lookups actually match', () => {
    // The CMS keys languages uppercase (PL/EN/DE); getLocalizedString matches
    // lowercase ISO codes, so without this every lookup misses.
    expect(fsLocalised(nameMap({PL: 'Zadra', EN: 'Zadra EN'}))).toEqual({pl: 'Zadra', en: 'Zadra EN'});
  });

  test('drops blank translations rather than emitting empty names', () => {
    expect(fsLocalised(nameMap({PL: 'Hyperion', EN: '   '}))).toEqual({pl: 'Hyperion'});
  });

  test('strips the catalogue number prefix', () => {
    expect(stripCatalogueNumber('35. Formuła Autodrom')).toBe('Formuła Autodrom');
    expect(stripCatalogueNumber('141. Pepsi Hyperion')).toBe('Pepsi Hyperion');
  });

  test('leaves a name that merely starts with a digit intact', () => {
    expect(stripCatalogueNumber('7D Cinema')).toBe('7D Cinema');
  });
});

describe('buildScheduleIndex', () => {
  test('maps every day of a period to its hours', () => {
    const i = buildScheduleIndex([{openFrom: '10:00', openTo: '20:00', days: ['2026-08-09', '2026-08-10']}]);
    expect(i.get('2026-08-09')).toEqual({open: '10:00', close: '20:00'});
    expect(i.get('2026-08-10')).toEqual({open: '10:00', close: '20:00'});
  });

  test('skips CMS placeholder periods that carry no days', () => {
    expect(buildScheduleIndex([{openFrom: '10:00', openTo: '18:00', days: []}]).size).toBe(0);
  });

  test('skips a 00:00-00:00 period rather than reading it as midnight-to-midnight', () => {
    expect(buildScheduleIndex([{openFrom: '00:00', openTo: '00:00', days: ['2026-03-01']}]).size).toBe(0);
  });

  test('ignores malformed date entries', () => {
    const i = buildScheduleIndex([{openFrom: '10:00', openTo: '18:00', days: ['not-a-date', '2026-08-09']}]);
    expect([...i.keys()]).toEqual(['2026-08-09']);
  });
});

describe('isWithinOperatingWindow', () => {
  const index = buildScheduleIndex([{openFrom: '10:00', openTo: '20:00', days: ['2026-08-09']}]);

  test('inside the window', () => {
    expect(isWithinOperatingWindow(index, '2026-08-09', '12:29')).toBe(true);
  });

  test('before opening and after closing', () => {
    expect(isWithinOperatingWindow(index, '2026-08-09', '03:00')).toBe(false);
    expect(isWithinOperatingWindow(index, '2026-08-09', '22:15')).toBe(false);
  });

  test('an unpublished date is unknown, not closed', () => {
    // Distinct from false: the caller must not manufacture a status from a
    // calendar gap.
    expect(isWithinOperatingWindow(index, '2026-12-25', '12:00')).toBeUndefined();
  });

  test('a past-midnight window does not silently invert', () => {
    const late = buildScheduleIndex([{openFrom: '10:00', openTo: '01:00', days: ['2026-08-09']}]);
    expect(isWithinOperatingWindow(late, '2026-08-09', '23:30')).toBe(true);
    expect(isWithinOperatingWindow(late, '2026-08-09', '00:30')).toBe(true);
    expect(isWithinOperatingWindow(late, '2026-08-09', '05:00')).toBe(false);
  });
});

describe('parkLocalDateTime', () => {
  test('renders the instant in park-local time, not UTC', () => {
    // 2026-08-09T22:30Z is 00:30 the next day in Warsaw (UTC+2 in summer) —
    // the case where using UTC would put the park on the wrong calendar day.
    expect(parkLocalDateTime(new Date('2026-08-09T22:30:00Z'), 'Europe/Warsaw'))
      .toEqual({date: '2026-08-10', time: '00:30'});
  });
});

describe('Energylandia — live data', () => {
  const ATTRACTIONS = [
    doc('a1', {active: bool(true), type: str('attraction'), open: bool(true),
      name: nameMap({PL: '141. Pepsi Hyperion'}), queueTimeId: int(222)}),
    doc('a2', {active: bool(true), type: str('attraction'), open: bool(true),
      name: nameMap({PL: '44. Tsunami Drop'}), queueTimeId: str('153')}),
    doc('a3', {active: bool(true), type: str('attraction'), open: bool(true),
      name: nameMap({PL: '99. No Counter'}), queueTimeId: str('')}),
    doc('x1', {active: bool(false), type: str('attraction'), open: bool(false),
      name: nameMap({PL: 'Retired Ride'}), queueTimeId: int(1)}),
    doc('r1', {active: bool(true), type: str('restaurant'), open: bool(true),
      name: nameMap({PL: 'Pizzeria'}), queueTimeId: int(2)}),
  ];

  const FEED = [
    {ID_ATRAKCJI: 222, ATRAKCJA: '141 PEPSI HYPERION', CZAS_OCZEKIWANIA: 20},
    {ID_ATRAKCJI: 153, ATRAKCJA: '44 TSUNAMI DROP', CZAS_OCZEKIWANIA: 310},
    {ID_ATRAKCJI: 909, ATRAKCJA: 'MAIN TRAIN WINDY', CZAS_OCZEKIWANIA: 310},
    {ID_ATRAKCJI: 1013, ATRAKCJA: 'FAST-PASS FORMULA KOL LICZNIK', CZAS_OCZEKIWANIA: 40},
  ];

  function park(opts: {days?: string[]; open?: string; close?: string} = {}) {
    const p: any = new Energylandia();
    p.waitTimesUrl = 'https://feed.example/';
    p.getAttractionDocs = async () => ATTRACTIONS;
    p.fetchWaitTimes = async () => ({text: async () => JSON.stringify(FEED)});
    p.getCalendarPeriods = async () => [{
      openFrom: opts.open ?? '10:00',
      openTo: opts.close ?? '20:00',
      days: opts.days ?? [],
    }];
    return p;
  }

  beforeEach(() => CacheLib.clear());
  afterEach(() => CacheLib.clear());

  test('only active attractions become entities — restaurants and retired rides are excluded', async () => {
    const entities = await park().getEntities();
    const names = entities.filter((e: any) => e.entityType === 'ATTRACTION').map((e: any) => e.name).sort();
    expect(names).toEqual(['No Counter', 'Pepsi Hyperion', 'Tsunami Drop']);
  });

  test('joins the feed by queueTimeId across BOTH id shapes', async () => {
    const live = await park().getLiveData();
    const byId = Object.fromEntries(live.map((l: any) => [l.id, l.queue?.STANDBY?.waitTime]));
    expect(byId['energylandia-a1']).toBe(20);   // integerValue id
    expect(byId['energylandia-a2']).toBe(310);  // stringValue id
  });

  test('an attraction with no counter is OPERATING with no queue, never a fake 0-minute wait', async () => {
    const live = await park().getLiveData();
    const a3: any = live.find((l: any) => l.id === 'energylandia-a3');
    expect(a3.status).toBe('OPERATING');
    expect(a3.queue).toBeUndefined();
  });

  test('operator-only counter rows never reach output, without needing a blocklist', async () => {
    // MAIN TRAIN WINDY and the FAST-PASS lane have no Firestore attraction, so
    // they drop out of the join on their own.
    const live = await park().getLiveData();
    expect(live.map((l: any) => l.id).sort()).toEqual(
      ['energylandia-a1', 'energylandia-a2', 'energylandia-a3'],
    );
  });

  test('everything is CLOSED outside the published operating hours', async () => {
    // The Firestore `open` flag is true for all of these; it tracks `active`
    // and never changes over a day, so without the schedule gate the park
    // would report every ride OPERATING at 3am.
    const {date} = parkLocalDateTime(new Date(), 'Europe/Warsaw');
    const live = await park({days: [date], open: '23:58', close: '23:59'}).getLiveData();
    expect(live.every((l: any) => l.status === 'CLOSED')).toBe(true);
    expect(live.every((l: any) => l.queue === undefined)).toBe(true);
  });

  test('a calendar gap is treated as open rather than blacking out a running park', async () => {
    const live = await park({days: ['1999-01-01']}).getLiveData();
    expect(live.every((l: any) => l.status === 'OPERATING')).toBe(true);
  });

  test('a feed outage degrades to status-only rather than taking the park down', async () => {
    const p = park();
    p.fetchWaitTimes = async () => { throw new Error('feed down'); };
    const live = await p.getLiveData();
    expect(live).toHaveLength(3);
    expect(live.every((l: any) => l.status === 'OPERATING')).toBe(true);
    expect(live.every((l: any) => l.queue === undefined)).toBe(true);
  });

  test('emits nothing from the feed when no feed URL is configured', async () => {
    const p = park();
    p.waitTimesUrl = '';
    const live = await p.getLiveData();
    expect(live.every((l: any) => l.queue === undefined)).toBe(true);
  });

  test('schedules cover every published day with park-local times', async () => {
    const scheds = await park({days: ['2026-08-09', '2026-08-10']}).getSchedules();
    const rows = scheds[0].schedule;
    expect(rows).toHaveLength(2);
    expect(rows[0].date).toBe('2026-08-09');
    expect(rows[0].openingTime).toContain('2026-08-09T10:00:00');
    expect(rows[0].closingTime).toContain('2026-08-09T20:00:00');
  });
});

/**
 * Coordinates come from Proximiio, joined by the `"<org>:<feature>"` id that
 * Firestore stores verbatim in `proximiioId`. Two things make this easy to get
 * silently wrong: the collection is mostly walking paths rather than rides
 * (625 LineStrings vs 408 Points of 1036 features), and GeoJSON orders
 * coordinates longitude-first.
 */
describe('buildLocationIndex', () => {
  const point = (id: string, lng: number, lat: number) =>
    ({id, geometry: {type: 'Point', coordinates: [lng, lat]}});

  test('reads GeoJSON longitude-first order without transposing it', () => {
    // Energylandia is at ~49.99N 19.40E. Transposed, this ride lands off the
    // coast of Somalia and every map in the product is wrong.
    const i = buildLocationIndex([point('org:a', 19.404603, 50.000026)]);
    expect(i.get('org:a')).toEqual({latitude: 50.000026, longitude: 19.404603});
  });

  test('ignores LineString paths, whose coordinates are an array of pairs', () => {
    // Reading [0]/[1] off one would yield arrays where numbers are expected
    // and produce a garbage location rather than an error.
    const i = buildLocationIndex([
      {id: 'org:path', geometry: {type: 'LineString', coordinates: [[19.41, 49.99], [19.42, 49.99]]}},
    ]);
    expect(i.size).toBe(0);
  });

  test('ignores Polygon features', () => {
    const i = buildLocationIndex([
      {id: 'org:zone', geometry: {type: 'Polygon', coordinates: [[[19.4, 49.9], [19.5, 49.9]]]}},
    ]);
    expect(i.size).toBe(0);
  });

  test('rejects null island rather than placing rides at 0,0', () => {
    expect(buildLocationIndex([point('org:z', 0, 0)]).size).toBe(0);
  });

  test('rejects out-of-range and non-finite coordinates', () => {
    expect(buildLocationIndex([point('org:a', 999, 49.9)]).size).toBe(0);
    expect(buildLocationIndex([point('org:b', 19.4, 91)]).size).toBe(0);
    expect(buildLocationIndex([{id: 'org:c', geometry: {type: 'Point', coordinates: [NaN, 49.9]}}]).size).toBe(0);
    expect(buildLocationIndex([{id: 'org:d', geometry: {type: 'Point', coordinates: ['19.4', '49.9']}} as any]).size).toBe(0);
  });

  test('skips features with no id or malformed geometry', () => {
    expect(buildLocationIndex([
      {geometry: {type: 'Point', coordinates: [19.4, 49.9]}},
      {id: 'org:e'},
      {id: 'org:f', geometry: {type: 'Point', coordinates: [19.4]}},
    ] as any).size).toBe(0);
  });
});

describe('Energylandia — attraction locations', () => {
  const ATTRACTIONS = [
    doc('a1', {active: bool(true), type: str('attraction'), open: bool(true),
      name: nameMap({PL: '141. Pepsi Hyperion'}), proximiioId: str('org:mapped')}),
    doc('a2', {active: bool(true), type: str('attraction'), open: bool(true),
      name: nameMap({PL: '99. Unmapped Ride'}), proximiioId: str('org:gone')}),
  ];

  function park() {
    const p: any = new Energylandia();
    p.proximiioBaseUrl = 'https://geo.example';
    p.proximiioToken = 'token';
    p.getAttractionDocs = async () => ATTRACTIONS;
    p.getCalendarPeriods = async () => [];
    p.fetchProximiioFeatures = async () => ({
      json: async () => ({features: [{id: 'org:mapped', geometry: {type: 'Point', coordinates: [19.4046, 50.0000]}}]}),
    });
    return p;
  }

  beforeEach(() => CacheLib.clear());
  afterEach(() => CacheLib.clear());

  test('attaches coordinates via proximiioId', async () => {
    const e: any = (await park().getEntities()).find((x: any) => x.name === 'Pepsi Hyperion');
    expect(e.location).toEqual({latitude: 50.0, longitude: 19.4046});
  });

  test('a stale proximiioId leaves the ride without a location, never drops it', async () => {
    // The ride is still real and still reports wait times.
    const ents = await park().getEntities();
    const e: any = ents.find((x: any) => x.name === 'Unmapped Ride');
    expect(e).toBeDefined();
    expect(e.location).toBeUndefined();
  });

  test('a Proximiio outage costs coordinates, not the entity list', async () => {
    const p = park();
    p.fetchProximiioFeatures = async () => { throw new Error('proximiio down'); };
    const ents = (await p.getEntities()).filter((x: any) => x.entityType === 'ATTRACTION');
    expect(ents).toHaveLength(2);
    expect(ents.every((x: any) => x.location === undefined)).toBe(true);
  });

  test('unconfigured Proximiio emits entities without coordinates', async () => {
    const p = park();
    p.proximiioToken = '';
    const ents = (await p.getEntities()).filter((x: any) => x.entityType === 'ATTRACTION');
    expect(ents).toHaveLength(2);
    expect(ents.every((x: any) => x.location === undefined)).toBe(true);
  });
});

describe('Energylandia — pinned fallback coordinates', () => {
  // Three rides are mapped in Proximiio but Firestore points at recreated
  // features that no longer exist. The fallback is keyed by Firestore doc id
  // and consulted ONLY on a miss, so a repointed CMS takes over again by
  // itself.
  const MINI_TRACK = 'JqDuKAgRzSP54oRShbuv';

  function parkWith(features: any[]) {
    const p: any = new Energylandia();
    p.proximiioBaseUrl = 'https://geo.example';
    p.proximiioToken = 'token';
    p.getCalendarPeriods = async () => [];
    p.getAttractionDocs = async () => [
      doc(MINI_TRACK, {active: bool(true), type: str('attraction'), open: bool(true),
        name: nameMap({EN: '220. Mini Track Tour Ride'}), proximiioId: str('org:stale')}),
    ];
    p.fetchProximiioFeatures = async () => ({json: async () => ({features})});
    return p;
  }

  beforeEach(() => CacheLib.clear());
  afterEach(() => CacheLib.clear());

  test('fills in a ride whose proximiioId resolves to nothing', async () => {
    const e: any = (await parkWith([]).getEntities()).find((x: any) => x.entityType === 'ATTRACTION');
    expect(e.location).toEqual({latitude: 49.999318, longitude: 19.402042});
  });

  test('live Proximiio data wins over the pin, so a CMS fix self-heals', async () => {
    const live = [{id: 'org:stale', geometry: {type: 'Point', coordinates: [19.5, 50.5]}}];
    const e: any = (await parkWith(live).getEntities()).find((x: any) => x.entityType === 'ATTRACTION');
    expect(e.location).toEqual({latitude: 50.5, longitude: 19.5});
  });

  test('every pinned coordinate sits inside the park', async () => {
    // Guards against a fat-fingered digit or a transposed pair being pasted in.
    const p: any = new Energylandia();
    const {FALLBACK_LOCATIONS} = await import('../energylandia.js') as any;
    const pins = FALLBACK_LOCATIONS ?? {};
    for (const [id, loc] of Object.entries(pins) as any) {
      expect(loc.latitude, id).toBeGreaterThan(49.98);
      expect(loc.latitude, id).toBeLessThan(50.01);
      expect(loc.longitude, id).toBeGreaterThan(19.39);
      expect(loc.longitude, id).toBeLessThan(19.42);
    }
  });
});
