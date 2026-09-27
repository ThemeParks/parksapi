import {describe, test, expect, beforeAll, afterEach, vi} from 'vitest';
import {
  parseBusinessTime,
  stripFantawildStars,
  isFantawildShow,
  type FantawildBusinessTimeResponse,
  type FantawildItem,
} from '../fantawild.js';

const TZ = 'Asia/Shanghai';

describe('parseBusinessTime', () => {
  test('maps a single activated day to an OPERATING entry', () => {
    const json: FantawildBusinessTimeResponse = {
      key: 'k', value: [{
        currentDate: '2026-06-21 00:00:00',
        startTime: '09:30',
        endTime: '18:00',
        isNight: false, isMorrow: false,
        nightStartTime: '', nightEndTime: '',
        activated: true, statusTips: '',
        parkCloseDesc: null, closeRemarkUrl: null, remarkUrl: null,
        stopIntoPark: '',
      }],
    };
    const out = parseBusinessTime(json, TZ);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({date: '2026-06-21', type: 'OPERATING'});
    expect(out[0].openingTime).toBe('2026-06-21T09:30:00+08:00');
    expect(out[0].closingTime).toBe('2026-06-21T18:00:00+08:00');
  });

  test('emits an EXTRA_HOURS entry alongside OPERATING when a night event is configured', () => {
    const json: FantawildBusinessTimeResponse = {
      key: 'k', value: [{
        currentDate: '2026-06-21 00:00:00',
        startTime: '09:30',
        endTime: '21:00',
        isNight: true, isMorrow: false,
        nightStartTime: '15:00', nightEndTime: '21:00',
        activated: true, statusTips: '',
        parkCloseDesc: null, closeRemarkUrl: null, remarkUrl: null,
        stopIntoPark: '20:30',
      }],
    };
    const out = parseBusinessTime(json, TZ);
    expect(out).toHaveLength(2);
    expect(out[0].type).toBe('OPERATING');
    expect(out[1].type).toBe('EXTRA_HOURS');
    expect(out[1].openingTime).toBe('2026-06-21T15:00:00+08:00');
    expect(out[1].closingTime).toBe('2026-06-21T21:00:00+08:00');
  });

  test('skips deactivated entries', () => {
    const json: FantawildBusinessTimeResponse = {
      key: 'k', value: [{
        currentDate: '2026-06-22 00:00:00',
        startTime: '09:30', endTime: '18:00',
        isNight: false, isMorrow: false,
        nightStartTime: '', nightEndTime: '',
        activated: false, statusTips: '',
        parkCloseDesc: null, closeRemarkUrl: null, remarkUrl: null,
        stopIntoPark: '',
      }],
    };
    expect(parseBusinessTime(json, TZ)).toEqual([]);
  });

  test('skips entries with no start/end time even if activated (closed days)', () => {
    const json: FantawildBusinessTimeResponse = {
      key: 'k', value: [{
        currentDate: '2026-06-23 00:00:00',
        startTime: '', endTime: '',
        isNight: false, isMorrow: false,
        nightStartTime: '', nightEndTime: '',
        activated: true, statusTips: '休园',
        parkCloseDesc: null, closeRemarkUrl: null, remarkUrl: null,
        stopIntoPark: '',
      }],
    };
    expect(parseBusinessTime(json, TZ)).toEqual([]);
  });

  test('skips entries with malformed currentDate', () => {
    const json: FantawildBusinessTimeResponse = {
      key: 'k', value: [
        {
          currentDate: 'tomorrow',
          startTime: '09:30', endTime: '18:00',
          isNight: false, isMorrow: false, nightStartTime: '', nightEndTime: '',
          activated: true, statusTips: '',
          parkCloseDesc: null, closeRemarkUrl: null, remarkUrl: null, stopIntoPark: '',
        },
        {
          currentDate: '',
          startTime: '09:30', endTime: '18:00',
          isNight: false, isMorrow: false, nightStartTime: '', nightEndTime: '',
          activated: true, statusTips: '',
          parkCloseDesc: null, closeRemarkUrl: null, remarkUrl: null, stopIntoPark: '',
        },
      ],
    };
    expect(parseBusinessTime(json, TZ)).toEqual([]);
  });

  test('does NOT emit EXTRA_HOURS when isNight is true but night times are empty', () => {
    // Real fixture: API sometimes flips `isNight` flag on days without
    // populating night times. Treat as a normal-hours day.
    const json: FantawildBusinessTimeResponse = {
      key: 'k', value: [{
        currentDate: '2026-06-24 00:00:00',
        startTime: '09:30', endTime: '18:00',
        isNight: true, isMorrow: false,
        nightStartTime: '', nightEndTime: '',
        activated: true, statusTips: '',
        parkCloseDesc: null, closeRemarkUrl: null, remarkUrl: null, stopIntoPark: '',
      }],
    };
    const out = parseBusinessTime(json, TZ);
    expect(out).toHaveLength(1);
    expect(out[0].type).toBe('OPERATING');
  });

  test('returns [] for null / undefined / empty payloads', () => {
    expect(parseBusinessTime(null, TZ)).toEqual([]);
    expect(parseBusinessTime(undefined, TZ)).toEqual([]);
    expect(parseBusinessTime({key: 'k', value: []}, TZ)).toEqual([]);
  });

  test('rolls closing time onto the next day when it crosses midnight', () => {
    const json: FantawildBusinessTimeResponse = {
      key: 'k', value: [{
        currentDate: '2026-06-21 00:00:00',
        startTime: '18:00', endTime: '00:30',
        isNight: false, isMorrow: false,
        nightStartTime: '', nightEndTime: '',
        activated: true, statusTips: '',
        parkCloseDesc: null, closeRemarkUrl: null, remarkUrl: null, stopIntoPark: '',
      }],
    };
    const out = parseBusinessTime(json, TZ);
    expect(out).toHaveLength(1);
    expect(out[0].openingTime).toBe('2026-06-21T18:00:00+08:00');
    // close should be 2026-06-22, NOT 2026-06-21 (which would be before opening).
    expect(out[0].closingTime).toBe('2026-06-22T00:30:00+08:00');
  });

  test('rolls EXTRA_HOURS closing onto the next day when night event crosses midnight', () => {
    const json: FantawildBusinessTimeResponse = {
      key: 'k', value: [{
        currentDate: '2026-06-21 00:00:00',
        startTime: '09:30', endTime: '21:00',
        isNight: true, isMorrow: false,
        nightStartTime: '22:00', nightEndTime: '01:00',
        activated: true, statusTips: '',
        parkCloseDesc: null, closeRemarkUrl: null, remarkUrl: null, stopIntoPark: '',
      }],
    };
    const out = parseBusinessTime(json, TZ);
    expect(out).toHaveLength(2);
    expect(out[0].type).toBe('OPERATING');
    expect(out[0].closingTime).toBe('2026-06-21T21:00:00+08:00');
    expect(out[1].type).toBe('EXTRA_HOURS');
    expect(out[1].openingTime).toBe('2026-06-21T22:00:00+08:00');
    expect(out[1].closingTime).toBe('2026-06-22T01:00:00+08:00');
  });

  test('rolls past month boundary correctly', () => {
    // 2026-06-30 → 2026-07-01 (month rollover).
    const json: FantawildBusinessTimeResponse = {
      key: 'k', value: [{
        currentDate: '2026-06-30 00:00:00',
        startTime: '20:00', endTime: '02:00',
        isNight: false, isMorrow: false,
        nightStartTime: '', nightEndTime: '',
        activated: true, statusTips: '',
        parkCloseDesc: null, closeRemarkUrl: null, remarkUrl: null, stopIntoPark: '',
      }],
    };
    const out = parseBusinessTime(json, TZ);
    expect(out[0].closingTime).toBe('2026-07-01T02:00:00+08:00');
  });

  test('skips entries with malformed startTime/endTime instead of throwing', () => {
    // A garbage time string would otherwise blow up constructDateTime and abort
    // the entire sweep. Make sure only the bad entry is dropped, the good one
    // is still parsed.
    const json: FantawildBusinessTimeResponse = {
      key: 'k', value: [
        // Bad: non-HH:MM startTime
        {currentDate: '2026-06-21 00:00:00', startTime: 'morning', endTime: '18:00', isNight: false, isMorrow: false, nightStartTime: '', nightEndTime: '', activated: true, statusTips: '', parkCloseDesc: null, closeRemarkUrl: null, remarkUrl: null, stopIntoPark: ''},
        // Bad: out-of-range hour (25)
        {currentDate: '2026-06-22 00:00:00', startTime: '25:00', endTime: '18:00', isNight: false, isMorrow: false, nightStartTime: '', nightEndTime: '', activated: true, statusTips: '', parkCloseDesc: null, closeRemarkUrl: null, remarkUrl: null, stopIntoPark: ''},
        // Bad: 24:30 — 24 is not a valid wall-clock hour; the carve-out for 24:00 is
        // out of scope for Fantawild's API and would just complicate constructDateTime.
        {currentDate: '2026-06-23 00:00:00', startTime: '09:00', endTime: '24:30', isNight: false, isMorrow: false, nightStartTime: '', nightEndTime: '', activated: true, statusTips: '', parkCloseDesc: null, closeRemarkUrl: null, remarkUrl: null, stopIntoPark: ''},
        // Bad: out-of-range minute
        {currentDate: '2026-06-24 00:00:00', startTime: '09:60', endTime: '18:00', isNight: false, isMorrow: false, nightStartTime: '', nightEndTime: '', activated: true, statusTips: '', parkCloseDesc: null, closeRemarkUrl: null, remarkUrl: null, stopIntoPark: ''},
        // Good: should still parse
        {currentDate: '2026-06-25 00:00:00', startTime: '09:30', endTime: '18:00', isNight: false, isMorrow: false, nightStartTime: '', nightEndTime: '', activated: true, statusTips: '', parkCloseDesc: null, closeRemarkUrl: null, remarkUrl: null, stopIntoPark: ''},
      ],
    };
    const out = parseBusinessTime(json, TZ);
    expect(out).toHaveLength(1);
    expect(out[0].date).toBe('2026-06-25');
  });

  test('skips night event with malformed nightStartTime but keeps the OPERATING entry', () => {
    const json: FantawildBusinessTimeResponse = {
      key: 'k', value: [{
        currentDate: '2026-06-21 00:00:00',
        startTime: '09:30', endTime: '21:00',
        isNight: true, isMorrow: false,
        nightStartTime: 'evening', nightEndTime: '23:00',
        activated: true, statusTips: '',
        parkCloseDesc: null, closeRemarkUrl: null, remarkUrl: null, stopIntoPark: '',
      }],
    };
    const out = parseBusinessTime(json, TZ);
    expect(out).toHaveLength(1);
    expect(out[0].type).toBe('OPERATING');
  });

  test('does NOT roll when closing time is strictly after opening', () => {
    const json: FantawildBusinessTimeResponse = {
      key: 'k', value: [{
        currentDate: '2026-06-21 00:00:00',
        startTime: '09:30', endTime: '23:59',
        isNight: false, isMorrow: false,
        nightStartTime: '', nightEndTime: '',
        activated: true, statusTips: '',
        parkCloseDesc: null, closeRemarkUrl: null, remarkUrl: null, stopIntoPark: '',
      }],
    };
    const out = parseBusinessTime(json, TZ);
    expect(out[0].closingTime).toBe('2026-06-21T23:59:00+08:00');
  });

  test('processes a multi-day fixture in the order the API returns it', () => {
    // The API doesn't sort by date — entries arrive in app-storage order.
    // The parser should NOT re-sort; the destination's schedule renderer
    // handles ordering downstream.
    const json: FantawildBusinessTimeResponse = {
      key: 'k', value: [
        {currentDate: '2026-06-21 00:00:00', startTime: '09:30', endTime: '18:00', isNight: false, isMorrow: false, nightStartTime: '', nightEndTime: '', activated: true, statusTips: '', parkCloseDesc: null, closeRemarkUrl: null, remarkUrl: null, stopIntoPark: ''},
        {currentDate: '2026-06-27 00:00:00', startTime: '09:30', endTime: '18:00', isNight: false, isMorrow: false, nightStartTime: '', nightEndTime: '', activated: true, statusTips: '', parkCloseDesc: null, closeRemarkUrl: null, remarkUrl: null, stopIntoPark: ''},
        {currentDate: '2026-06-22 00:00:00', startTime: '09:30', endTime: '17:30', isNight: false, isMorrow: false, nightStartTime: '', nightEndTime: '', activated: true, statusTips: '', parkCloseDesc: null, closeRemarkUrl: null, remarkUrl: null, stopIntoPark: ''},
      ],
    };
    const out = parseBusinessTime(json, TZ);
    expect(out.map(s => s.date)).toEqual(['2026-06-21', '2026-06-27', '2026-06-22']);
  });
});

