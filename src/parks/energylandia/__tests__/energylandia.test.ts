import {describe, test, expect, beforeEach, afterEach, vi} from 'vitest';
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
  parkLocalWeekday,
  parseShowSlots,
  parseDurationMinutes,
  buildShowtimes,
  showStatusFromShowtimes,
  resolveShowVenueId,
  isEnergyPassEntrance,
  WEEKDAYS,
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
 * Every park instance in this file is constructed with an explicit instance
 * config rather than by assigning properties afterwards. @config resolves
 * `instance config > CLASSNAME_PROP > PREFIX_PROP > default` (src/config.ts),
 * so a plain `p.waitTimesUrl = ''` is SILENTLY OVERRIDDEN when ENERGYLANDIA_*
 * is exported in the shell — which made two "unconfigured" tests fire real
 * outbound requests at the park's private hosts and turned a 0.86s suite into
 * a 3.92s one. Instance config is the only assignment env cannot outrank.
 */
const BLANK_CONFIG = {
  apiKey: '', projectId: '', waitTimesUrl: '',
  proximiioBaseUrl: '', proximiioToken: '',
};

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
    const p: any = new Energylandia({config: {...BLANK_CONFIG, waitTimesUrl: 'https://feed.example/'}});
    p.getShowDocs = async () => [];
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

  test('only active rides become ATTRACTIONs — a restaurant is not one, a retired ride is not published', async () => {
    const entities = await park().getEntities();
    const names = entities.filter((e: any) => e.entityType === 'ATTRACTION').map((e: any) => e.name).sort();
    expect(names).toEqual(['No Counter', 'Pepsi Hyperion', 'Tsunami Drop']);
  });

  test('a restaurant becomes a RESTAURANT rather than being dropped', async () => {
    const entities = await park().getEntities();
    const dining = entities.filter((e: any) => e.entityType === 'RESTAURANT');
    expect(dining.map((e: any) => e.name)).toEqual(['Pizzeria']);
    expect(dining[0].parkId).toBe('energylandia-park');
  });

  test('an inactive document is published under no entity type at all', async () => {
    const entities = await park().getEntities();
    expect(entities.map((e: any) => e.id)).not.toContain('energylandia-x1');
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
    // Pinned to a fixed instant rather than read from the wall clock. The
    // previous form built a 23:58-23:59 window from `new Date()` and asserted
    // CLOSED, so it failed for a real 120-second window every day.
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-08-09T01:00:00Z')); // 03:00 in Warsaw
      const live = await park({days: ['2026-08-09'], open: '10:00', close: '20:00'}).getLiveData();
      expect(live.every((l: any) => l.status === 'CLOSED')).toBe(true);
      expect(live.every((l: any) => l.queue === undefined)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  test('everything is OPERATING inside the published operating hours', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-08-09T10:00:00Z')); // 12:00 in Warsaw
      const live = await park({days: ['2026-08-09'], open: '10:00', close: '20:00'}).getLiveData();
      expect(live.some((l: any) => l.status === 'OPERATING')).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  test('a day missing from the calendar is CLOSED, not open', async () => {
    // The calendar is sparse ON PURPOSE — it lists only operating days, so of
    // 242 dated days spanning 2026-01-02..2027-01-31 there are 153 gaps, and
    // those gaps are the closed season and midweek closures. An earlier version
    // read a gap as "open" and published all 89 rides as OPERATING at 3am on
    // Christmas Day.
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-12-25T12:00:00Z'));
      const live = await park({days: ['2026-08-09'], open: '10:00', close: '20:00'}).getLiveData();
      expect(live).not.toHaveLength(0);
      expect(live.every((l: any) => l.status === 'CLOSED')).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  test('an ENTIRELY empty calendar is a source failure and does not black out the park', async () => {
    // Distinct from a gap: no dates at all means the collection was renamed,
    // the project id is wrong, or Firestore returned 200 with no documents.
    // Closing all 89 rides on that would be worse than briefly over-reporting
    // the park as open, so it degrades to open and warns.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const live = await park({days: []}).getLiveData();
    expect(live.every((l: any) => l.status === 'OPERATING')).toBe(true);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('calendar is empty'));
    warn.mockRestore();
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
    p.config = {...BLANK_CONFIG};
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
 * "Energy Pass" is the park's paid skip-the-line product. In August 2026 the
 * CMS grew 14 `type: 'attraction'` documents named "Wejście Energy Pass -
 * <ride>" — map pins for the paid-queue entrances, tagged
 * `filterTags: ['energyPass']`, with empty descriptions and no queue counter.
 * Left in, every pin published as a real ATTRACTION reporting OPERATING all
 * day. They are recognised by NAME, deliberately not by tag: tagging the
 * *rides* the pass covers is a plausible future CMS edit, and a tag-based
 * filter would then delete 14 real coasters from the published entity list.
 */
describe('Energy Pass entrance pins are not rides', () => {
  const epTag = {arrayValue: {values: [{stringValue: 'energyPass'}]}};

  test('recognises a pin by name in any locale', () => {
    expect(isEnergyPassEntrance(doc('ep1', {
      name: nameMap({PL: 'Wejście Energy Pass - Anaconda'}), filterTags: epTag,
    }))).toBe(true);
    // Name alone is enough — the tag is corroborating, not required.
    expect(isEnergyPassEntrance(doc('ep2', {
      name: nameMap({EN: 'Wejście Energy Pass - HYPERION'}),
    }))).toBe(true);
  });

  test('a real ride is never a pin, even if the park tags it energyPass', () => {
    expect(isEnergyPassEntrance(doc('a1', {
      name: nameMap({PL: '141. Pepsi Hyperion'}), filterTags: epTag,
    }))).toBe(false);
    expect(isEnergyPassEntrance(doc('a2', {
      name: nameMap({PL: '97. Anaconda'}),
    }))).toBe(false);
    // A ride whose name merely contains "Energy" is not the product's name.
    expect(isEnergyPassEntrance(doc('a3', {
      name: nameMap({PL: '23. Śmiejżelki Energuś'}),
    }))).toBe(false);
    expect(isEnergyPassEntrance(doc('x', {}))).toBe(false);
  });

  test('pins are excluded from entities and live data together', async () => {
    const p: any = new Energylandia({config: {...BLANK_CONFIG, waitTimesUrl: 'https://feed.example/'}});
    p.getShowDocs = async () => [];
    p.getAttractionDocs = async () => [
      doc('ride', {active: bool(true), type: str('attraction'), open: bool(true),
        name: nameMap({PL: '97. Anaconda'}), queueTimeId: int(196)}),
      doc('pin', {active: bool(true), type: str('attraction'), open: bool(true),
        name: nameMap({PL: 'Wejście Energy Pass - Anaconda'}), queueTimeId: str(''),
        filterTags: epTag}),
    ];
    p.fetchWaitTimes = async () => ({text: async () => JSON.stringify([
      {ID_ATRAKCJI: 196, ATRAKCJA: '97 ANACONDA', CZAS_OCZEKIWANIA: 25},
    ])});
    p.getCalendarPeriods = async () => [{openFrom: '10:00', openTo: '20:00', days: ['2026-08-09']}];

    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-08-09T10:00:00Z')); // 12:00 in Warsaw

      const entities = await p.getEntities();
      expect(entities.map((e: any) => e.id)).toContain('energylandia-ride');
      expect(entities.map((e: any) => e.id)).not.toContain('energylandia-pin');

      // The live side must agree, or the pin ships an orphan row on every poll.
      const live = await p.getLiveData();
      expect(live.map((l: any) => l.id)).toEqual(['energylandia-ride']);
      expect(live[0].queue.STANDBY.waitTime).toBe(25);
    } finally {
      vi.useRealTimers();
    }
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
    const p: any = new Energylandia({config: {
      ...BLANK_CONFIG, proximiioBaseUrl: 'https://geo.example', proximiioToken: 'token',
    }});
    p.getShowDocs = async () => [];
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
    p.config = {...BLANK_CONFIG};
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
    const p: any = new Energylandia({config: {
      ...BLANK_CONFIG, proximiioBaseUrl: 'https://geo.example', proximiioToken: 'token',
    }});
    p.getCalendarPeriods = async () => [];
    p.getShowDocs = async () => [];
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

describe('Energylandia — failures must not be cached', () => {
  const ATTRACTIONS = [
    doc('a1', {active: bool(true), type: str('attraction'), open: bool(true),
      name: nameMap({EN: '1. Ride'}), proximiioId: str('org:a')}),
  ];

  function park() {
    return new Energylandia({config: {
      ...BLANK_CONFIG, proximiioBaseUrl: 'https://geo.example', proximiioToken: 'token',
    }}) as any;
  }

  beforeEach(() => CacheLib.clear());
  afterEach(() => CacheLib.clear());

  test('a Proximiio outage is not persisted, so the next poll recovers', async () => {
    // The regression: the catch used to live INSIDE the @cache'd method, so the
    // empty result was written under a 12h TTL and every attraction lost its
    // coordinates for half a day — across restarts and every other collector
    // host — because of one transient blip.
    const p = park();
    p.getShowDocs = async () => [];
    p.getAttractionDocs = async () => ATTRACTIONS;
    p.getCalendarPeriods = async () => [];
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    let fail = true;
    p.fetchProximiioFeatures = async () => {
      if (fail) throw new Error('proximiio 503');
      return {json: async () => ({features: [
        {id: 'org:a', geometry: {type: 'Point', coordinates: [19.4046, 50.0]}},
      ]})};
    };

    const first: any = (await p.getEntities()).find((e: any) => e.entityType === 'ATTRACTION');
    expect(first.location).toBeUndefined();

    // Proximiio recovers. Nothing was cached, so this poll must see real data.
    fail = false;
    const second: any = (await p.getEntities()).find((e: any) => e.entityType === 'ATTRACTION');
    expect(second.location).toEqual({latitude: 50.0, longitude: 19.4046});
    warn.mockRestore();
  });

  test('a 200 with no features array fails loudly instead of caching a truncated index', async () => {
    const p = park();
    p.fetchProximiioFeatures = async () => ({json: async () => ({ok: true})});
    await expect(p.getLocationIndex()).rejects.toThrow(/no features array/);
  });
});

describe('Energylandia — wait value hardening', () => {
  test('whitespace never becomes a fabricated zero-minute walk-on', () => {
    // Number('  ') is 0 exactly as Number('') is; only the latter was guarded.
    expect(parseWaitMinutes('  ')).toBeUndefined();
    expect(parseWaitMinutes('\n')).toBeUndefined();
  });

  test('a padded numeric string still parses', () => {
    expect(parseWaitMinutes(' 20 ')).toBe(20);
  });

  test('non-numeric types are rejected by type, not coerced', () => {
    // Number(false), Number([]) and Number({}) are 0, 0 and NaN respectively —
    // the first two would otherwise pass the finite check as a real 0 wait.
    expect(parseWaitMinutes(false as any)).toBeUndefined();
    expect(parseWaitMinutes([] as any)).toBeUndefined();
    expect(parseWaitMinutes({} as any)).toBeUndefined();
  });

  test('a fractional wait is rejected as a shape change', () => {
    expect(parseWaitMinutes(12.7)).toBeUndefined();
  });

  test('joins a padded feed id, matching the trimming fsId already does', async () => {
    const p: any = new Energylandia({config: {...BLANK_CONFIG, waitTimesUrl: 'https://feed.example/'}});
    p.getCalendarPeriods = async () => [];
    p.getShowDocs = async () => [];
    p.getAttractionDocs = async () => [
      doc('a1', {active: bool(true), type: str('attraction'), open: bool(true),
        name: nameMap({EN: '1. Ride'}), queueTimeId: str(' 5 ')}),
    ];
    p.fetchWaitTimes = async () => ({text: async () => JSON.stringify([
      {ID_ATRAKCJI: ' 5 ', CZAS_OCZEKIWANIA: 15},
    ])});
    const live = await p.getLiveData();
    expect((live[0] as any).queue?.STANDBY?.waitTime).toBe(15);
  });
});

describe('Energylandia — a wait-feed outage is visible', () => {
  test('warns when inside operating hours but no wait rows were usable', async () => {
    // Without this the outage is silent: 89 OPERATING rows still publish and
    // lastUpdated still moves, so the staleness dashboard sees a healthy park.
    const p: any = new Energylandia({config: {...BLANK_CONFIG, waitTimesUrl: 'https://feed.example/'}});
    p.getShowDocs = async () => [];
    p.getAttractionDocs = async () => [
      doc('a1', {active: bool(true), type: str('attraction'), open: bool(true),
        name: nameMap({EN: '1. Ride'}), queueTimeId: str('5')}),
    ];
    p.getCalendarPeriods = async () => [{openFrom: '10:00', openTo: '20:00', days: ['2026-08-09']}];
    p.fetchWaitTimes = async () => { throw new Error('feed down'); };

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-08-09T10:00:00Z')); // 12:00 Warsaw, park open
      const live = await p.getLiveData();
      expect(live.every((l: any) => l.status === 'OPERATING')).toBe(true);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('no usable rows'));
    } finally {
      vi.useRealTimers();
      warn.mockRestore();
    }
  });

  test('stays quiet outside operating hours, when an empty feed is expected', async () => {
    const p: any = new Energylandia({config: {...BLANK_CONFIG, waitTimesUrl: 'https://feed.example/'}});
    p.getShowDocs = async () => [];
    p.getAttractionDocs = async () => [
      doc('a1', {active: bool(true), type: str('attraction'), open: bool(true),
        name: nameMap({EN: '1. Ride'}), queueTimeId: str('5')}),
    ];
    p.getCalendarPeriods = async () => [{openFrom: '10:00', openTo: '20:00', days: ['2026-08-09']}];
    p.fetchWaitTimes = async () => ({text: async () => '[]'});

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-08-09T01:00:00Z')); // 03:00 Warsaw, closed
      await p.getLiveData();
      expect(warn).not.toHaveBeenCalledWith(expect.stringContaining('no usable rows'));
    } finally {
      vi.useRealTimers();
      warn.mockRestore();
    }
  });
});

describe('Energylandia — auth reuses one identity', () => {
  const CFG = {...BLANK_CONFIG, apiKey: 'k', projectId: 'p'};

  beforeEach(() => CacheLib.clear());
  afterEach(() => CacheLib.clear());

  test('signs up once, then refreshes — it does not mint an account per token', async () => {
    // Anonymous sign-up creates a PERMANENT account in the park's Firebase
    // project. At a 50-minute TTL, minting per renewal is ~10k accounts a year
    // per collector host, accumulating in a third party's user list.
    const p: any = new Energylandia({config: CFG});
    let signUps = 0, refreshes = 0;
    p.fetchAnonymousSignUp = async () => {
      signUps++;
      return {json: async () => ({idToken: 'id-1', refreshToken: 'refresh-1'})};
    };
    p.fetchTokenRefresh = async (rt: string) => {
      refreshes++;
      expect(rt).toBe('refresh-1');
      return {json: async () => ({id_token: `id-${refreshes + 1}`})};
    };

    expect(await p.getIdToken()).toBe('id-1');
    CacheLib.delete('energylandia:idToken');       // id token expires
    expect(await p.getIdToken()).toBe('id-2');
    CacheLib.delete('energylandia:idToken');
    expect(await p.getIdToken()).toBe('id-3');

    expect(signUps, 'exactly one account should ever be created').toBe(1);
    expect(refreshes).toBe(2);
  });

  test('a rotated refresh token is stored, so the next renewal still refreshes', async () => {
    const p: any = new Energylandia({config: CFG});
    let signUps = 0;
    p.fetchAnonymousSignUp = async () => {
      signUps++;
      return {json: async () => ({idToken: 'id-1', refreshToken: 'refresh-1'})};
    };
    const seen: string[] = [];
    p.fetchTokenRefresh = async (rt: string) => {
      seen.push(rt);
      return {json: async () => ({id_token: 'id-n', refresh_token: `rotated-${seen.length}`})};
    };
    await p.getIdToken();
    CacheLib.delete('energylandia:idToken');
    await p.getIdToken();
    CacheLib.delete('energylandia:idToken');
    await p.getIdToken();
    expect(seen).toEqual(['refresh-1', 'rotated-1']);
    expect(signUps).toBe(1);
  });

  test('a revoked refresh token falls back to a single new sign-up', async () => {
    const p: any = new Energylandia({config: CFG});
    let signUps = 0;
    p.fetchAnonymousSignUp = async () => {
      signUps++;
      return {json: async () => ({idToken: `id-${signUps}`, refreshToken: `refresh-${signUps}`})};
    };
    p.fetchTokenRefresh = async () => { throw new Error('TOKEN_EXPIRED'); };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await p.getIdToken();
    CacheLib.delete('energylandia:idToken');
    expect(await p.getIdToken()).toBe('id-2');
    expect(signUps).toBe(2);
    warn.mockRestore();
  });

  test('a 403 does not clear the token, so it cannot drive a sign-up loop', async () => {
    // 403 is a permission verdict — a denying security rule, or anonymous auth
    // switched off. Re-authenticating cannot fix it, and clearing the response
    // made http.ts treat the request as retryable, so every retry minted again.
    const p: any = new Energylandia({config: CFG});
    CacheLib.set('energylandia:idToken', 'tok', 3000);
    const req: any = {response: {status: 403}};
    await p.handleUnauthorized(req);
    expect(CacheLib.get('energylandia:idToken')).toBe('tok');
    expect(req.response).toBeDefined();
  });

  test('a 401 clears the id token but keeps the identity', async () => {
    const p: any = new Energylandia({config: CFG});
    CacheLib.set('energylandia:idToken', 'tok', 3000);
    CacheLib.set('energylandia:refreshToken', 'refresh-1', 3000);
    const req: any = {response: {status: 401}};
    await p.handleUnauthorized(req);
    // CacheLib.get() returns null on a miss, not undefined.
    expect(CacheLib.get('energylandia:idToken')).toBeNull();
    expect(CacheLib.get('energylandia:refreshToken'), 'identity survives an expired credential').toBe('refresh-1');
    expect(req.response).toBeUndefined();
  });
});

describe('Energylandia — an empty Firestore collection is a failure, not an empty park', () => {
  beforeEach(() => CacheLib.clear());
  afterEach(() => CacheLib.clear());

  test('refuses to publish an empty catalogue', async () => {
    // Firestore answers 200 with {} for both "empty" and "does not exist", so
    // a renamed collection would otherwise wipe the park from the public API
    // and cache that for 30 minutes.
    const p: any = new Energylandia({config: {...BLANK_CONFIG, apiKey: 'k', projectId: 'p'}});
    p.getIdToken = async () => 'tok';
    p.fetchCollectionPage = async () => ({json: async () => ({})});
    await expect(p.getAttractionDocs()).rejects.toThrow(/refusing to publish an empty catalogue/);
  });

  test('still follows pagination and returns every page', async () => {
    const p: any = new Energylandia({config: {...BLANK_CONFIG, apiKey: 'k', projectId: 'p'}});
    p.getIdToken = async () => 'tok';
    const pages: any = {
      'null': {documents: [{name: 'c/a'}], nextPageToken: 't2'},
      't2': {documents: [{name: 'c/b'}]},
    };
    const seen: any[] = [];
    p.fetchCollectionPage = async (_c: string, token: string | null) => {
      seen.push(token);
      return {json: async () => pages[String(token)]};
    };
    const docs = await p.getAttractionDocs();
    expect(docs.map((d: any) => d.name)).toEqual(['c/a', 'c/b']);
    expect(seen).toEqual([null, 't2']);
  });
});

// ===========================================================================
// Shows
//
// The timetable is keyed by WEEKDAY, not by date. That single fact is what
// every test below is guarding: read naively it is a recurring pattern with no
// notion of the calendar, and it will happily describe Saturday's parade on a
// Saturday in the closed season.
// ===========================================================================

const showDoc = (id: string, fields: Record<string, any>) => ({
  name: `projects/p/databases/(default)/documents/shows/${id}`,
  fields,
});

/** A `timetable` map: {monday: [{time, attractionId?, place?}], …}. */
const timetable = (
  days: Record<string, Array<{time: string; venue?: string; place?: string}>>,
) => ({
  mapValue: {
    fields: Object.fromEntries(Object.entries(days).map(([day, slots]) => [day, {
      arrayValue: {
        values: slots.map((s) => ({
          mapValue: {
            fields: {
              time: str(s.time),
              timeEnd: {nullValue: null},
              ...(s.venue !== undefined ? {attractionId: str(s.venue)} : {}),
              ...(s.place !== undefined ? {place: nameMap({EN: s.place})} : {}),
            },
          },
        })),
      },
    }])),
  },
});

describe('parkLocalWeekday', () => {
  test('reads the weekday in park-local time, not the host\'s', () => {
    // 22:30Z on a Sunday is 00:30 Monday in Warsaw. Using the host clock (or
    // Date.getDay()) would run Sunday's timetable for the first hours of Monday.
    expect(parkLocalWeekday(new Date('2026-08-09T22:30:00Z'), 'Europe/Warsaw')).toBe('monday');
    expect(parkLocalWeekday(new Date('2026-08-09T12:00:00Z'), 'Europe/Warsaw')).toBe('sunday');
  });

  test('every weekday it returns is a key the timetable can be indexed by', () => {
    for (let i = 0; i < 7; i++) {
      const day = parkLocalWeekday(new Date(Date.UTC(2026, 7, 9 + i, 12)), 'Europe/Warsaw');
      expect(WEEKDAYS).toContain(day);
    }
  });
});

describe('parseShowSlots', () => {
  const tt = timetable({
    sunday: [
      {time: '16:30', venue: 'v1', place: '54. Teatr Colosseo'},
      {time: '13:30', venue: 'v1', place: '54. Teatr Colosseo'},
    ],
    monday: [{time: '10:00', place: 'Town Hall Theatre'}],
  });

  test('returns only the requested weekday', () => {
    expect(parseShowSlots(tt, 'monday').map((s) => s.time)).toEqual(['10:00']);
    expect(parseShowSlots(tt, 'tuesday')).toEqual([]);
  });

  test('sorts chronologically — the CMS stores entry order, not time order', () => {
    // One real show lists 16:30 before 13:30. Unsorted, "the day's last
    // performance" is the wrong entry, which is what decides show status.
    expect(parseShowSlots(tt, 'sunday').map((s) => s.time)).toEqual(['13:30', '16:30']);
  });

  test('a slot with no attractionId is kept, unlinked — 63 of 259 real slots omit the id', () => {
    // The performance is real; only the link to its venue document is missing.
    // Dropping it would lose a fifth of the park's published showtimes.
    const [slot] = parseShowSlots(tt, 'monday');
    expect(slot.time).toBe('10:00');
    expect(slot.venueId).toBeUndefined();
  });

  test('reads attractionId in BOTH Firestore shapes, not just stringValue', () => {
    // This CMS stores the same identifier as integerValue AND stringValue.
    // Reading one shape is how wait times once published for 3 rides, not 42.
    const asInt = {mapValue: {fields: {sunday: {arrayValue: {values: [
      {mapValue: {fields: {time: str('12:00'), attractionId: int(7)}}},
    ]}}}}};
    expect(parseShowSlots(asInt, 'sunday')[0].venueId).toBe('7');
  });

  test('an explicitly deactivated slot is not published', () => {
    const tt2 = {mapValue: {fields: {sunday: {arrayValue: {values: [
      {mapValue: {fields: {time: str('12:00'), active: bool(false)}}},
      {mapValue: {fields: {time: str('13:00'), active: bool(true)}}},
      {mapValue: {fields: {time: str('14:00')}}},
    ]}}}}};
    // Absent means published; only an explicit false suppresses.
    expect(parseShowSlots(tt2, 'sunday').map((x) => x.time)).toEqual(['13:00', '14:00']);
  });

  test('drops a malformed time rather than guessing at it', () => {
    // Range-checked, not just shape-checked: '25:99' matches \\d{2}:\\d{2}, and
    // constructDateTime would resolve it by rolling into the next day, inventing
    // a performance at an hour the park never stated.
    const bad = timetable({sunday: [
      {time: '25:99'}, {time: '24:00'}, {time: '12:60'}, {time: 'noon'}, {time: '14:00'},
    ]});
    expect(parseShowSlots(bad, 'sunday').map((s) => s.time)).toEqual(['14:00']);
  });

  test('an absent timetable is no performances, not a crash', () => {
    expect(parseShowSlots(undefined, 'sunday')).toEqual([]);
  });
});

describe('parseDurationMinutes', () => {
  test('reads the CMS string form', () => {
    expect(parseDurationMinutes('15')).toBe(15);
    expect(parseDurationMinutes('120')).toBe(120);
  });

  test('rejects the empty string rather than coercing it to a zero-length show', () => {
    // Number('') is 0, which would collapse every end time onto its start.
    expect(parseDurationMinutes('')).toBeUndefined();
    expect(parseDurationMinutes('   ')).toBeUndefined();
    expect(parseDurationMinutes('0')).toBeUndefined();
  });

  test('rejects values that are not a whole, plausible number of minutes', () => {
    expect(parseDurationMinutes('abc')).toBeUndefined();
    expect(parseDurationMinutes('15.5')).toBeUndefined();
    expect(parseDurationMinutes('-15')).toBeUndefined();
    expect(parseDurationMinutes('100000')).toBeUndefined();
    expect(parseDurationMinutes(undefined)).toBeUndefined();
  });
});

describe('buildShowtimes', () => {
  const slots = [{time: '12:45'}];

  test('start and end are written in the SAME format', () => {
    // Regression: deriving the end from the shifted Date and calling
    // .toISOString() is correct to the instant but renders it as UTC, so one
    // showtime carried '…T12:45:00+02:00' next to '…T11:00:00.000Z'.
    const [s] = buildShowtimes(slots, '2026-08-09', 'Europe/Warsaw', 15);
    expect(s.startTime).toBe('2026-08-09T12:45:00+02:00');
    expect(s.endTime).toBe('2026-08-09T13:00:00+02:00');
  });

  test('end time is null when the park states no usable duration', () => {
    const [s] = buildShowtimes(slots, '2026-08-09', 'Europe/Warsaw', undefined);
    expect(s.startTime).toBe('2026-08-09T12:45:00+02:00');
    expect(s.endTime).toBeNull();
  });

  test('a performance running past midnight ends on the next date', () => {
    const [s] = buildShowtimes([{time: '23:50'}], '2026-08-09', 'Europe/Warsaw', 20);
    expect(s.startTime).toBe('2026-08-09T23:50:00+02:00');
    expect(s.endTime).toBe('2026-08-10T00:10:00+02:00');
  });

  test('a performance crossing the spring-forward jump keeps its true length', () => {
    // 2026-03-29: 02:00 -> 03:00 in Warsaw. A 30 minute show from 01:50 must end
    // at 03:20+02:00, still 30 real minutes later.
    const [s] = buildShowtimes([{time: '01:50'}], '2026-03-29', 'Europe/Warsaw', 30);
    expect(s.startTime).toBe('2026-03-29T01:50:00+01:00');
    expect(s.endTime).toBe('2026-03-29T03:20:00+02:00');
    expect(new Date(s.endTime!).getTime() - new Date(s.startTime!).getTime()).toBe(30 * 60 * 1000);
  });

  test('a performance ending in the autumn fold keeps its true length', () => {
    // 2026-10-25: 03:00 -> 02:00, so 02:10 local happens TWICE. Deriving the end
    // by re-resolving a park-local wall clock picks the second occurrence and
    // turns a 20 minute show into an 80 minute one. Formatting the instant
    // directly cannot re-resolve it.
    const [s] = buildShowtimes([{time: '01:50'}], '2026-10-25', 'Europe/Warsaw', 20);
    expect(s.startTime).toBe('2026-10-25T01:50:00+02:00');
    expect(s.endTime).toBe('2026-10-25T02:10:00+02:00');
    expect(new Date(s.endTime!).getTime() - new Date(s.startTime!).getTime()).toBe(20 * 60 * 1000);
  });

  test('is typed as a performance', () => {
    expect(buildShowtimes(slots, '2026-08-09', 'Europe/Warsaw', 15)[0].type).toBe('Performance Time');
  });
});

describe('showStatusFromShowtimes', () => {
  const at = (iso: string) => new Date(iso).getTime();
  const times = buildShowtimes(
    [{time: '12:00'}, {time: '18:00'}], '2026-08-09', 'Europe/Warsaw', 15,
  );

  test('OPERATING before the first performance', () => {
    expect(showStatusFromShowtimes(times, at('2026-08-09T09:00:00+02:00'))).toBe('OPERATING');
  });

  test('OPERATING while a performance is running', () => {
    expect(showStatusFromShowtimes(times, at('2026-08-09T12:05:00+02:00'))).toBe('OPERATING');
  });

  test('CLOSED once the day\'s last performance has finished', () => {
    // Without this the evening parade stays listed as running at closing time.
    expect(showStatusFromShowtimes(times, at('2026-08-09T18:16:00+02:00'))).toBe('CLOSED');
  });

  test('with no end time, a performance stops counting once it has begun', () => {
    const noEnd = buildShowtimes([{time: '12:00'}], '2026-08-09', 'Europe/Warsaw', undefined);
    expect(showStatusFromShowtimes(noEnd, at('2026-08-09T11:59:00+02:00'))).toBe('OPERATING');
    expect(showStatusFromShowtimes(noEnd, at('2026-08-09T12:01:00+02:00'))).toBe('CLOSED');
  });

  test('exactly at the end instant still counts as running', () => {
    // Inclusive on purpose: a show is not over the millisecond it is due to end.
    expect(showStatusFromShowtimes(times, at('2026-08-09T18:15:00+02:00'))).toBe('OPERATING');
    expect(showStatusFromShowtimes(times, at('2026-08-09T18:15:00.001+02:00'))).toBe('CLOSED');
  });

  test('a show with no performances today is CLOSED', () => {
    expect(showStatusFromShowtimes([], at('2026-08-09T12:00:00+02:00'))).toBe('CLOSED');
  });
});

describe('resolveShowVenueId', () => {
  test('a show that stays put gets its venue', () => {
    expect(resolveShowVenueId([{time: '1', venueId: 'v1'}, {time: '2', venueId: 'v1'}])).toBe('v1');
  });

  test('slots missing the id do not count as disagreement', () => {
    // 63 real slots omit attractionId while naming the same venue in `place`.
    // Counting them as different would strip the location from shows that never move.
    expect(resolveShowVenueId([{time: '1', venueId: 'v1'}, {time: '2'}])).toBe('v1');
  });

  test('a roaming show gets no venue rather than whichever was listed first', () => {
    expect(resolveShowVenueId([{time: '1', venueId: 'v1'}, {time: '2', venueId: 'v2'}])).toBeUndefined();
  });

  test('no venue anywhere is undefined, not a crash', () => {
    expect(resolveShowVenueId([{time: '1'}])).toBeUndefined();
    expect(resolveShowVenueId([])).toBeUndefined();
  });
});

describe('Energylandia — shows end to end', () => {
  const SHOWS = [
    showDoc('s1', {
      active: bool(true), duration: str('15'),
      name: nameMap({EN: 'Fire Show', PL: 'Pokaz Ognia'}),
      timetable: timetable({
        sunday: [{time: '14:00', venue: 'v1', place: '51. Amfiteatr Egypt'}],
        monday: [{time: '11:00', venue: 'v1'}],
      }),
    }),
    showDoc('s2', {
      active: bool(true), duration: str('15'),
      name: nameMap({EN: 'Meeting with Mascots'}),
      timetable: timetable({sunday: [
        {time: '10:00', venue: 'v1'},
        {time: '12:00', venue: 'v2'},
      ]}),
    }),
    showDoc('s3', {
      active: bool(true), duration: str('20'),
      name: nameMap({EN: 'Weekend Only Show'}),
      timetable: timetable({saturday: [{time: '15:00', venue: 'v1'}]}),
    }),
    showDoc('s4', {
      active: bool(false), duration: str('15'),
      name: nameMap({EN: 'Retired Show'}),
      timetable: timetable({sunday: [{time: '13:00', venue: 'v1'}]}),
    }),
  ];

  const VENUES = [
    doc('v1', {active: bool(true), type: str('show'), open: bool(true),
      name: nameMap({PL: '51. Amfiteatr Egypt'}), proximiioId: str('org:f1')}),
    doc('v2', {active: bool(true), type: str('show'), open: bool(true),
      name: nameMap({PL: '54. Teatr Colosseo'}), proximiioId: str('org:f2')}),
  ];

  function park(days: string[]) {
    const p: any = new Energylandia({config: {...BLANK_CONFIG}});
    p.getAttractionDocs = async () => VENUES;
    p.getShowDocs = async () => SHOWS;
    p.getWaitTimes = async () => new Map();
    p.getLocationIndexSafe = async () => ({
      'org:f1': {latitude: 49.9, longitude: 19.4},
      'org:f2': {latitude: 49.8, longitude: 19.3},
    });
    p.getCalendarPeriods = async () => [{openFrom: '10:00', openTo: '20:00', days}];
    return p;
  }

  beforeEach(() => {
    CacheLib.clear();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    CacheLib.clear();
  });

  test('publishes a SHOW per active show, and none for a retired one', async () => {
    vi.setSystemTime(new Date('2026-08-09T12:00:00Z'));
    const entities = await park(['2026-08-09']).getEntities();
    const shows = entities.filter((e: any) => e.entityType === 'SHOW');
    expect(shows.map((s: any) => s.name).sort())
      .toEqual(['Fire Show', 'Meeting with Mascots', 'Weekend Only Show']);
  });

  test('show ids are namespaced by collection so a show cannot overwrite a ride', async () => {
    vi.setSystemTime(new Date('2026-08-09T12:00:00Z'));
    const entities = await park(['2026-08-09']).getEntities();
    const show = entities.find((e: any) => e.entityType === 'SHOW' && e.name === 'Fire Show');
    expect(show.id).toBe('energylandia-show-s1');
    // A Firestore doc id is unique only within its collection, so shows/v1 and
    // attractions/v1 could otherwise collide on one entity.
    expect(show.id).not.toBe('energylandia-v1');
  });

  test('a show that stays put inherits its venue location; a roaming one gets none', async () => {
    vi.setSystemTime(new Date('2026-08-09T12:00:00Z'));
    const entities = await park(['2026-08-09']).getEntities();
    const fire = entities.find((e: any) => e.name === 'Fire Show');
    const mascots = entities.find((e: any) => e.name === 'Meeting with Mascots');
    expect(fire.location).toEqual({latitude: 49.9, longitude: 19.4});
    expect(mascots.location).toBeUndefined();
  });

  test('emits today\'s performances with start and end times', async () => {
    // 12:00Z is 14:00 in Warsaw, a Sunday inside the published season.
    vi.setSystemTime(new Date('2026-08-09T12:00:00Z'));
    const live = await park(['2026-08-09']).getLiveData();
    const fire: any = live.find((l: any) => l.id === 'energylandia-show-s1');
    expect(fire.status).toBe('OPERATING');
    expect(fire.showtimes).toEqual([{
      type: 'Performance Time',
      startTime: '2026-08-09T14:00:00+02:00',
      endTime: '2026-08-09T14:15:00+02:00',
    }]);
  });

  test('reads the weekday timetable, not one fixed day', async () => {
    // Same show, next day: 11:00 rather than 14:00.
    vi.setSystemTime(new Date('2026-08-10T09:00:00Z'));
    const live = await park(['2026-08-10']).getLiveData();
    const fire: any = live.find((l: any) => l.id === 'energylandia-show-s1');
    expect(fire.showtimes[0].startTime).toBe('2026-08-10T11:00:00+02:00');
  });

  test('a date the park is closed publishes NO performances, however the weekday reads', async () => {
    // THE point of the gating. 2026-08-09 is a Sunday and every show has a
    // Sunday timetable, but the calendar lists only a different date, so the
    // park is shut and nothing may be advertised.
    //
    // The calendar must be non-empty. An EMPTY one is a source failure rather
    // than a statement about any day, and buildLiveData deliberately degrades it
    // to open — see the empty-calendar test below.
    vi.setSystemTime(new Date('2026-08-09T12:00:00Z'));
    const live = await park(['2026-08-15']).getLiveData();
    const shows = live.filter((l: any) => l.id.startsWith('energylandia-show-'));
    expect(shows).toHaveLength(3);
    for (const s of shows) {
      expect(s.status).toBe('CLOSED');
      expect(s.showtimes).toBeUndefined();
    }
  });

  test('before the gates open, today\'s times are still published but the show reads CLOSED', async () => {
    // 05:00Z is 07:00 Warsaw — an operating date, hours before opening. Times
    // are reference information about the day and are useful now; status is
    // about this instant. Gating the TIMES on the instant left the park with no
    // showtimes for ~14 hours a day, all 13 shows appearing at once at 10:00.
    vi.setSystemTime(new Date('2026-08-09T05:00:00Z'));
    const live = await park(['2026-08-09']).getLiveData();
    const fire: any = live.find((l: any) => l.id === 'energylandia-show-s1');
    expect(fire.status).toBe('CLOSED');
    expect(fire.showtimes).toEqual([{
      type: 'Performance Time',
      startTime: '2026-08-09T14:00:00+02:00',
      endTime: '2026-08-09T14:15:00+02:00',
    }]);
  });

  test('after closing, the day\'s times remain published and the show reads CLOSED', async () => {
    vi.setSystemTime(new Date('2026-08-09T20:00:00Z')); // 22:00 Warsaw, park shut at 20:00
    const live = await park(['2026-08-09']).getLiveData();
    const fire: any = live.find((l: any) => l.id === 'energylandia-show-s1');
    expect(fire.status).toBe('CLOSED');
    expect(fire.showtimes).toHaveLength(1);
  });

  test('a show not running today stays in the feed as CLOSED rather than vanishing', async () => {
    vi.setSystemTime(new Date('2026-08-09T12:00:00Z'));
    const live = await park(['2026-08-09']).getLiveData();
    const weekend: any = live.find((l: any) => l.id === 'energylandia-show-s3');
    expect(weekend.status).toBe('CLOSED');
    expect(weekend.showtimes).toBeUndefined();
  });

  test('goes CLOSED after the day\'s last performance, while the park is still open', async () => {
    // 16:00Z is 18:00 Warsaw: the park shuts at 20:00, but Fire Show finished
    // at 14:15 and must not still read as running.
    vi.setSystemTime(new Date('2026-08-09T16:00:00Z'));
    const live = await park(['2026-08-09']).getLiveData();
    const fire: any = live.find((l: any) => l.id === 'energylandia-show-s1');
    expect(fire.status).toBe('CLOSED');
    expect(fire.showtimes).toHaveLength(1);
  });

  test('an empty calendar degrades to open for shows, exactly as it does for rides', async () => {
    // A Firestore glitch that empties the calendar must not black out a running
    // park. Shows follow the same rule attractions already do, rather than
    // inventing a second policy for the same failure.
    vi.setSystemTime(new Date('2026-08-09T12:00:00Z'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const live = await park([]).getLiveData();
    warn.mockRestore();
    const fire: any = live.find((l: any) => l.id === 'energylandia-show-s1');
    expect(fire.status).toBe('OPERATING');
    expect(fire.showtimes).toHaveLength(1);
  });

  test('a show and a ride sharing a document id both publish, neither overwrites the other', async () => {
    // A Firestore doc id is unique only WITHIN its collection, so shows/dup and
    // attractions/dup are different documents. Without the -show- namespace one
    // silently replaces the other. The previous version of this test used a
    // fixture whose only attractions were type:'show', so the emission held no
    // rides at all and the assertion compared shows against themselves.
    vi.setSystemTime(new Date('2026-08-09T12:00:00Z'));
    const p: any = park(['2026-08-09']);
    p.getAttractionDocs = async () => [
      ...VENUES,
      doc('dup', {active: bool(true), type: str('attraction'), open: bool(true),
        name: nameMap({EN: 'A Ride'}), queueTimeId: str('')}),
    ];
    p.getShowDocs = async () => [
      ...SHOWS,
      showDoc('dup', {active: bool(true), duration: str('15'),
        name: nameMap({EN: 'A Show'}),
        timetable: timetable({sunday: [{time: '12:00', venue: 'v1'}]})}),
    ];

    const entities = await p.getEntities();
    const ids = entities.map((e: any) => e.id);
    expect(ids).toContain('energylandia-dup');
    expect(ids).toContain('energylandia-show-dup');
    expect(new Set(ids).size).toBe(ids.length);

    const live = await p.getLiveData();
    const liveIds = live.map((l: any) => l.id);
    expect(liveIds).toContain('energylandia-dup');
    expect(liveIds).toContain('energylandia-show-dup');
    expect(new Set(liveIds).size).toBe(liveIds.length);
  });

  test('every show live row has an entity behind it — no orphans', async () => {
    // buildEntityList skips a document with no usable name. buildLiveData must
    // skip the same ones, or it ships a row for an entity nobody published.
    vi.setSystemTime(new Date('2026-08-09T12:00:00Z'));
    const p: any = park(['2026-08-09']);
    p.getShowDocs = async () => [
      ...SHOWS,
      showDoc('blank', {active: bool(true), duration: str('15'),
        name: nameMap({EN: '   '}),
        timetable: timetable({sunday: [{time: '12:00', venue: 'v1'}]})}),
    ];
    const entityIds = new Set((await p.getEntities())
      .filter((e: any) => e.entityType === 'SHOW').map((e: any) => e.id));
    const liveShowIds = (await p.getLiveData())
      .map((l: any) => l.id).filter((id: string) => id.startsWith('energylandia-show-'));
    expect(liveShowIds).not.toContain('energylandia-show-blank');
    for (const id of liveShowIds) expect(entityIds).toContain(id);
    expect(entityIds.size).toBe(liveShowIds.length);
  });

  test('the weekday comes from PARK time, not the host clock', async () => {
    // 22:30Z on Sunday is 00:30 Monday in Warsaw. Every other clock in this file
    // has the same weekday in UTC and Warsaw, so nothing else would notice
    // parkLocalWeekday being handed 'UTC'. Monday's slot is 11:00, Sunday's 14:00.
    vi.setSystemTime(new Date('2026-08-09T22:30:00Z'));
    const live = await park(['2026-08-10']).getLiveData();
    const fire: any = live.find((l: any) => l.id === 'energylandia-show-s1');
    expect(fire.showtimes).toHaveLength(1);
    // Weekday and date must agree: Monday's time stamped on Monday's date.
    expect(fire.showtimes[0].startTime).toBe('2026-08-10T11:00:00+02:00');
  });

  test('a show that relocates midweek gets no location', async () => {
    // resolveShowVenueId is fed the WHOLE week, not just today: a show pinned to
    // Monday's venue would be placed wrongly for the rest of the week.
    vi.setSystemTime(new Date('2026-08-09T12:00:00Z'));
    const p: any = park(['2026-08-09']);
    p.getShowDocs = async () => [
      // Sunday (the simulated 'today') must itself name a venue, and a LATER day
      // must disagree. With only today's slots read, this show resolves to a
      // single venue and gets a location — so a fixture with no Sunday slot
      // would pass whether the whole week is consulted or not.
      showDoc('roam', {active: bool(true), duration: str('15'),
        name: nameMap({EN: 'Midweek Mover'}),
        timetable: timetable({
          sunday: [{time: '11:00', venue: 'v1'}],
          tuesday: [{time: '11:00', venue: 'v2'}],
        })}),
      // Control: a show appearing on ONE non-today weekday still gets its venue,
      // so the fix cannot be "never resolve a location".
      showDoc('stay', {active: bool(true), duration: str('15'),
        name: nameMap({EN: 'Tuesday Only'}),
        timetable: timetable({tuesday: [{time: '11:00', venue: 'v2'}]})}),
    ];
    const entities = await p.getEntities();
    expect(entities.find((e: any) => e.name === 'Midweek Mover').location).toBeUndefined();
    expect(entities.find((e: any) => e.name === 'Tuesday Only').location)
      .toEqual({latitude: 49.8, longitude: 19.3});
  });

  test('reads duration in BOTH Firestore shapes, so end times cannot silently vanish', async () => {
    vi.setSystemTime(new Date('2026-08-09T12:00:00Z'));
    const p: any = park(['2026-08-09']);
    p.getShowDocs = async () => [
      showDoc('n1', {active: bool(true), duration: int(25),
        name: nameMap({EN: 'Integer Duration'}),
        timetable: timetable({sunday: [{time: '12:00', venue: 'v1'}]})}),
    ];
    const live = await p.getLiveData();
    const show: any = live.find((l: any) => l.id === 'energylandia-show-n1');
    expect(show.showtimes[0].endTime).toBe('2026-08-09T12:25:00+02:00');
  });

  test('a performance after the published close is published as stated, not censored', async () => {
    // The timetable and the calendar are separate documents that genuinely
    // disagree — a real Tuesday parade sits at 20:15 against a 20:00 close. The
    // park's own timetable is the authority on its own showtimes, and a closing
    // parade running after the stated close is normal. The calendar is asked
    // only whether the park operated today, never used as a fence to filter
    // individual performances.
    vi.setSystemTime(new Date('2026-08-09T12:00:00Z'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const p: any = park(['2026-08-09']);
    p.getShowDocs = async () => [
      showDoc('late', {active: bool(true), duration: str('15'),
        name: nameMap({EN: 'Closing Parade'}),
        timetable: timetable({sunday: [{time: '20:15', venue: 'v1'}]})}),
    ];
    const live = await p.getLiveData();
    const show: any = live.find((l: any) => l.id === 'energylandia-show-late');
    expect(show.showtimes).toEqual([{
      type: 'Performance Time',
      startTime: '2026-08-09T20:15:00+02:00',
      endTime: '2026-08-09T20:30:00+02:00',
    }]);
    // And it is not treated as an anomaly: an out-of-window slot is normal data,
    // so nothing is logged about it. A warning that fires on every build from
    // September onwards is noise, not a signal.
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  test('a shows outage does NOT take the attractions\' live data down with it', async () => {
    // readCollection throws on an empty collection by design. With getActiveShows
    // in buildLiveData's Promise.all, the park renaming `shows`, tightening a rule
    // on it, or emptying it out of season stopped all 89 attractions publishing
    // status and wait times — the harsher response applied to the milder failure.
    // Live data has no deletion hazard; a missing show row just goes stale.
    vi.setSystemTime(new Date('2026-08-09T12:00:00Z'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const p: any = park(['2026-08-09']);
    p.getAttractionDocs = async () => [
      ...VENUES,
      doc('ride1', {active: bool(true), type: str('attraction'), open: bool(true),
        name: nameMap({EN: 'Hyperion'}), queueTimeId: str('')}),
    ];
    p.getShowDocs = async () => { throw new Error("collection 'shows' returned no documents"); };

    const live = await p.getLiveData();
    warn.mockRestore();
    // The ride still publishes...
    expect(live.map((l: any) => l.id)).toContain('energylandia-ride1');
    // ...and no show row is invented.
    expect(live.filter((l: any) => l.id.startsWith('energylandia-show-'))).toEqual([]);
  });

  test('a shows outage DOES stop the entity list, because a missing entity is a deletion', async () => {
    // The opposite trade, deliberately: publishing the park with its shows
    // silently removed deletes them downstream. Throwing keeps the previous data
    // ageing honestly, and a thrown error is never cached so it self-heals.
    vi.setSystemTime(new Date('2026-08-09T12:00:00Z'));
    const p: any = park(['2026-08-09']);
    p.getShowDocs = async () => { throw new Error("collection 'shows' returned no documents"); };
    await expect(p.getEntities()).rejects.toThrow(/shows/);
  });

  test('shows do not disturb the attraction rows sharing the emission', async () => {
    vi.setSystemTime(new Date('2026-08-09T12:00:00Z'));
    const live = await park(['2026-08-09']).getLiveData();
    const ids = live.map((l: any) => l.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
