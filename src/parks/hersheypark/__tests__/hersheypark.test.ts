/**
 * Hersheypark: operating notes in ride names, and per-ride hours.
 *
 * Where the names come from:
 * - Captured from the live feed on 2026-09-26, during the park's Halloween
 *   event: every "Closes at 5PM" / "Closes at 5 PM" / "Opens at 6PM" /
 *   "Dark Coaster" / "Featuring Halloween Overlay" name in the first table
 *   below, plus "Hershey Triple Tower - Hershey's Tower".
 * - Constructed to cover shapes the feed has not shown yet: "Tea Cups – Closes
 *   at 5:30 p.m." (en dash, minutes, dotted p.m.; the live name is "Tea Cups -
 *   Closes at 5PM"), both stacked-note orders, and the leave-alone names that
 *   are only a note ("Opens at 6PM", "Dark Coaster") or a plain name
 *   ("Fender Bender").
 *
 * The statusHours epochs are the live feed's own (2026-09-26 12:00-17:00
 * Eastern); the midnight-crossing and malformed windows are constructed.
 */
import {afterEach, describe, expect, it, vi} from 'vitest';
import {Hersheypark, stripOperatingNote, rideOperatingHours} from '../hersheypark.js';

const TZ = 'America/New_York';
// 2026-09-26 12:00 and 17:00 Eastern, as the feed's statusHours epochs
const OPENS = 1790438400;
const CLOSES = 1790456400;
const NOON_ET = new Date('2026-09-26T16:00:00Z');
// 2026-09-26 18:00 Eastern and 2026-09-27 01:00 Eastern
const EVENING_OPENS = 1790460000;
const AFTER_MIDNIGHT_CLOSES = 1790485200;

afterEach(() => {
  vi.useRealTimers();
});

describe('stripOperatingNote', () => {
  it.each([
    // captured
    ['Monorail - Closes at 5PM', 'Monorail'],
    ['Red Baron - Closes at 5 PM', 'Red Baron'],
    ['Skyrush - Opens at 6PM', 'Skyrush'],
    ['Comet - Dark Coaster', 'Comet'],
    ['Lightning Racer- Dark Coaster', 'Lightning Racer'],
    ["Wildcat's Revenge - Dark Coaster", "Wildcat's Revenge"],
    ['Dry Gulch Railroad - Featuring Halloween Overlay', 'Dry Gulch Railroad'],
    ['Jolly Rancher Remix - Featuring Halloween Overlay', 'Jolly Rancher Remix'],
    ['Laff Trakk - Dark Coaster', 'Laff Trakk'],
    // constructed
    ['Tea Cups – Closes at 5:30 p.m.', 'Tea Cups'],
    ['Comet - Dark Coaster - Closes at 9PM', 'Comet'],
    ['Comet - Closes at 9PM - Dark Coaster', 'Comet'],
  ])('%s -> %s', (name, expected) => {
    expect(stripOperatingNote(name)).toBe(expected);
  });

  it.each([
    "Hershey Triple Tower - Hershey's Tower",
    'Fender Bender',
    'Candymonium',
    'Opens at 6PM',
    'Dark Coaster',
  ])('leaves %j alone', (name) => {
    expect(stripOperatingNote(name)).toBe(name);
  });
});

describe('rideOperatingHours', () => {
  it('returns today\'s window in park time', () => {
    expect(rideOperatingHours({opens: OPENS, closes: CLOSES}, TZ, NOON_ET)).toEqual({
      type: 'OPERATING',
      startTime: '2026-09-26T12:00:00-04:00',
      endTime: '2026-09-26T17:00:00-04:00',
    });
  });

  it('refuses yesterday\'s window from a stale cache', () => {
    expect(rideOperatingHours({opens: OPENS, closes: CLOSES}, TZ, new Date('2026-09-27T16:00:00Z'))).toBeNull();
  });

  it('uses the park date, not UTC, near midnight', () => {
    // 23:30 Eastern on the 26th is already the 27th in UTC
    expect(rideOperatingHours({opens: OPENS, closes: CLOSES}, TZ, new Date('2026-09-27T03:30:00Z'))).not.toBeNull();
  });

  it('keeps a window that runs past midnight while it is still running', () => {
    // 00:30 Eastern on the 27th, inside an 18:00-01:00 window that opened on the 26th
    expect(rideOperatingHours({opens: EVENING_OPENS, closes: AFTER_MIDNIGHT_CLOSES}, TZ, new Date('2026-09-27T04:30:00Z'))).toEqual({
      type: 'OPERATING',
      startTime: '2026-09-26T18:00:00-04:00',
      endTime: '2026-09-27T01:00:00-04:00',
    });
  });

  it('drops a past-midnight window once it has closed', () => {
    // 02:00 Eastern on the 27th: the window ended at 01:00 and opened yesterday
    expect(rideOperatingHours({opens: EVENING_OPENS, closes: AFTER_MIDNIGHT_CLOSES}, TZ, new Date('2026-09-27T06:00:00Z'))).toBeNull();
  });

  it('rejects a window longer than 24 hours', () => {
    expect(rideOperatingHours({opens: OPENS, closes: OPENS + 24 * 3600 + 1}, TZ, NOON_ET)).toBeNull();
    expect(rideOperatingHours({opens: OPENS, closes: OPENS + 24 * 3600}, TZ, NOON_ET)).not.toBeNull();
  });

  it.each([
    [null], [undefined], ['x'], [{}], [{opens: '', closes: ''}], [{opens: CLOSES, closes: OPENS}], [{opens: 0, closes: 5}],
    // finite seconds, but past the largest date a Date can hold
    [{opens: 1e14, closes: 1e14 + 3600}],
  ])('rejects %j', (sh) => {
    expect(rideOperatingHours(sh, TZ, NOON_ET)).toBeNull();
  });
});