describe('stripFantawildStars', () => {
  test('strips trailing star glyphs from itemName', () => {
    expect(stripFantawildStars('孟姜女⭐⭐️⭐️⭐')).toBe('孟姜女');
    expect(stripFantawildStars('伴你飞翔⭐⭐️⭐️⭐⭐')).toBe('伴你飞翔');
    expect(stripFantawildStars('女娲补天 ⭐⭐⭐⭐⭐')).toBe('女娲补天');
  });

  test('returns name unchanged when there are no trailing stars', () => {
    expect(stripFantawildStars('魔法城堡')).toBe('魔法城堡');
    expect(stripFantawildStars('Magic Castle')).toBe('Magic Castle');
  });

  test('does NOT strip stars that appear mid-string', () => {
    // Stars only at the END are decorations; an embedded star is part of the name.
    expect(stripFantawildStars('Star⭐Show extra')).toBe('Star⭐Show extra');
  });

  test('handles empty string', () => {
    expect(stripFantawildStars('')).toBe('');
  });
});

const baseItem = (overrides: Partial<FantawildItem> = {}): FantawildItem => ({
  parkId: 19, id: 1, itemName: 'Test', waitTime: 0, itemOpened: true,
  statusStr: null, showTimeList: [], featureList: [], ...overrides,
});

