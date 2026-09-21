import {describe, it, expect, vi, beforeEach, afterEach} from 'vitest';
import {ParcAsterix} from '../parcasterix.js';
import {CacheLib} from '../../../cache.js';
import type {WithRaw} from '../../../destination.js';

/**
 * With `includeRaw` on, a live row carries the `paxLatencies` entry it was
 * observed in, a show row the `paxSchedules` entry, and a row named by both
 * bills carries both. A show closed because the bill does not name it has no
 * piece at all. Every entity carries its POI entry from the offline package,
 * and every calendar day the package's calendar row together with the legend
 * row its hours were read from — the same pair on both sessions of a day.
 * Off, nothing carries anything.
 */
// 14:00 in Europe/Paris, inside the park's 10:00-18:00 day
const NOW = new Date('2026-09-21T12:00:00Z');

const latencyOpen = {drupalId: '31313', latency: 30, isOpen: true, message: null, openingTime: '10:00', closingTime: '18:00'};
const latencyClosed = {drupalId: '31314', latency: null, isOpen: false, message: null, openingTime: null, closingTime: null};
// Named by both bills: a ride that also publishes performances
const latencyBoth = {drupalId: '31600', latency: 5, isOpen: true, message: null, openingTime: '10:00', closingTime: '18:00'};

const showSchedule = {drupalId: '31483', times: [{at: '14:00', startAt: null, endAt: null}]};
const bothSchedule = {drupalId: '31600', times: [{at: '15:30', startAt: null, endAt: null}]};

const attractionPoi = {drupal_id: 31313, title: 'Tonnerre 2 Zeus', titles: {en: 'Tonnerre 2 Zeus'}, latitude: 49.1361, longitude: 2.5721, min_size: 120, _type: 'attraction'};
const secondAttractionPoi = {drupal_id: 31314, title: 'Goudurix', titles: {en: 'Goudurix'}, latitude: 49.1352, longitude: 2.5739, _type: 'attraction'};
const restaurantPoi = {drupal_id: 40001, title: 'Le Restaurant du Lac', titles: {en: 'Le Restaurant du Lac'}, latitude: 49.1372, longitude: 2.5733, _type: 'restaurant'};
const showPoi = {drupal_id: 31483, title: 'Les Espions de Cesar', titles: {en: 'Les Espions de Cesar'}, latitude: 49.1368, longitude: 2.5744, _type: 'show'};
// A show the bill does not name: closed by inference, with nothing behind it
const darkShowPoi = {drupal_id: 31513, title: 'Main Basse sur la Joconde', titles: {en: 'Main Basse sur la Joconde'}, latitude: 49.1359, longitude: 2.5750, _type: 'show'};

const calendarItems = [
  {day: '2026-09-21 00:00:00', type: 'A'},
  {day: '2026-09-22 00:00:00', type: 'J'},
];
const labels = [
  {key: 'calendar.dateType.legend.A', value: '10:00 a.m. to 6:00 p.m.'},
  {key: 'calendar.dateType.legend.J', value: 'Daytime 9:00 a.m. - 6:00 p.m. and Evening 7:00 p.m. - 1:00 a.m. Peur sur le Parc'},
];

/** The calendar as the offline package's own parse produces it. */
function calendarOf(park: ParcAsterix): Array<Record<string, unknown>> {
  const {hoursMap, closedTypes, labelByType} = (park as any).parseCalendarLabels(labels);
  return (park as any).buildCalendarEntries(calendarItems, hoursMap, closedTypes, labelByType).entries;
}

function stubbedPark(includeRaw: boolean): ParcAsterix {
  const park = new ParcAsterix();
  park.includeRaw = includeRaw;
  vi.spyOn(park as any, 'getPolling').mockResolvedValue({
    latencies: [latencyOpen, latencyClosed, latencyBoth],
    schedules: [showSchedule, bothSchedule],
  });
  vi.spyOn(park as any, 'getPOIData').mockImplementation(async () => ({
    poi: [attractionPoi, secondAttractionPoi, restaurantPoi, showPoi, darkShowPoi],
    calendar: calendarOf(park),
    closedDates: [],
  }));
  return park;
}

