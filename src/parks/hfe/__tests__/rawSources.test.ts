import {describe, it, expect, vi, beforeEach, afterEach} from 'vitest';
import {Dollywood} from '../hfe.js';
import type {WithRaw} from '../../../destination.js';

/**
 * With `includeRaw` on, every element carries the upstream piece it was built
 * from: the wait-time row and today's schedule day for live data, the
 * activity entry for an entity (plus the matching schedule activity for a
 * show), and the parkHours block or show event for a schedule day. Off,
 * nothing carries anything.
 */
const NOW = new Date('2026-09-21T18:00:00Z');

const rideActivity = {
  id: 'ride-1',
  title: 'Lightning Rod',
  activityCategories: ['Theme Park Rides'],
  activityListId: '96822fdb-77e5-4054-9f37-70f379f997d8',
  rideWaitTimeRideId: 501,
  latitudeForDirections: '35.7945',
  longitudeForDirections: '-83.5304',
  heightRequirement: {minHeight: '54', maxHeight: null},
};

const rideActivity2 = {
  id: 'ride-2',
  title: 'FireChaser Express',
  activityCategories: ['Theme Park Rides'],
  activityListId: '96822fdb-77e5-4054-9f37-70f379f997d8',
  rideWaitTimeRideId: 502,
  latitudeForDirections: '35.7946',
  longitudeForDirections: '-83.5305',
};

const diningActivity = {
  id: 'dine-1',
  title: "Aunt Granny's",
  activityCategories: ['Theme Park Dining'],
  latitudeForDirections: '35.795',
  longitudeForDirections: '-83.531',
};

const showActivity = {
  id: 'show-1',
  title: 'Sha-Kon-O-Hey!',
  activityCategories: [] as string[],
  activityListId: 'b9acfd27-0545-4bb2-a6e8-072fda3b06dd',
  latitudeForDirections: '35.796',
  longitudeForDirections: '-83.532',
  duration: '25 Minutes',
};

const waitTimeRow = {
  rideId: 501,
  rideName: 'Lightning Rod',
  operationStatus: 'OPEN',
  waitTime: 35,
  waitTimeDisplay: '35 Minutes',
};

const waitTimeRowGated = {
  rideId: 502,
  rideName: 'FireChaser Express',
  operationStatus: 'Temporarily Closed',
  waitTime: null,
  waitTimeDisplay: '',
};

const showEvent = {from: '2026-09-21T19:00:00', to: null};
const showScheduleActivity = {cmsKey: 'show-1', events: [showEvent], isAllDayEvent: false};

const todayHours = {from: '2026-09-21T10:00:00', to: '2026-09-21T22:00:00'};
const tomorrowHours = {from: '2026-09-22T10:00:00', to: '2026-09-22T22:00:00'};

const scheduleDays = [
  {date: '2026-09-21', parkHours: [todayHours], activities: [showScheduleActivity]},
  {date: '2026-09-22', parkHours: [tomorrowHours], activities: []},
];

function stubbedPark(includeRaw: boolean): Dollywood {
  const park = new Dollywood();
  park.includeRaw = includeRaw;
  vi.spyOn(park as any, 'getActivities').mockResolvedValue([rideActivity, rideActivity2, diningActivity, showActivity]);
  vi.spyOn(park as any, 'getSchedule').mockResolvedValue(scheduleDays);
  vi.spyOn(park as any, 'getWaitTimes').mockResolvedValue([waitTimeRow, waitTimeRowGated]);
  return park;
}

const rawOf = (element: object) => (element as WithRaw<object>).raw;

describe('Dollywood raw upstream pieces', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('attaches the wait-time row and today\'s schedule day to each live row', async () => {
    const live = await stubbedPark(true).getLiveData();
    expect(live.map((l) => l.id)).toEqual(['ride-1', 'ride-2']);

    expect(rawOf(live[0])).toEqual({waitTimes: waitTimeRow, schedule: scheduleDays[0]});
    expect(rawOf(live[0])!.waitTimes).toBe(waitTimeRow);
    expect(live[0].queue).toEqual({STANDBY: {waitTime: 35}});

    expect(live[1].status).toBe('DOWN');
    expect(rawOf(live[1])).toEqual({waitTimes: waitTimeRowGated, schedule: scheduleDays[0]});
    expect(rawOf(live[1])!.waitTimes).toBe(waitTimeRowGated);
    expect(rawOf(live[1])!.schedule).toBe(scheduleDays[0]);
  });

  it('attaches the activity to each entity, the show also the matching schedule activity, nothing to the destination or park', async () => {
    const entities = await stubbedPark(true).getEntities();
    expect(entities.map((e) => e.id)).toEqual(['dollywood', 'dollywoodpark', 'ride-1', 'ride-2', 'dine-1', 'show-1']);

    expect(rawOf(entities[0])).toBeUndefined();
    expect(rawOf(entities[1])).toBeUndefined();

    expect(rawOf(entities[2])).toEqual({activities: rideActivity});
    expect(rawOf(entities[2])!.activities).toBe(rideActivity);
    expect(entities[2].tags).toHaveLength(1);

    expect(rawOf(entities[3])).toEqual({activities: rideActivity2});

    expect(rawOf(entities[4])).toEqual({activities: diningActivity});
    expect(rawOf(entities[4])!.activities).toBe(diningActivity);

    expect(rawOf(entities[5])).toEqual({activities: showActivity, schedule: [showScheduleActivity]});
    expect(rawOf(entities[5])!.activities).toBe(showActivity);
    expect((rawOf(entities[5])!.schedule as unknown[])[0]).toBe(showScheduleActivity);
  });

  it('attaches the parkHours block to each park day, and the event plus the show activity to the duration-derived show day', async () => {
    const schedules = await stubbedPark(true).getSchedules();
    const parkSchedule = schedules.find((s) => s.id === 'dollywoodpark')!;
    expect(parkSchedule.schedule.map((e) => e.date)).toEqual(['2026-09-21', '2026-09-22']);

    expect(rawOf(parkSchedule.schedule[0])).toEqual({schedule: todayHours});
    expect(rawOf(parkSchedule.schedule[0])!.schedule).toBe(todayHours);
    expect(rawOf(parkSchedule.schedule[1])!.schedule).toBe(tomorrowHours);

    const showSchedule = schedules.find((s) => s.id === 'show-1')!;
    expect(showSchedule.schedule).toHaveLength(1);
    expect(rawOf(showSchedule.schedule[0])).toEqual({schedule: showEvent, activities: showActivity});
    expect(rawOf(showSchedule.schedule[0])!.schedule).toBe(showEvent);
    expect(rawOf(showSchedule.schedule[0])!.activities).toBe(showActivity);
    expect(showSchedule.schedule[0].openingTime).toBe('2026-09-21T19:00:00-04:00');
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
