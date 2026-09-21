import {describe, it, expect, vi, beforeEach, afterEach} from 'vitest';
import {Liseberg} from '../liseberg.js';
import type {WithRaw} from '../../../destination.js';

/**
 * With `includeRaw` on, every element carries the upstream piece it was
 * built from: the attraction entry for an entity and a live row, and the
 * calendar day for a schedule entry, the same day on both its OPERATING and
 * its evening-hours INFO entry. Off, nothing carries anything.
 */
const NOW = new Date('2026-09-21T10:00:00Z');

const helix = {id: 501, title: 'Helix', type: 'attraction', coordinates: {latitude: 57.6942, longitude: 11.9932}, state: {isOpen: true, maxWaitTime: 20}};
const balder = {id: 502, title: 'Balder', type: 'attraction', coordinates: {latitude: 57.6945, longitude: 11.9945}, state: {isOpen: false, maxWaitTime: null}};
const cafe = {id: 601, title: 'Cafe', type: 'restaurant', coordinates: {latitude: 57.694, longitude: 11.993}};

const dayWithEvening = {dateRaw: '2026-09-21T00:00:00', closed: false, openingHoursDetailed: {from: 11, to: 22}, eveningEntranceFrom: '18:00'};
const dayWithoutEvening = {dateRaw: '2026-09-22T00:00:00', closed: false, openingHoursDetailed: {from: 11, to: 23}, eveningEntranceFrom: '0'};
const closedDay = {dateRaw: '2026-09-23T00:00:00', closed: true};

function stubbedPark(includeRaw: boolean): Liseberg {
  const park = new Liseberg();
  park.includeRaw = includeRaw;
  vi.spyOn(park as any, 'getAttractions').mockResolvedValue([helix, balder, cafe]);
  vi.spyOn(park as any, 'getCalendar').mockImplementation(async (startDate: unknown) =>
    startDate === '2026-09-21' ? [dayWithEvening, dayWithoutEvening, closedDay] : [],
  );
  return park;
}

const rawOf = (element: object) => (element as WithRaw<object>).raw;

describe('Liseberg raw upstream pieces', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('attaches the attraction entry to each live row', async () => {
    const live = await stubbedPark(true).getLiveData();
    expect(live.map((l) => l.id)).toEqual(['501', '502']);

    expect(rawOf(live[0])).toEqual({attractions: helix});
    expect(rawOf(live[0])!.attractions).toBe(helix);
    expect(live[0].queue).toEqual({STANDBY: {waitTime: 20}});

    expect(live[1]).toMatchObject({status: 'CLOSED'});
    expect(rawOf(live[1])!.attractions).toBe(balder);
  });

  it('attaches the attraction entry to each entity, nothing to the park', async () => {
    const entities = await stubbedPark(true).getEntities();
    expect(entities.map((e) => e.id)).toEqual(['liseberg', 'lisebergpark', '501', '502']);

    expect(rawOf(entities[0])).toBeUndefined();
    expect(rawOf(entities[1])).toBeUndefined();

    expect(rawOf(entities[2])).toEqual({attractions: helix});
    expect(rawOf(entities[2])!.attractions).toBe(helix);
    expect(entities[2].location).toEqual({latitude: 57.6942, longitude: 11.9932});

    expect(rawOf(entities[3])).toEqual({attractions: balder});
  });

  it('attaches the same calendar day to the OPERATING entry and its evening-hours INFO entry', async () => {
    const [schedule] = await stubbedPark(true).getSchedules();
    expect(schedule.schedule!.map((e) => ({date: e.date, type: e.type}))).toEqual([
      {date: '2026-09-21', type: 'OPERATING'},
      {date: '2026-09-21', type: 'INFO'},
      {date: '2026-09-22', type: 'OPERATING'},
    ]);

    const [operating, evening, nextDay] = schedule.schedule!;
    expect(rawOf(operating)).toEqual({calendar: dayWithEvening});
    expect(rawOf(evening)).toEqual({calendar: dayWithEvening});
    expect(rawOf(operating)!.calendar).toBe(rawOf(evening)!.calendar);
    expect(operating.closingTime).toBe('2026-09-21T22:00:00+02:00');
    expect(evening.openingTime).toBe('2026-09-21T18:00:00+02:00');

    expect(rawOf(nextDay)).toEqual({calendar: dayWithoutEvening});
    expect(nextDay.closingTime).toBe('2026-09-22T23:00:00+02:00');
  });

  it('carries nothing when includeRaw is off', async () => {
    const park = stubbedPark(false);
    for (const element of await park.getLiveData()) expect(rawOf(element)).toBeUndefined();
    for (const element of await park.getEntities()) expect(rawOf(element)).toBeUndefined();
    for (const element of (await park.getSchedules())[0].schedule!) expect(rawOf(element)).toBeUndefined();
  });
});