const rawOf = (element: object) => (element as WithRaw<object>).raw;

describe('Parc Asterix raw upstream pieces', () => {
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

  it('attaches the bill each live row came from, both bills where they meet, and nothing to a dark show', async () => {
    const live = await stubbedPark(true).getLiveData();
    expect(live.map((l) => l.id)).toEqual(['31313', '31314', '31600', '31483', '31513']);

    expect(rawOf(live[0])).toEqual({pollingLatencies: latencyOpen});
    expect(rawOf(live[0])!.pollingLatencies).toBe(latencyOpen);
    expect(live[0].queue).toEqual({STANDBY: {waitTime: 30}});

    expect(live[1].status).toBe('CLOSED');
    expect(rawOf(live[1])!.pollingLatencies).toBe(latencyClosed);

    // One row named by both lists of the one poll
    expect(rawOf(live[2])).toEqual({pollingLatencies: latencyBoth, pollingSchedules: bothSchedule});
    expect(rawOf(live[2])!.pollingSchedules).toBe(bothSchedule);

    expect(rawOf(live[3])).toEqual({pollingSchedules: showSchedule});
    expect(live[3].showtimes).toHaveLength(1);

    // Closed because the bill does not name it: no piece says so
    expect(live[4].status).toBe('CLOSED');
    expect(rawOf(live[4])).toBeUndefined();
  });

  it('attaches the POI entry to each entity, nothing to the park or the destination', async () => {
    const entities = await stubbedPark(true).getEntities();
    expect(entities.map((e) => e.id)).toEqual([
      'parcasterix', 'parcasterixpark', '31313', '31314', '40001', '31483', '31513',
    ]);

    expect(rawOf(entities[0])).toBeUndefined();
    expect(rawOf(entities[1])).toBeUndefined();

    expect(rawOf(entities[2])).toEqual({packageZip: attractionPoi});
    expect(rawOf(entities[2])!.packageZip).toBe(attractionPoi);
    expect(entities[2].name).toBe('Tonnerre 2 Zeus');
    expect(rawOf(entities[4])!.packageZip).toBe(restaurantPoi);
    expect(rawOf(entities[5])!.packageZip).toBe(showPoi);
  });

  it('attaches the calendar row and its legend to every day, the same pair on both sessions', async () => {
    const park = stubbedPark(true);
    const [schedule] = await park.getSchedules();
    expect(schedule.schedule.map((e) => `${e.date} ${e.type}`)).toEqual([
      '2026-09-21 OPERATING', '2026-09-22 OPERATING', '2026-09-22 TICKETED_EVENT',
    ]);

    const [today, daytime, evening] = schedule.schedule;
    expect(today.openingTime).toBe('2026-09-21T10:00:00+02:00');
    expect(today.closingTime).toBe('2026-09-21T18:00:00+02:00');
    expect(rawOf(today)).toEqual({packageZip: [calendarItems[0], labels[0]]});
    const pair = rawOf(today)!.packageZip as unknown[];
    expect(pair[0]).toBe(calendarItems[0]);
    expect(pair[1]).toBe(labels[0]);

    // One calendar row, two sessions: the same pair on both
    expect(rawOf(daytime)).toEqual({packageZip: [calendarItems[1], labels[1]]});
    expect(rawOf(evening)!.packageZip).toBe(rawOf(daytime)!.packageZip);
    expect(evening.openingTime).toBe('2026-09-22T19:00:00+02:00');
  });

  it('carries nothing when includeRaw is off', async () => {
    const park = stubbedPark(false);
    for (const element of await park.getLiveData()) expect(rawOf(element)).toBeUndefined();
    for (const element of await park.getEntities()) expect(rawOf(element)).toBeUndefined();
    for (const element of (await park.getSchedules())[0].schedule) expect(rawOf(element)).toBeUndefined();
  });
});
