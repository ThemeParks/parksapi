import {describe, test, expect, vi, beforeEach, afterEach} from 'vitest';
import {Efteling} from '../efteling.js';
import type {WithRaw} from '../../../destination.js';

/**
 * With `includeRaw` on, every element carries the upstream piece it was built
 * from: the WIS row for live data — a list of the parent row and the
 * single-rider row where both fed the same element — the POI entry of each
 * language response for an entity, and the calendar day for every entry of that
 * day. The destination and the park are built from literals and carry nothing.
 * Off, nothing carries anything.
 */
const NOW = new Date('2026-07-08T10:00:00Z');

const englishPython = {
  id: 'python',
  category: 'attraction',
  latlon: '51.65,5.05',
  name: 'Python',
  alternatetype: 'singlerider',
  alternateid: 'pythonsinglerider',
  properties: ['minimum120', 'wet'],
};
const dutchPython = {id: 'python', category: 'attraction', latlon: '51.65,5.05', name: 'Python'};

const englishCarnaval = {id: 'carnaval', category: 'attraction', latlon: '51.65,5.08', name: 'Carnaval Festival'};
const dutchCarnaval = {id: 'carnaval', category: 'attraction', latlon: '51.65,5.08', name: 'Carnaval Festival'};

const englishShow = {id: 'raveleijn', category: 'show', latlon: '51.65,5.06', name: 'Raveleijn'};
const dutchShow = {id: 'raveleijn', category: 'show', latlon: '51.65,5.06', name: 'Raveleijn'};

// English only, so the entity built from it carries a single language key.
const englishDiner = {id: 'polles', category: 'restaurant', latlon: '51.65,5.07', name: "Polles Keuken"};

const englishHits = [
  {fields: englishPython},
  {fields: englishCarnaval},
  {fields: englishShow},
  {fields: englishDiner},
];
const dutchHits = [{fields: dutchPython}, {fields: dutchCarnaval}, {fields: dutchShow}];

const pythonRow = {Id: 'python', Type: 'Attracties', State: 'open', WaitingTime: 25};
const pythonSingleRiderRow = {Id: 'pythonsinglerider', Type: 'Attracties', State: 'open', WaitingTime: 5};
const carnavalRow = {Id: 'carnaval', Type: 'Attracties', State: 'open', WaitingTime: 30};
const showRow = {
  Id: 'raveleijn',
  Type: 'Shows en Entertainment',
  State: 'open',
  ShowTimes: [{StartDateTime: '2026-07-08T14:00:00', EndDateTime: '2026-07-08T14:30:00', Edition: 'Showtime'}],
};
const dinerRow = {
  Id: 'polles',
  Type: 'Eten en Drinken',
  State: 'open',
  OpeningTimes: [{HourFrom: '2026-07-08T10:00:00', HourTo: '2026-07-08T20:00:00'}],
};

const waitTimes = [pythonRow, pythonSingleRiderRow, carnavalRow, showRow, dinerRow];

// One day the park opens twice: a regular window and an evening window.
const calendarDay = {
  Date: '2026-07-08',
  OpeningHours: [{Open: '10:00', Close: '18:00'}, {Open: '19:00', Close: '23:00'}],
};

function stubbedPark(includeRaw: boolean): Efteling {
  const park = new Efteling();
  park.includeRaw = includeRaw;
  vi.spyOn(park as any, 'getPOIData').mockImplementation(
    async (language: unknown) => (language === 'nl' ? dutchHits : englishHits),
  );
  vi.spyOn(park as any, 'getWaitTimes').mockResolvedValue(waitTimes);
  vi.spyOn(park as any, 'getCalendar').mockImplementation(
    async (year: unknown, month: unknown) => (year === 2026 && month === 7 ? [calendarDay] : []),
  );
  return park;
}

const rawOf = (element: object) => (element as WithRaw<object>).raw;

