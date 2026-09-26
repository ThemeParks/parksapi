/**
 * Hersheypark: operating notes in ride names, and per-ride hours.
 *
 * Names below are the live feed's own, captured 2026-09-26 during the park's
 * Halloween event.
 */
import {afterEach, describe, expect, it, vi} from 'vitest';
import {Hersheypark, stripOperatingNote, rideOperatingHours} from '../hersheypark.js';

const TZ = 'America/New_York';
// 2026-09-26 12:00 and 17:00 Eastern, as the feed's statusHours epochs
const OPENS = 1790438400;
const CLOSES = 1790456400;
const NOON_ET = new Date('2026-09-26T16:00:00Z');

afterEach(() => {
  vi.useRealTimers();
});

describe('stripOperatingNote', () => {
  it.each([
    ['Monorail - Closes at 5PM', 'Monorail'],
    ['Red Baron - Closes at 5 PM', 'Red Baron'],
    ['Skyrush - Opens at 6PM', 'Skyrush'],
    ['Comet - Dark Coaster', 'Comet'],
    ['Lightning Racer- Dark Coaster', 'Lightning Racer'],
    ["Wildcat's Revenge - Dark Coaster", "Wildcat's Revenge"],
    ['Dry Gulch Railroad - Featuring Halloween Overlay', 'Dry Gulch Railroad'],
    ['Jolly Rancher Remix - Featuring Halloween Overlay', 'Jolly Rancher Remix'],
    ['Laff Trakk - Dark Coaster', 'Laff Trakk'],
    ['Tea Cups – Closes at 5:30 p.m.', 'Tea Cups'],
    ['Comet - Dark Coaster - Closes at 9PM', 'Comet'],
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

  it('refuses yesterday\'s window from a day-old cache', () => {
    expect(rideOperatingHours({opens: OPENS, closes: CLOSES}, TZ, new Date('2026-09-27T16:00:00Z'))).toBeNull();
  });

  it('uses the park date, not UTC, near midnight', () => {
    // 23:30 Eastern on the 26th is already the 27th in UTC
    expect(rideOperatingHours({opens: OPENS, closes: CLOSES}, TZ, new Date('2026-09-27T03:30:00Z'))).not.toBeNull();
  });

  it.each([
    [null], [undefined], ['x'], [{}], [{opens: '', closes: ''}], [{opens: CLOSES, closes: OPENS}], [{opens: 0, closes: 5}],
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

  it('carries today\'s ride hours onto live data', async () => {
    vi.useFakeTimers({toFake: ['Date']});
    vi.setSystemTime(NOON_ET);
    const live = await (park(
      [{id: 16, name: 'Monorail - Closes at 5PM', statusHours: {opens: OPENS, closes: CLOSES}}, {id: 5, name: 'Fender Bender', statusHours: null}],
      [{id: 16, status: 1, type: 'rides', wait: 5}, {id: 5, status: 1, type: 'rides', wait: 10}],
    ) as any).buildLiveData();
    const byId = Object.fromEntries(live.map((r: any) => [r.id, r]));
    expect(byId.rides_16.operatingHours).toEqual([{type: 'OPERATING', startTime: '2026-09-26T12:00:00-04:00', endTime: '2026-09-26T17:00:00-04:00'}]);
    expect(byId.rides_5.operatingHours).toBeUndefined();
    expect(byId.rides_16.queue.STANDBY.waitTime).toBe(5);
  });

  it('keeps wait times when the POI feed fails', async () => {
    const p = park([], [{id: 16, status: 1, type: 'rides', wait: 5}]);
    (p as any).getPOI = async () => { throw new Error('poi down'); };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const live = await (p as any).buildLiveData();
    expect(live).toHaveLength(1);
    expect(live[0].queue.STANDBY.waitTime).toBe(5);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
