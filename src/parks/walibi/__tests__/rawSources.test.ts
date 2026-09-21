import {describe, it, expect, vi, afterEach} from 'vitest';
import {WalibiBelgium} from '../walibi.js';
import type {WithRaw} from '../../../destination.js';
import type {HTTPObj} from '../../../http.js';

/**
 * With `includeRaw` on, every element carries the upstream piece it was
 * built from: the attraction or restaurant row for its entity, the
 * wait-time row for a live row, and the calendar day for a schedule day.
 * Off, nothing carries anything.
 */
const kondaa = {
  title: 'KONDAA',
  waitingTimeName: '45',
  latitude: 50.7015,
  longitude: 4.5905,
  path: '/content/dam/wbe/fr/attractions/kondaa',
};

const loupGarou = {
  title: 'Loup Garou',
  waitingTimeName: '99',
  path: '/content/dam/wbe/fr/attractions/loup-garou',
};

/** No waitingTimeName at all — falls back to a path-keyed id. */
const petitBateau = {
  title: 'Petit Bateau',
  path: '/content/dam/wbe/fr/attractions/petit-bateau',
};

const attractions = [kondaa, loupGarou, petitBateau];

const saloon = {
  title: 'Saloon',
  latitude: 50.7,
  longitude: 4.59,
  path: '/content/dam/wbe/fr/dining/saloon',
};

const restaurants = [saloon];

const waitEntryOpen = {id: '45', status: 'open', time: 300};
const waitEntryDown = {id: '99', status: 'Down'};
const waitTimes = [waitEntryOpen, waitEntryDown];

const day21 = {dayNumber: 21, openingHour: '10:00', closingHour: '18:00', closed: false, soldOut: false, customOpeningHourToDisplay: ''};
const day22 = {dayNumber: 22, openingHour: '10:00', closingHour: '19:00', closed: false, soldOut: false};
const calData = {calendar: {2026: {months: {9: {monthNumber: 9, days: {21: day21, 22: day22}}}}}};

function stubbedPark(includeRaw: boolean): WalibiBelgium {
  const park = new WalibiBelgium();
  park.includeRaw = includeRaw;
  vi.spyOn(park as any, 'getAttractions').mockResolvedValue(attractions);
  vi.spyOn(park as any, 'getRestaurants').mockResolvedValue(restaurants);
  vi.spyOn(park as any, 'getWaitTimes').mockResolvedValue(waitTimes);
  park.fetchCalendar = (async () => ({json: async () => calData}) as any as HTTPObj) as any;
  return park;
}

const rawOf = (element: object) => (element as WithRaw<object>).raw;

describe('WalibiBelgium raw upstream pieces', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('attaches the wait-time row to each live row', async () => {
    const live = await stubbedPark(true).getLiveData();
    expect(live.map((l) => l.id)).toEqual(['45', '99']);

    expect(rawOf(live[0])).toEqual({waitTimes: waitEntryOpen});
    expect(rawOf(live[0])!.waitTimes).toBe(waitEntryOpen);
    expect(live[0].queue).toEqual({STANDBY: {waitTime: 5}});

    expect(live[1].status).toBe('DOWN');
    expect(rawOf(live[1])).toEqual({waitTimes: waitEntryDown});
    expect(rawOf(live[1])!.waitTimes).toBe(waitEntryDown);
    expect(live[1].queue).toBeUndefined();
  });

  it('attaches the attraction or restaurant row to each entity, nothing to the destination or park', async () => {
    const entities = await stubbedPark(true).getEntities();
    expect(entities.map((e) => e.id)).toEqual([
      'walibibelgium', 'walibibelgiumpark', '45', '99', 'attr_petit-bateau', 'dining_saloon',
    ]);

    expect(rawOf(entities[0])).toBeUndefined();
    expect(rawOf(entities[1])).toBeUndefined();

    expect(rawOf(entities[2])).toEqual({attractions: kondaa});
    expect(rawOf(entities[2])!.attractions).toBe(kondaa);

    expect(rawOf(entities[3])).toEqual({attractions: loupGarou});

    expect(rawOf(entities[4])).toEqual({attractions: petitBateau});
    expect(rawOf(entities[4])!.attractions).toBe(petitBateau);

    expect(rawOf(entities[5])).toEqual({restaurants: saloon});
    expect(rawOf(entities[5])!.restaurants).toBe(saloon);
  });

  it('attaches the calendar day to each schedule day', async () => {
    const [parkSchedule] = await stubbedPark(true).getSchedules();
    expect(parkSchedule.id).toBe('walibibelgiumpark');
    expect(parkSchedule.schedule.map((e) => e.date)).toEqual(['2026-09-21', '2026-09-22']);

    expect(rawOf(parkSchedule.schedule[0])).toEqual({calendar: day21});
    expect(rawOf(parkSchedule.schedule[0])!.calendar).toBe(day21);
    expect(rawOf(parkSchedule.schedule[1])!.calendar).toBe(day22);
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