function park(rides: any[], status: any[]) {
  const p = new Hersheypark();
  (p as any).getPOI = async () => ({explore: [{id: 7, name: 'Hersheypark', isHersheyPark: true}], rides});
  (p as any).getStatus = async () => status;
  return p;
}

// /v2/status rows as the live feed shapes them: a ride's hours ride along as `hours`
const row = (id: number, wait: number, hours?: unknown) =>
  ({id, status: 1, type: 'rides', wait, ...(hours !== undefined ? {hours} : {})});

describe('Hersheypark destination', () => {
  it('emits ride names without operating notes', async () => {
    const entities = await (park([
      {id: 16, name: 'Monorail - Closes at 5PM'},
      {id: 99, name: "Hershey Triple Tower - Hershey's Tower"},
    ], []) as any).buildEntityList();
    const names = Object.fromEntries(entities.map((e: any) => [e.id, e.name]));
    expect(names.rides_16).toBe('Monorail');
    expect(names.rides_99).toBe("Hershey Triple Tower - Hershey's Tower");
  });

  it('carries today\'s ride hours onto live data from the status feed', async () => {
    vi.useFakeTimers({toFake: ['Date']});
    vi.setSystemTime(NOON_ET);
    const live = await (park([], [row(16, 5, {opens: OPENS, closes: CLOSES}), row(5, 10)]) as any).buildLiveData();
    const byId = Object.fromEntries(live.map((r: any) => [r.id, r]));
    expect(byId.rides_16.operatingHours).toEqual([{type: 'OPERATING', startTime: '2026-09-26T12:00:00-04:00', endTime: '2026-09-26T17:00:00-04:00'}]);
    expect(byId.rides_5.operatingHours).toBeUndefined();
    expect(byId.rides_16.queue.STANDBY.waitTime).toBe(5);
  });

  it('never reads the day-long POI cache for live data', async () => {
    vi.useFakeTimers({toFake: ['Date']});
    vi.setSystemTime(NOON_ET);
    const p = park([], [row(16, 5, {opens: OPENS, closes: CLOSES})]);
    const getPOI = vi.fn(async () => ({rides: [{id: 16, name: 'Monorail', statusHours: {opens: 1, closes: 2}}]}));
    (p as any).getPOI = getPOI;
    const live = await (p as any).buildLiveData();
    expect(getPOI).not.toHaveBeenCalled();
    expect(live[0].operatingHours[0].startTime).toBe('2026-09-26T12:00:00-04:00');
  });

  it('one malformed record does not cost its own row or the other rides anything', async () => {
    vi.useFakeTimers({toFake: ['Date']});
    vi.setSystemTime(NOON_ET);
    const live = await (park([], [row(16, 5, {opens: OPENS, closes: CLOSES}), row(20, 5, {opens: 1e14, closes: 2e14})]) as any).buildLiveData();
    const byId = Object.fromEntries(live.map((r: any) => [r.id, r]));
    expect(byId.rides_16.operatingHours).toEqual([{type: 'OPERATING', startTime: '2026-09-26T12:00:00-04:00', endTime: '2026-09-26T17:00:00-04:00'}]);
    expect(byId.rides_20.operatingHours).toBeUndefined();
    expect(byId.rides_20.queue.STANDBY.waitTime).toBe(5);
  });
});