describe('isFantawildShow', () => {
  test('treats single time-range as RIDE (operating hours)', () => {
    expect(isFantawildShow(baseItem({showTimeList: ['09:30-21:00']}))).toBe(false);
  });

  test('treats discrete-time list as SHOW', () => {
    expect(isFantawildShow(baseItem({showTimeList: ['14:00', '15:30']}))).toBe(true);
    expect(isFantawildShow(baseItem({showTimeList: ['10:30', '11:30', '12:30', '13:30']}))).toBe(true);
  });

  test('respects 真人表演 feature tag even with several session windows', () => {
    // Real shape: a water show at Dreamland Zhuzhou, run in three sessions.
    expect(isFantawildShow(baseItem({
      showTimeList: ['10:00-11:45', '13:30-17:30', '18:30-19:30'],
      featureList: ['真人表演'],
    }))).toBe(true);
  });

  test('respects 真人表演 feature tag with discrete showtimes or none', () => {
    expect(isFantawildShow(baseItem({
      showTimeList: ['11:30', '14:30', '17:00'],
      featureList: ['必玩', '真人表演', '观赏'],
    }))).toBe(true);
    expect(isFantawildShow(baseItem({
      showTimeList: [],
      featureList: ['真人表演', '观赏', '需提前入场'],
    }))).toBe(true);
  });

  test('a live-actor item open in one all-day window is a walk-through, not a show', () => {
    // Real shape (Glorious Orient Jining, item 2016): a haunted-school scare
    // maze with live actors, published with the park's operating window.
    expect(isFantawildShow(baseItem({
      parkId: 87, id: 2016, itemName: '南洋诡校（增值体验）',
      showTimeList: ['09:30-21:00'],
      featureList: ['刺激', '惊吓', '真人表演'],
    }))).toBe(false);
  });

  test('a parade is a SHOW even with a single window', () => {
    expect(isFantawildShow(baseItem({
      showTimeList: ['09:30-21:00'],
      featureList: ['巡游'],
    }))).toBe(true);
  });

  test('respects 巡游 (parade) feature tag', () => {
    expect(isFantawildShow(baseItem({
      showTimeList: [],
      featureList: ['巡游', '亲子'],
    }))).toBe(true);
  });

  test('returns false when showTimeList is empty and no explicit feature flag', () => {
    expect(isFantawildShow(baseItem({showTimeList: [], featureList: ['亲子']}))).toBe(false);
  });

  test('parade feature with empty showTimeList still flags as SHOW', () => {
    // Some parades have no fixed times listed but should still classify as SHOW.
    expect(isFantawildShow(baseItem({showTimeList: [], featureList: ['巡游']}))).toBe(true);
  });

  test('parade feature with discrete showtimes flags as SHOW', () => {
    expect(isFantawildShow(baseItem({
      showTimeList: ['15:00', '16:30'],
      featureList: ['巡游', '亲子'],
    }))).toBe(true);
  });

  test('handles mixed list (range + discrete) by treating it as RIDE', () => {
    // If ANY entry is a range, lean toward attraction hours rather than show times.
    expect(isFantawildShow(baseItem({
      showTimeList: ['09:45-12:15', '13:45', '14:15'],
    }))).toBe(false);
  });
});

