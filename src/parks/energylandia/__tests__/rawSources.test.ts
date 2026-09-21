import {describe, it, expect, vi, beforeEach, afterEach} from 'vitest';
import {Energylandia} from '../energylandia.js';
import {CacheLib} from '../../../cache.js';
import type {WithRaw} from '../../../destination.js';
import type {HTTPObj} from '../../../http.js';

/**
 * With `includeRaw` on, every live row carries the Firestore document it was
 * built from and the calendar period that decided whether the park counts as
 * open, a ride with a counter reading adds its feed row, and every schedule day
 * carries its period — the same object on each day the period covers. Entities
 * carry their document. The destination and the park come from constants and
 * carry nothing. Off, nothing carries anything.
 */
// 12:00 in Europe/Warsaw on a Monday, inside the park's 10:00-20:00 window
const NOW = new Date('2026-09-21T10:00:00Z');

const str = (v: string) => ({stringValue: v});
const int = (v: number) => ({integerValue: String(v)});
const bool = (v: boolean) => ({booleanValue: v});
const nameMap = (m: Record<string, string>) => ({
  mapValue: {fields: Object.fromEntries(Object.entries(m).map(([k, v]) => [k, {stringValue: v}]))},
});
const doc = (id: string, fields: Record<string, any>) => ({
  name: `projects/p/databases/(default)/documents/attractions/${id}`,
  fields,
});
const showDoc = (id: string, fields: Record<string, any>) => ({
  name: `projects/p/databases/(default)/documents/shows/${id}`,
  fields,
});
const timetable = (days: Record<string, Array<{time: string; venue?: string}>>) => ({
  mapValue: {
    fields: Object.fromEntries(Object.entries(days).map(([day, slots]) => [day, {
      arrayValue: {
        values: slots.map((s) => ({
          mapValue: {
            fields: {
              time: str(s.time),
              timeEnd: {nullValue: null},
              ...(s.venue !== undefined ? {attractionId: str(s.venue)} : {}),
            },
          },
        })),
      },
    }])),
  },
});

const hyperionDoc = doc('a1', {
  active: bool(true), type: str('attraction'), open: bool(true),
  name: nameMap({PL: '141. Pepsi Hyperion'}), queueTimeId: int(222),
});
const noCounterDoc = doc('a2', {
  active: bool(true), type: str('attraction'), open: bool(true),
  name: nameMap({PL: '99. Bez Licznika'}), queueTimeId: str(''),
});
const shutRideDoc = doc('a3', {
  active: bool(true), type: str('attraction'), open: bool(false),
  name: nameMap({PL: '12. Zamknieta'}), queueTimeId: int(300),
});
const pizzeriaDoc = doc('r1', {
  active: bool(true), type: str('restaurant'), open: bool(true),
  name: nameMap({PL: 'Pizzeria'}),
});

const fireShowDoc = showDoc('s1', {
  active: bool(true), duration: str('15'),
  name: nameMap({EN: 'Fire Show'}),
  timetable: timetable({monday: [{time: '14:00', venue: 'a1'}]}),
});
const weekendShowDoc = showDoc('s2', {
  active: bool(true), duration: str('20'),
  name: nameMap({EN: 'Weekend Only Show'}),
  timetable: timetable({saturday: [{time: '15:00', venue: 'a1'}]}),
});

// Rows of the standalone wait-time feed, with its Polish field names
const hyperionRow = {ID_ATRAKCJI: 222, ATRAKCJA: '141 PEPSI HYPERION', CZAS_OCZEKIWANIA: 20};
const shutRideRow = {ID_ATRAKCJI: 300, ATRAKCJA: '12 ZAMKNIETA', CZAS_OCZEKIWANIA: 15};
const counterOnlyRow = {ID_ATRAKCJI: 909, ATRAKCJA: 'MAIN TRAIN WINDY', CZAS_OCZEKIWANIA: 5};

const openPeriod = {openFrom: '10:00', openTo: '20:00', days: ['2026-09-21', '2026-09-22']};
const autumnPeriod = {openFrom: '11:00', openTo: '18:00', days: ['2026-10-03']};

/**
 * Instance config rather than assignment after construction: @config lets
 * ENERGYLANDIA_* in the environment outrank a plain property write, which would
 * point the wait-time feed at the park's real host.
 */
const BLANK_CONFIG = {
  apiKey: '', projectId: '', waitTimesUrl: '',
  proximiioBaseUrl: '', proximiioToken: '',
};

function stubbedPark(includeRaw: boolean): Energylandia {
  const park = new Energylandia({config: {...BLANK_CONFIG, waitTimesUrl: 'https://feed.example/'}});
  park.includeRaw = includeRaw;
  vi.spyOn(park as any, 'getAttractionDocs').mockResolvedValue([
    hyperionDoc, noCounterDoc, shutRideDoc, pizzeriaDoc,
  ]);
  vi.spyOn(park as any, 'getShowDocs').mockResolvedValue([fireShowDoc, weekendShowDoc]);
  vi.spyOn(park as any, 'getCalendarPeriods').mockResolvedValue([openPeriod, autumnPeriod]);
  vi.spyOn(park as any, 'fetchWaitTimes').mockResolvedValue({
    text: async () => JSON.stringify([hyperionRow, shutRideRow, counterOnlyRow]),
  } as any as HTTPObj);
  return park;
}

