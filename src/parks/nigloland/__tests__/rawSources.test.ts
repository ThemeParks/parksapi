import {describe, it, expect, vi, beforeEach, afterEach} from 'vitest';
import {Nigloland} from '../nigloland.js';
import type {WithRaw} from '../../../destination.js';

/**
 * With `includeRaw` on, every element carries the upstream piece it was built
 * from: the points-of-interest row for entities and live data, plus today's
 * calendar entry wherever it actually gated the outcome (every show, and a
 * ride only while its status is the Indéterminé fallback). Off, nothing
 * carries anything.
 */
const NOW = new Date('2026-09-21T12:00:00Z');

const rideOpen = {
  idNiglo: 601,
  title: 'La Choupette',
  statusName: 'Ouvert',
  waitingTime: 20,
  updatedAt: '2026-09-21T13:55:00+02:00',
  sizeReference: {minSoloSize: 120},
};

const rideIndeterminate = {
  idNiglo: 602,
  title: 'Le Grand 8',
  statusName: 'Indéterminé',
  waitingTime: null,
  updatedAt: '2026-09-21T13:00:00+02:00',
};

const rideRetired = {
  idNiglo: 603,
  title: 'Ancien Manège',
  statusName: 'Indéterminé',
  waitingTime: null,
  updatedAt: '2024-01-01T00:00:00+01:00',
};

const showFixture = {
  idNiglo: 701,
  title: 'Le Spectacle Aquatique',
  statusName: 'Indéterminé',
  showTimes: ['14:30', '17:00'],
  isEnabled: true,
};

const showDisabled = {
  idNiglo: 702,
  title: 'Ancien Spectacle',
  statusName: 'Indéterminé',
  showTimes: [] as string[],
  isEnabled: false,
};

const foodFixture = {idNiglo: 801, title: 'Crêperie'};

const todayCalendar = {
  id: 501,
  date: '2026-09-21T00:00:00+02:00',
  calendarType: {hoursPark: '10h00 à 19h00', hoursRides: '10h00 à 18h30'},
};

const tomorrowCalendar = {
  id: 502,
  date: '2026-09-22T00:00:00+02:00',
  calendarType: {hoursPark: '10h00 à 18h00', hoursRides: '10h00 à 18h00'},
};

function stubbedPark(includeRaw: boolean): Nigloland {
  const park = new Nigloland();
  park.includeRaw = includeRaw;
  vi.spyOn(park as any, 'getPointsOfInterest').mockResolvedValue({
    rides: [rideOpen, rideIndeterminate, rideRetired],
    foodServices: [foodFixture],
    shows: [showFixture, showDisabled],
    shops: [],
  });
  vi.spyOn(park as any, 'getCalendarDates').mockResolvedValue([todayCalendar, tomorrowCalendar]);
  return park;
}

const rawOf = (element: object) => (element as WithRaw<object>).raw;

describe('Nigloland raw upstream pieces', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('attaches the points-of-interest row and today\'s calendar entry to each live row', async () => {
    const live = await stubbedPark(true).getLiveData();
    expect(live.map((l) => l.id)).toEqual(['601', '602', '603', '701']);

    // Ouvert never consults the calendar.
    expect(live[0].status).toBe('OPERATING');
    expect(rawOf(live[0])).toEqual({pointsOfInterest: rideOpen, calendarDates: todayCalendar});
    expect(rawOf(live[0])!.pointsOfInterest).toBe(rideOpen);
    expect(live[0].queue).toEqual({STANDBY: {waitTime: 20}});

    // Indéterminé, not retired: the calendar decides it.
    expect(live[1].status).toBe('OPERATING');
    expect(rawOf(live[1])).toEqual({pointsOfInterest: rideIndeterminate, calendarDates: todayCalendar});
    expect(rawOf(live[1])!.calendarDates).toBe(todayCalendar);

    // Indéterminé, but retired: closed regardless of the calendar.
    expect(live[2].status).toBe('CLOSED');
    expect(rawOf(live[2])).toEqual({pointsOfInterest: rideRetired, calendarDates: todayCalendar});

    expect(live[3].status).toBe('OPERATING');
    expect(rawOf(live[3])).toEqual({pointsOfInterest: showFixture, calendarDates: todayCalendar});
    expect(rawOf(live[3])!.pointsOfInterest).toBe(showFixture);
    expect(live[3].showtimes).toHaveLength(2);
  });

  it('attaches the points-of-interest row to each entity, nothing to the destination or park', async () => {
    const entities = await stubbedPark(true).getEntities();
    expect(entities.map((e) => e.id)).toEqual(['niglolandresort', 'nigloland', '601', '602', '603', '701', '801']);

    expect(rawOf(entities[0])).toBeUndefined();
    expect(rawOf(entities[1])).toBeUndefined();

    expect(rawOf(entities[2])).toEqual({pointsOfInterest: rideOpen});
    expect(rawOf(entities[2])!.pointsOfInterest).toBe(rideOpen);
    expect(entities[2].tags).toHaveLength(1);

    expect(rawOf(entities[3])).toEqual({pointsOfInterest: rideIndeterminate});
    expect(rawOf(entities[4])).toEqual({pointsOfInterest: rideRetired});

    expect(rawOf(entities[5])).toEqual({pointsOfInterest: showFixture});
    expect(entities[5].name).toBe('Le Spectacle Aquatique');

    expect(rawOf(entities[6])).toEqual({pointsOfInterest: foodFixture});
    expect(rawOf(entities[6])!.pointsOfInterest).toBe(foodFixture);
  });

  it('attaches today\'s and tomorrow\'s calendar entry to each day, the same entry shared between the park and every ride', async () => {
    const schedules = await stubbedPark(true).getSchedules();
    const parkSchedule = schedules.find((s) => s.id === 'nigloland')!;
    expect(parkSchedule.schedule.map((e) => e.date)).toEqual(['2026-09-21', '2026-09-22']);
    expect(rawOf(parkSchedule.schedule[0])).toEqual({calendarDates: todayCalendar});
    expect(rawOf(parkSchedule.schedule[0])!.calendarDates).toBe(todayCalendar);
    expect(rawOf(parkSchedule.schedule[1])!.calendarDates).toBe(tomorrowCalendar);

    const rideSchedule602 = schedules.find((s) => s.id === '602')!;
    const rideSchedule603 = schedules.find((s) => s.id === '603')!;
    expect(rideSchedule602.schedule).toBe(rideSchedule603.schedule);
    expect(rawOf(rideSchedule602.schedule[0])!.calendarDates).toBe(todayCalendar);
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
