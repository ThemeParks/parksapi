import {describe, it, expect, vi, beforeEach, afterEach} from 'vitest';
import {MovieParkGermany, Mirabilandia} from '../parcsreunidos.js';
import {CacheLib} from '../../../cache.js';
import type {WithRaw} from '../../../destination.js';
import type {HTTPObj} from '../../../http.js';

/**
 * With `includeRaw` on, every live row carries the attraction entry it was
 * built from, every entity carries its attraction entry and the park and the
 * destination carry the establishment they were named after, and every
 * schedule entry carries the day, label key and label text the calendar page
 * held for it. Mirabilandia's own feed puts both of its requests behind each
 * row. Off, nothing carries anything.
 */
const LABELS = '[{&#34;A&#34;:&#34;10am - 5pm&#34;},{&#34;B&#34;:&#34;Halloween Horror Festival - 7pm - 11pm&#34;}]';
// One object per month, so September sits at index 8
const MONTHS = '[{},{},{},{},{},{},{},{},{&#34;20&#34;:&#34;A&#34;,&#34;21&#34;:&#34;A,B&#34;}]';
const calendarHtml = `<input id="data-hour-labels" value="${LABELS}"><input id="data-hour-2026" value="${MONTHS}">`;

const establishment = {name: 'Movie Park Germany', coordinates: {latitude: 51.6203, longitude: 6.9724}};
const rideAttraction = {
  id: 101,
  translatableName: {en: 'Bandit', de: 'Bandit'},
  place: {point: {latitude: 51.621, longitude: 6.972}},
  waitingTime: 20,
};
const closedAttraction = {id: 102, translatableName: {en: 'Van Helsing'}, waitingTime: -2};

function stubbedPark(includeRaw: boolean): MovieParkGermany {
  const park = new MovieParkGermany();
  park.includeRaw = includeRaw;
  park.appId = 'mpg';
  park.calendarUrl = 'https://calendar.example/opening-hours';
  vi.spyOn(park as any, 'getEstablishment').mockResolvedValue(establishment);
  vi.spyOn(park as any, 'getAttractions').mockResolvedValue([rideAttraction, closedAttraction]);
  vi.spyOn(park as any, 'fetchCalendarHTML').mockResolvedValue({text: async () => calendarHtml} as any as HTTPObj);
  return park;
}

const rawOf = (element: object) => (element as WithRaw<object>).raw;

describe('Parcs Reunidos raw upstream pieces', () => {
  beforeEach(() => CacheLib.clear());

  afterEach(() => {
    vi.restoreAllMocks();
    CacheLib.clear();
  });

  it('attaches the attraction entry to each live row', async () => {
    const live = await stubbedPark(true).getLiveData();
    expect(live.map((l) => l.id)).toEqual(['101', '102']);

    expect(rawOf(live[0])).toEqual({attractions: rideAttraction});
    expect(rawOf(live[0])!.attractions).toBe(rideAttraction);
    expect(live[0].queue).toEqual({STANDBY: {waitTime: 20}});

    expect(live[1].status).toBe('CLOSED');
    expect(rawOf(live[1])!.attractions).toBe(closedAttraction);
  });

  it('attaches the attraction entry to each attraction and the establishment to park and destination', async () => {
    const entities = await stubbedPark(true).getEntities();
    expect(entities.map((e) => e.id)).toEqual([
      'parquesreunidos_mpg', 'parquesreunidos_mpg_park', '101', '102',
    ]);

    expect(rawOf(entities[0])).toEqual({establishment});
    expect(rawOf(entities[0])!.establishment).toBe(establishment);
    expect(rawOf(entities[1])).toEqual({establishment});
    expect(entities[1].name).toBe('Movie Park Germany');

    expect(rawOf(entities[2])).toEqual({attractions: rideAttraction});
    expect(rawOf(entities[2])!.attractions).toBe(rideAttraction);
    expect(entities[2].name).toBe('Bandit');
    expect(rawOf(entities[3])!.attractions).toBe(closedAttraction);
  });

  it('attaches the day, its label key and the label text to each schedule entry', async () => {
    const [schedule] = await stubbedPark(true).getSchedules();
    expect(schedule.schedule.map((e) => `${e.date} ${e.type}`)).toEqual([
      '2026-09-20 OPERATING', '2026-09-21 OPERATING', '2026-09-21 INFO',
    ]);

    const [single, first, second] = schedule.schedule;
    expect(single.openingTime).toBe('2026-09-20T10:00:00+02:00');
    expect(single.closingTime).toBe('2026-09-20T17:00:00+02:00');
    expect(rawOf(single)).toEqual({calendarHTML: {day: '20', label: 'A', timeLabel: '10am - 5pm'}});

    // Two sessions on one day: each entry carries the label it was built from
    expect(rawOf(first)).toEqual({calendarHTML: {day: '21', label: 'A', timeLabel: '10am - 5pm'}});
    expect(rawOf(second)).toEqual({
      calendarHTML: {day: '21', label: 'B', timeLabel: 'Halloween Horror Festival - 7pm - 11pm'},
    });
    expect(second.openingTime).toBe('2026-09-21T19:00:00+02:00');
  });

  it('carries nothing when includeRaw is off', async () => {
    const park = stubbedPark(false);
    for (const element of await park.getLiveData()) expect(rawOf(element)).toBeUndefined();
    for (const element of await park.getEntities()) expect(rawOf(element)).toBeUndefined();
    for (const element of (await park.getSchedules())[0].schedule) expect(rawOf(element)).toBeUndefined();
  });
});