describe('Efteling raw upstream pieces', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  test('attaches the WIS row to each live element, both rows where a single rider fed it', async () => {
    const live = await stubbedPark(true).getLiveData();
    expect(live.map((l) => l.id)).toEqual(['python', 'carnaval', 'raveleijn', 'polles']);

    // Parent row and single-rider row are two rows of the one response.
    expect(rawOf(live[0])).toEqual({waitTimes: [pythonRow, pythonSingleRiderRow]});
    expect((rawOf(live[0])!.waitTimes as unknown[])[0]).toBe(pythonRow);
    expect((rawOf(live[0])!.waitTimes as unknown[])[1]).toBe(pythonSingleRiderRow);
    expect(live[0].queue).toEqual({STANDBY: {waitTime: 25}, SINGLE_RIDER: {waitTime: 5}});

    // A ride without a single-rider alternate carries the one row, not a list.
    expect(rawOf(live[1])).toEqual({waitTimes: carnavalRow});
    expect(rawOf(live[1])!.waitTimes).toBe(carnavalRow);
    expect(live[1].queue).toEqual({STANDBY: {waitTime: 30}});

    expect(rawOf(live[2])).toEqual({waitTimes: showRow});
    expect(rawOf(live[2])!.waitTimes).toBe(showRow);
    expect(live[2].showtimes).toHaveLength(1);

    expect(rawOf(live[3])).toEqual({waitTimes: dinerRow});
    expect(rawOf(live[3])!.waitTimes).toBe(dinerRow);
    expect(live[3].operatingHours).toHaveLength(1);
  });

  test('attaches the POI entry of each language response to an entity', async () => {
    const entities = await stubbedPark(true).getEntities();
    expect(entities.map((e) => e.id)).toEqual([
      'eftelingresort', 'efteling', 'python', 'carnaval', 'raveleijn', 'polles',
    ]);

    // Destination and park are literals, so there is nothing to attach.
    expect(rawOf(entities[0])).toBeUndefined();
    expect(rawOf(entities[1])).toBeUndefined();

    expect(rawOf(entities[2])).toEqual({poiEnglish: englishPython, poiDutch: dutchPython});
    expect(rawOf(entities[2])!.poiEnglish).toBe(englishPython);
    expect(rawOf(entities[2])!.poiDutch).toBe(dutchPython);
    expect(entities[2].name).toEqual({en: 'Python', nl: 'Python'});

    expect(rawOf(entities[4])!.poiEnglish).toBe(englishShow);
    expect(rawOf(entities[4])!.poiDutch).toBe(dutchShow);

    // Only the English response lists this one, so only that key is there.
    expect(rawOf(entities[5])).toEqual({poiEnglish: englishDiner});
    expect(rawOf(entities[5])!.poiEnglish).toBe(englishDiner);
    expect(entities[5].location).toEqual({latitude: 51.65, longitude: 5.07});
  });

  test('attaches the calendar day to both entries of a day that opens twice', async () => {
    const [schedule] = await stubbedPark(true).getSchedules();
    expect(schedule.schedule.map((e) => e.type)).toEqual(['OPERATING', 'INFO']);

    expect(rawOf(schedule.schedule[0])).toEqual({calendar: calendarDay});
    expect(rawOf(schedule.schedule[0])!.calendar).toBe(calendarDay);
    expect(rawOf(schedule.schedule[1])!.calendar).toBe(calendarDay);
    expect(schedule.schedule[0].openingTime).toBe('2026-07-08T10:00:00+02:00');
    expect(schedule.schedule[1].openingTime).toBe('2026-07-08T19:00:00+02:00');
  });

  test('carries nothing when includeRaw is off', async () => {
    const park = stubbedPark(false);
    for (const element of await park.getLiveData()) expect(rawOf(element)).toBeUndefined();
    for (const element of await park.getEntities()) expect(rawOf(element)).toBeUndefined();
    for (const element of (await park.getSchedules())[0].schedule) expect(rawOf(element)).toBeUndefined();
  });
});