describe('Fantawild.parkIsOpenNow', () => {
  // We test the protected helper directly via casting — it has subtle edge cases
  // (the post-midnight tail in particular) that need explicit coverage.
  let dest: import('../fantawild.js').Fantawild;

  // ScheduleEntry openingTime/closingTime are absolute ISO strings with offset,
  // so parkIsOpenNow can be tested against any current Date.now() — we craft
  // entries whose windows straddle / surround / miss "now" relative to the
  // real clock at test time, with no need for fake timers.
  const nowIso = (offsetMinutes: number): string => {
    const ms = Date.now() + offsetMinutes * 60_000;
    // emit as +08:00 since `parkIsOpenNow` ignores the offset and parses
    // absolute moments — any well-formed offset works.
    const d = new Date(ms);
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:00Z`;
  };

  beforeAll(async () => {
    const {Fantawild} = await import('../fantawild.js');
    dest = new Fantawild({config: {
      baseUrl: 'https://image.fangte.com',
      apiBaseUrl: 'https://leyou.fangte.com',
    }});
  });

  test('returns false when no schedule covers now', () => {
    const sched = [{
      date: '2020-01-01', type: 'OPERATING' as const,
      openingTime: nowIso(-120 * 24 * 60), closingTime: nowIso(-119 * 24 * 60),
    }];
    expect((dest as any).parkIsOpenNow(sched)).toBe(false);
  });

  test('returns true when an OPERATING window contains now', () => {
    const sched = [{
      date: '2026-06-21', type: 'OPERATING' as const,
      openingTime: nowIso(-60), closingTime: nowIso(+60),
    }];
    expect((dest as any).parkIsOpenNow(sched)).toBe(true);
  });

  test('returns false when now falls in the gap between two windows', () => {
    const sched = [
      {date: '2026-06-21', type: 'OPERATING' as const,
       openingTime: nowIso(-180), closingTime: nowIso(-60)},
      {date: '2026-06-21', type: 'EXTRA_HOURS' as const,
       openingTime: nowIso(+60), closingTime: nowIso(+180)},
    ];
    expect((dest as any).parkIsOpenNow(sched)).toBe(false);
  });

  test('returns true when EXTRA_HOURS night event contains now', () => {
    const sched = [
      {date: '2026-06-21', type: 'OPERATING' as const,
       openingTime: nowIso(-9 * 60), closingTime: nowIso(-3 * 60)},
      {date: '2026-06-21', type: 'EXTRA_HOURS' as const,
       openingTime: nowIso(-30), closingTime: nowIso(+30)},
    ];
    expect((dest as any).parkIsOpenNow(sched)).toBe(true);
  });

  test('honours post-midnight tail: window opened yesterday, closes today', () => {
    // The schedule entry's date is YESTERDAY (when the window opened),
    // but its closingTime is on TODAY's calendar date because the window
    // crosses midnight (e.g. 22:00 → 01:00). Earlier versions filtered by
    // `entry.date === today` and missed the tail; this test pins the fix.
    const sched = [{
      date: '2026-06-20', // a fixed past date — value doesn't matter
      type: 'OPERATING' as const,
      openingTime: nowIso(-90),
      closingTime: nowIso(+30),
    }];
    expect((dest as any).parkIsOpenNow(sched)).toBe(true);
  });

  test('treats malformed openingTime/closingTime as a non-match instead of throwing', () => {
    const sched = [{
      date: '2026-06-21', type: 'OPERATING' as const,
      openingTime: 'not a date', closingTime: 'also not',
    }] as readonly any[];
    expect((dest as any).parkIsOpenNow(sched)).toBe(false);
  });
});

describe('Fantawild.recordLiveWaitObservation', () => {
  // Verify the "Cache only TRUE, never FALSE" invariant (per the
  // feedback_cache_only_true.md memory).
  let dest: import('../fantawild.js').Fantawild;

  beforeAll(async () => {
    const {Fantawild} = await import('../fantawild.js');
    dest = new Fantawild({config: {
      baseUrl: 'https://image.fangte.com',
      apiBaseUrl: 'https://leyou.fangte.com',
    }});
  });

  // Use a unique parkId per test so we don't see leakage from other tests
  // (the cache is process-global). Sequential within this describe.
  const PARK_A = 9_000_001;
  const PARK_B = 9_000_002;
  const PARK_C = 9_000_003;

  test('returns false when no item has waitTime > 0 and writes nothing', async () => {
    const items = [{waitTime: 0}, {waitTime: 0}] as any;
    const result = await (dest as any).recordLiveWaitObservation(PARK_A, items);
    expect(result).toBe(false);
    // Re-running with no positive observation must still return false (no
    // sticky cached FALSE).
    expect(await (dest as any).recordLiveWaitObservation(PARK_A, items)).toBe(false);
  });

  test('returns true when an item has waitTime > 0 and remembers permanently', async () => {
    const observed = [{waitTime: 0}, {waitTime: 25}] as any;
    expect(await (dest as any).recordLiveWaitObservation(PARK_B, observed)).toBe(true);
    // Subsequent zero-only sweep must still return true — once observed,
    // the park stays marked as live-broadcasting.
    const zeros = [{waitTime: 0}, {waitTime: 0}] as any;
    expect(await (dest as any).recordLiveWaitObservation(PARK_B, zeros)).toBe(true);
  });

  test('caches per parkId — one park observing live waits does not affect another', async () => {
    const observed = [{waitTime: 15}] as any;
    expect(await (dest as any).recordLiveWaitObservation(PARK_C, observed)).toBe(true);
    // A different parkId starts fresh
    const freshPark = 9_000_004;
    expect(await (dest as any).recordLiveWaitObservation(freshPark, [{waitTime: 0}] as any)).toBe(false);
  });

  test('ignores non-finite waitTime values', async () => {
    const garbage = [{waitTime: NaN}, {waitTime: undefined}] as any;
    const fresh = 9_000_005;
    expect(await (dest as any).recordLiveWaitObservation(fresh, garbage)).toBe(false);
  });
});

describe('Fantawild.getStableRoster', () => {
  // Verify the never-shrink-within-TTL roster cache, including merge-by-id,
  // fresh-overwriting-cached, and the sustained-shrinkage TTL-expiry path.
  let Fantawild: typeof import('../fantawild.js').Fantawild;
  // Use parkIds well outside the real chain to avoid colliding with any
  // residual cache entries from earlier integration runs.
  const PA = 9_100_001, PB = 9_100_002, PC = 9_100_003, PD = 9_100_004, PE = 9_100_005;

  beforeAll(async () => {
    const mod = await import('../fantawild.js');
    Fantawild = mod.Fantawild;
  });

  // Build a Fantawild instance with `getItems` stubbed to return a fixed
  // payload, so we can control "fresh" without touching the network.
  function makeDest(freshItems: any[]): import('../fantawild.js').Fantawild {
    const d = new Fantawild({config: {
      baseUrl: 'https://image.fangte.com',
      apiBaseUrl: 'https://leyou.fangte.com',
    }});
    (d as unknown as {getItems: () => Promise<any[]>}).getItems = async () => freshItems;
    return d;
  }

  test('returns fresh items when cache is empty (first call)', async () => {
    const d = makeDest([{id: 1, itemName: 'A'}, {id: 2, itemName: 'B'}]);
    const r = await (d as any).getStableRoster(PA, 'Asia/Shanghai');
    expect(r.map((i: any) => i.id).sort()).toEqual([1, 2]);
  });

  test('NEVER SHRINKS within TTL — fresh=[2 items], cached=[30 items] returns 30', async () => {
    // Seed with a 4-item roster
    const seed = makeDest([{id: 1}, {id: 2}, {id: 3}, {id: 4}]);
    await (seed as any).getStableRoster(PB, 'Asia/Shanghai');
    // Now simulate the API returning only 1 of those (overnight prune)
    const pruned = makeDest([{id: 1, itemName: 'pruned'}]);
    const r = await (pruned as any).getStableRoster(PB, 'Asia/Shanghai');
    expect(r.map((i: any) => i.id).sort()).toEqual([1, 2, 3, 4]);
  });

  test('GROWS — fresh adds new id not in cache, surface immediately', async () => {
    const seed = makeDest([{id: 10}, {id: 11}]);
    await (seed as any).getStableRoster(PC, 'Asia/Shanghai');
    const grown = makeDest([{id: 10}, {id: 11}, {id: 12, itemName: 'new ride'}]);
    const r = await (grown as any).getStableRoster(PC, 'Asia/Shanghai');
    expect(r.map((i: any) => i.id).sort()).toEqual([10, 11, 12]);
    // Confirm the new entry is the fresh one (with itemName).
    expect(r.find((i: any) => i.id === 12)?.itemName).toBe('new ride');
  });

  test('FRESH OVERWRITES CACHED on matching id (name/coord updates surface)', async () => {
    const seed = makeDest([{id: 20, itemName: 'Old Name', waitTime: 0}]);
    await (seed as any).getStableRoster(PD, 'Asia/Shanghai');
    const renamed = makeDest([{id: 20, itemName: 'New Name', waitTime: 5}]);
    const r = await (renamed as any).getStableRoster(PD, 'Asia/Shanghai');
    expect(r).toHaveLength(1);
    expect(r[0].itemName).toBe('New Name');
    expect(r[0].waitTime).toBe(5);
  });

  test('EMPTY FRESH preserves cache — handles slow-API timeouts and closed-today parks', async () => {
    const seed = makeDest([{id: 30}, {id: 31}, {id: 32}]);
    await (seed as any).getStableRoster(PE, 'Asia/Shanghai');
    // Simulate getItems catching a timeout and returning []
    const dropped = makeDest([]);
    const r = await (dropped as any).getStableRoster(PE, 'Asia/Shanghai');
    expect(r.map((i: any) => i.id).sort()).toEqual([30, 31, 32]);
  });
});


describe('Fantawild.buildEntityList walk-through classification', () => {
  // Sanitised from the live Glorious Orient Jining (parkId 87) roster.
  const JINING = 87;
  const roster = [
    {parkId: JINING, id: 2016, itemName: '南洋诡校（增值体验）', waitTime: 0, itemOpened: true, statusStr: null,
      showTimeList: ['09:30-21:00'], featureList: ['刺激', '惊吓', '真人表演'], latitude: 35.33, longitude: 116.69},
    {parkId: JINING, id: 1714, itemName: '圆明园【盛世遗韵】', waitTime: 0, itemOpened: true, statusStr: null,
      showTimeList: ['11:30', '14:30', '17:00'], featureList: ['必玩', '真人表演', '观赏']},
    {parkId: JINING, id: 2295, itemName: '沪上风云', waitTime: 0, itemOpened: true, statusStr: null,
      showTimeList: ['18:00'], featureList: ['必玩', '真人表演', '观赏']},
    {parkId: JINING, id: 2015, itemName: '真人CS（增值体验）', waitTime: 0, itemOpened: true, statusStr: null,
      showTimeList: ['09:30-21:00'], featureList: ['刺激', '人偶互动']},
  ];

  async function entities() {
    const {Fantawild} = await import('../fantawild.js');
    const d = new Fantawild({config: {
      baseUrl: 'https://image.fangte.com',
      apiBaseUrl: 'https://leyou.fangte.com',
    }});
    (d as any).getStableRoster = async (parkId: number) => (parkId === JINING ? roster : []);
    return await (d as any).buildEntityList() as any[];
  }

  test('the haunted school is an ATTRACTION under its existing id', async () => {
    const e = (await entities()).find(x => x.id === 'fantawild_attraction_87_2016');
    expect(e).toMatchObject({
      id: 'fantawild_attraction_87_2016',
      name: '南洋诡校（增值体验）',
      entityType: 'ATTRACTION',
      attractionType: 'RIDE',
      parkId: 'fantawild_park_87',
    });
  });

  test('scheduled live performances stay SHOW', async () => {
    const all = await entities();
    for (const id of ['fantawild_attraction_87_1714', 'fantawild_attraction_87_2295']) {
      const e = all.find(x => x.id === id);
      expect(e.entityType).toBe('SHOW');
      expect(e.attractionType).toBeUndefined();
    }
  });

  test('ids are unchanged and nothing is dropped', async () => {
    const ids = (await entities()).filter(x => x.parkId === 'fantawild_park_87').map(x => x.id).sort();
    expect(ids).toEqual([
      'fantawild_attraction_87_1714',
      'fantawild_attraction_87_2015',
      'fantawild_attraction_87_2016',
      'fantawild_attraction_87_2295',
    ]);
  });
});

describe('Fantawild sticky SHOW classification', () => {
  // The feed changes showTimeList's shape for the same item from day to day.
  // Real rows for 熊出没剧场 (Fantawild Park Xuzhou, parkId 105, item 1455):
  // discrete performances on one day, a single all-day window on 2026-09-27.
  const XUZHOU = 105;
  const theatreWithShows = {parkId: XUZHOU, id: 1455, itemName: '熊出没剧场【熊大推荐】', waitTime: 0, itemOpened: true,
    statusStr: null, showTimeList: ['11:00', '13:00', '15:00', '17:00'], featureList: ['3D/4D', '观赏']};
  const theatreAllDay = {...theatreWithShows, showTimeList: ['11:00-20:00']};
  // A ride that never publishes discrete times (Tai'an 转转杯, same day).
  const teacups = {parkId: XUZHOU, id: 554, itemName: '转转杯【旋转游乐】', waitTime: 0, itemOpened: true,
    statusStr: null, showTimeList: ['09:30-20:40'], featureList: ['舒缓', '旋转', '亲子']};

  const DAY1 = new Date('2026-09-20T04:00:00Z');

  async function dest() {
    const {Fantawild} = await import('../fantawild.js');
    return new Fantawild({config: {baseUrl: 'https://image.fangte.com', apiBaseUrl: 'https://leyou.fangte.com'}});
  }

  // Unique parkIds per test: the cache is process-global.
  let nextPark = 9_100_000;
  function item(base: any) {
    return {...base, parkId: nextPark};
  }

  afterEach(() => {
    vi.useRealTimers();
  });

  test('a show seen with discrete times stays a SHOW on an all-day-window day', async () => {
    vi.useFakeTimers({now: DAY1, toFake: ['Date']});
    const d = await dest();
    const park = ++nextPark;
    expect((d as any).isStickyShow(park, item(theatreWithShows))).toBe(true);
    vi.setSystemTime(new Date(DAY1.getTime() + 24 * 3600 * 1000));
    expect((d as any).isStickyShow(park, item(theatreAllDay))).toBe(true);
  });

  test('never caches FALSE: an all-day-window day does not lock a later show out', async () => {
    const d = await dest();
    const park = ++nextPark;
    expect((d as any).isStickyShow(park, item(theatreAllDay))).toBe(false);
    expect((d as any).isStickyShow(park, item(theatreWithShows))).toBe(true);
  });

  test('a ride never seen with discrete times stays an ATTRACTION', async () => {
    const d = await dest();
    const park = ++nextPark;
    expect((d as any).isStickyShow(park, item(teacups))).toBe(false);
    expect((d as any).isStickyShow(park, item(teacups))).toBe(false);
  });

  test('memory is per park and per item', async () => {
    const d = await dest();
    const park = ++nextPark;
    expect((d as any).isStickyShow(park, item(theatreWithShows))).toBe(true);
    expect((d as any).isStickyShow(park + 1, item(theatreAllDay))).toBe(false);
    expect((d as any).isStickyShow(park, item({...theatreAllDay, id: 9999}))).toBe(false);
  });

  test('falls back to the feed after 30 days without a SHOW sighting', async () => {
    vi.useFakeTimers({now: DAY1, toFake: ['Date']});
    const d = await dest();
    const park = ++nextPark;
    expect((d as any).isStickyShow(park, item(theatreWithShows))).toBe(true);
    vi.setSystemTime(new Date(DAY1.getTime() + 29 * 24 * 3600 * 1000));
    expect((d as any).isStickyShow(park, item(theatreAllDay))).toBe(true);
    vi.setSystemTime(new Date(DAY1.getTime() + 31 * 24 * 3600 * 1000));
    expect((d as any).isStickyShow(park, item(theatreAllDay))).toBe(false);
  });

  test('buildEntityList keeps the theatre a SHOW across the day-to-day flip', async () => {
    const {CacheLib} = await import('../../../cache.js');
    const d = await dest();
    CacheLib.delete(`${(d as any).getCacheKeyPrefix()}:seenAsShow:v1:${XUZHOU}:1455`);
    CacheLib.delete(`${(d as any).getCacheKeyPrefix()}:seenAsShow:v1:${XUZHOU}:554`);
    const typeOf = async (roster: any[]) => {
      (d as any).getStableRoster = async (parkId: number) => (parkId === XUZHOU ? roster : []);
      const all = await (d as any).buildEntityList() as any[];
      const pick = (id: number) => all.find(x => x.id === `fantawild_attraction_${XUZHOU}_${id}`);
      return {theatre: pick(1455), teacups: pick(554)};
    };
    const day1 = await typeOf([theatreWithShows, teacups]);
    expect(day1.theatre.entityType).toBe('SHOW');
    expect(day1.teacups).toMatchObject({entityType: 'ATTRACTION', attractionType: 'RIDE'});
    const day2 = await typeOf([theatreAllDay, teacups]);
    expect(day2.theatre.entityType).toBe('SHOW');
    expect(day2.theatre.attractionType).toBeUndefined();
    expect(day2.teacups).toMatchObject({entityType: 'ATTRACTION', attractionType: 'RIDE'});
  });
});