const rawOf = (element: object) => (element as WithRaw<object>).raw;

describe('Energylandia raw upstream pieces', () => {
  beforeEach(() => {
    CacheLib.clear({includePersistent: true});
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    CacheLib.clear({includePersistent: true});
  });

  it('attaches the document, the period and the feed row to each live ride', async () => {
    const live = await stubbedPark(true).getLiveData();
    expect(live.map((l) => l.id).slice(0, 3)).toEqual([
      'energylandia-a1', 'energylandia-a2', 'energylandia-a3',
    ]);

    expect(live[0].queue).toEqual({STANDBY: {waitTime: 20}});
    expect(rawOf(live[0])).toEqual({
      attractions: hyperionDoc, calendarPeriods: openPeriod, waitTimes: hyperionRow,
    });
    expect(rawOf(live[0])!.attractions).toBe(hyperionDoc);
    expect(rawOf(live[0])!.calendarPeriods).toBe(openPeriod);
    // The feed arrives as text and is parsed here, so its row is the object
    // that parse produced rather than the fixture object itself.
    expect(rawOf(live[0])!.waitTimes).toEqual(hyperionRow);

    // No counter to read, so the feed contributed nothing to this row.
    expect(live[1].status).toBe('OPERATING');
    expect(live[1].queue).toBeUndefined();
    expect(rawOf(live[1])).toEqual({attractions: noCounterDoc, calendarPeriods: openPeriod});

    // The CMS flag closed this ride, so the reading still sitting in the feed
    // is not behind any of its values.
    expect(live[2].status).toBe('CLOSED');
    expect(rawOf(live[2])).toEqual({attractions: shutRideDoc, calendarPeriods: openPeriod});
  });

  it('attaches the show document and the period to each live show', async () => {
    const live = await stubbedPark(true).getLiveData();
    const shows = live.filter((l) => l.id.startsWith('energylandia-show-'));
    expect(shows.map((l) => l.id)).toEqual(['energylandia-show-s1', 'energylandia-show-s2']);

    expect(shows[0].status).toBe('OPERATING');
    expect(shows[0].showtimes).toHaveLength(1);
    expect(shows[0].showtimes![0].startTime).toBe('2026-09-21T14:00:00+02:00');
    expect(rawOf(shows[0])).toEqual({shows: fireShowDoc, calendarPeriods: openPeriod});
    expect(rawOf(shows[0])!.shows).toBe(fireShowDoc);

    // Nothing on a Monday, but the document and the day are still what said so.
    expect(shows[1].status).toBe('CLOSED');
    expect(rawOf(shows[1])).toEqual({shows: weekendShowDoc, calendarPeriods: openPeriod});
  });

  it('attaches the document to each entity, nothing to the park or the destination', async () => {
    const entities = await stubbedPark(true).getEntities();
    const byId = new Map(entities.map((e) => [e.id, e]));

    const hyperion = byId.get('energylandia-a1')!;
    expect(hyperion.name).toBe('Pepsi Hyperion');
    expect(rawOf(hyperion)).toEqual({attractions: hyperionDoc});
    expect(rawOf(hyperion)!.attractions).toBe(hyperionDoc);

    const pizzeria = byId.get('energylandia-r1')!;
    expect(pizzeria.entityType).toBe('RESTAURANT');
    expect(rawOf(pizzeria)!.attractions).toBe(pizzeriaDoc);

    const fireShow = byId.get('energylandia-show-s1')!;
    expect(fireShow.entityType).toBe('SHOW');
    expect(rawOf(fireShow)).toEqual({shows: fireShowDoc});
    expect(rawOf(fireShow)!.shows).toBe(fireShowDoc);

    for (const id of ['energylandia', 'energylandia-park']) {
      expect(rawOf(byId.get(id)!)).toBeUndefined();
    }
  });

  it('attaches the period to every day it covers, as the same object', async () => {
    const [schedule] = await stubbedPark(true).getSchedules();
    expect(schedule.schedule.map((d) => d.date)).toEqual(['2026-09-21', '2026-09-22', '2026-10-03']);

    const [first, second, autumn] = schedule.schedule;
    expect(first.openingTime).toBe('2026-09-21T10:00:00+02:00');
    expect(rawOf(first)).toEqual({calendarPeriods: openPeriod});
    expect(rawOf(first)!.calendarPeriods).toBe(openPeriod);
    expect(rawOf(second)!.calendarPeriods).toBe(openPeriod);

    expect(autumn.closingTime).toBe('2026-10-03T18:00:00+02:00');
    expect(rawOf(autumn)!.calendarPeriods).toBe(autumnPeriod);
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