describe('Mirabilandia raw upstream pieces', () => {
  const KATUN = '126283';
  const OIL_TOWER_1 = '126289';
  const OIL_TOWER_2 = '126287';

  const katunItem = {closed: 0, wait_time: 10};
  const oilTowerItem = {closed: 0, wait_time: 15};

  function parkWithFeed(includeRaw: boolean, info: Record<string, unknown>): Mirabilandia {
    const park = new Mirabilandia();
    park.includeRaw = includeRaw;
    park.waitTimesUrl = 'https://feed.example/codeattr';
    vi.spyOn(park as any, 'fetchWaitTimesInfo').mockResolvedValue({json: async () => info} as any as HTTPObj);
    vi.spyOn(park as any, 'fetchWaitTimes').mockResolvedValue({
      json: async () => ({timestamp: '2026-09-21 10:54:14', attrazioni: {katun: katunItem, oil_tower: oilTowerItem}}),
    } as any as HTTPObj);
    return park;
  }

  beforeEach(() => CacheLib.clear());

  afterEach(() => {
    vi.restoreAllMocks();
    CacheLib.clear();
  });

  it('attaches the attraction entry and the park-level flag to each row', async () => {
    const info = {isopen: true};
    const live = await parkWithFeed(true, info).getLiveData();
    expect(live.map((l) => l.id)).toEqual([KATUN, OIL_TOWER_1, OIL_TOWER_2]);

    expect(rawOf(live[0])).toEqual({waitTimes: katunItem, waitTimesInfo: info});
    expect(rawOf(live[0])!.waitTimes).toBe(katunItem);
    expect(rawOf(live[0])!.waitTimesInfo).toBe(info);
    expect(live[0].queue).toEqual({STANDBY: {waitTime: 10}});

    // One feed entry, two entities: the same piece on both
    expect(rawOf(live[1])!.waitTimes).toBe(oilTowerItem);
    expect(rawOf(live[2])!.waitTimes).toBe(oilTowerItem);
  });

  it('keeps the flag that closed the park on the rows it closed', async () => {
    const info = {isopen: false};
    const live = await parkWithFeed(true, info).getLiveData();

    expect(live[0].status).toBe('CLOSED');
    expect(rawOf(live[0])).toEqual({waitTimes: katunItem, waitTimesInfo: info});
    expect(rawOf(live[0])!.waitTimesInfo).toBe(info);
  });

  it('carries nothing when includeRaw is off', async () => {
    const live = await parkWithFeed(false, {isopen: true}).getLiveData();
    for (const element of live) expect(rawOf(element)).toBeUndefined();
  });
});
