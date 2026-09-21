import {describe, it, expect, vi, beforeEach, afterEach} from 'vitest';
import {Fantawild} from '../fantawild.js';
import {CacheLib} from '../../../cache.js';
import type {WithRaw} from '../../../destination.js';
import type {HTTPObj} from '../../../http.js';

/**
 * With `includeRaw` on, every live row and every entity carries the item the
 * current `GetItemBusinessList` response held for it, and every schedule entry
 * carries the BusinessTime entry of its day — the same entry on the day and on
 * its night session. A ride only the stable roster still knows carries nothing,
 * and so do the destination and the park. Off, nothing carries anything.
 */
// 12:00 in Asia/Shanghai, inside the park's 09:30-18:00 window
const NOW = new Date('2026-09-21T04:00:00Z');
const PARK_ID = 21;

const rideItem = {
  parkId: PARK_ID, id: 101, itemName: '孟姜女⭐⭐', waitTime: 25, itemOpened: true,
  statusStr: null, showTimeList: ['09:30-18:00'], latitude: 36.21, longitude: 120.28,
};
const showItem = {
  parkId: PARK_ID, id: 102, itemName: 'Acrobatics Show', waitTime: 0, itemOpened: true,
  statusStr: null, showTimeList: ['11:00', '15:00'],
};
// In the roster from an earlier response, absent from this tick's response
const rosterOnlyItem = {
  parkId: PARK_ID, id: 103, itemName: 'Ghost Train', waitTime: 0, itemOpened: true, statusStr: null,
};

const businessTimeDay = {
  currentDate: '2026-09-21 00:00:00',
  startTime: '09:30', endTime: '18:00',
  isNight: true, isMorrow: false,
  nightStartTime: '18:30', nightEndTime: '21:00',
  activated: true, statusTips: '',
  parkCloseDesc: null, closeRemarkUrl: null, remarkUrl: null,
  stopIntoPark: '17:30',
};
const businessTime = {key: 'BusinessTime', value: [businessTimeDay]};

function stubbedPark(includeRaw: boolean): Fantawild {
  const park = new Fantawild({config: {
    baseUrl: 'https://image.fangte.com',
    apiBaseUrl: 'https://leyou.fangte.com',
  }});
  park.includeRaw = includeRaw;
  vi.spyOn(park as any, 'getItems').mockImplementation(async (parkId: any) =>
    parkId === PARK_ID ? [rideItem, showItem] : []);
  vi.spyOn(park as any, 'getStableRoster').mockImplementation(async (parkId: any) =>
    parkId === PARK_ID ? [rideItem, showItem, rosterOnlyItem] : []);
  vi.spyOn(park as any, 'fetchBusinessTime').mockImplementation(async (parkId: any) => ({
    json: async () => (parkId === PARK_ID ? businessTime : {key: 'k', value: []}),
  } as any as HTTPObj));
  return park;
}

const rawOf = (element: object) => (element as WithRaw<object>).raw;
const ofPark = <T extends {id: string}>(elements: T[]): T[] =>
  elements.filter((e) => e.id.startsWith(`fantawild_attraction_${PARK_ID}_`));

describe('Fantawild raw upstream pieces', () => {
  beforeEach(() => {
    CacheLib.clear();
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    CacheLib.clear();
  });

  it('attaches the item to each live row, nothing to a roster-only ride', async () => {
    const live = ofPark(await stubbedPark(true).getLiveData());
    expect(live.map((l) => l.id)).toEqual([
      'fantawild_attraction_21_101',
      'fantawild_attraction_21_102',
      'fantawild_attraction_21_103',
    ]);

    expect(rawOf(live[0])).toEqual({itemBusinessList: rideItem});
    expect(rawOf(live[0])!.itemBusinessList).toBe(rideItem);
    expect(live[0].status).toBe('OPERATING');
    expect(live[0].queue).toEqual({STANDBY: {waitTime: 25}});

    expect(rawOf(live[1])!.itemBusinessList).toBe(showItem);

    // Only the roster kept this one alive, so there is no piece behind it
    expect(live[2].status).toBe('CLOSED');
    expect(rawOf(live[2])).toBeUndefined();
  });

  it('attaches the item to each entity, nothing to a roster-only ride, the park or the destination', async () => {
    const entities = await stubbedPark(true).getEntities();
    const rides = ofPark(entities);
    expect(rides.map((e) => e.id)).toEqual([
      'fantawild_attraction_21_101',
      'fantawild_attraction_21_102',
      'fantawild_attraction_21_103',
    ]);

    expect(rawOf(rides[0])).toEqual({itemBusinessList: rideItem});
    expect(rawOf(rides[0])!.itemBusinessList).toBe(rideItem);
    expect(rides[0].name).toBe('孟姜女');
    expect(rawOf(rides[1])!.itemBusinessList).toBe(showItem);
    expect(rides[1].entityType).toBe('SHOW');
    expect(rawOf(rides[2])).toBeUndefined();

    for (const id of [`fantawild_destination_${PARK_ID}`, `fantawild_park_${PARK_ID}`]) {
      expect(rawOf(entities.find((e) => e.id === id)!)).toBeUndefined();
    }
  });

  it('attaches the BusinessTime entry to the day and to its night session', async () => {
    const schedules = await stubbedPark(true).getSchedules();
    const days = schedules.find((s) => s.id === `fantawild_park_${PARK_ID}`)!.schedule;
    expect(days.map((d) => d.type)).toEqual(['OPERATING', 'EXTRA_HOURS']);
    expect(days[0].openingTime).toBe('2026-09-21T09:30:00+08:00');
    expect(days[1].closingTime).toBe('2026-09-21T21:00:00+08:00');

    expect(rawOf(days[0])).toEqual({businessTime: businessTimeDay});
    expect(rawOf(days[0])!.businessTime).toBe(businessTimeDay);
    expect(rawOf(days[1])!.businessTime).toBe(businessTimeDay);
  });

  it('carries nothing when includeRaw is off', async () => {
    const park = stubbedPark(false);
    for (const element of await park.getLiveData()) expect(rawOf(element)).toBeUndefined();
    for (const element of await park.getEntities()) expect(rawOf(element)).toBeUndefined();
    for (const schedule of await park.getSchedules()) {
      for (const element of schedule.schedule) expect(rawOf(element)).toBeUndefined();
    }
  });
});
