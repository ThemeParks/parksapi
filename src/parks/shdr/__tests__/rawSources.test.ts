import {describe, it, expect, vi, afterEach} from 'vitest';
import {ShanghaiDisneylandResort} from '../shanghaidisneyresort.js';
import type {WithRaw} from '../../../destination.js';

/**
 * With `includeRaw` on, every element carries the upstream piece it was
 * built from: the facility row for entities, the wait-times row (or rows,
 * where a standby-pass entry also contributes) for live data, and the
 * schedule entry for a day. Off, nothing carries anything.
 */
const parkFacility = {
  id: 'entParkShanghaiDisneyland;entityType=theme-park;destination=shdr',
  name: 'Shanghai Disneyland',
  type: 'theme-park',
  relatedLocations: [{id: 'loc-1', type: 'primaryLocation', coordinates: [{latitude: '31.1435', longitude: '121.6579'}]}],
};

const rideFacility = {
  id: 'attTronLightcycle;entityType=Attraction;destination=shdr',
  name: 'TRON Lightcycle Power Run',
  type: 'Attraction',
  ancestors: [{id: parkFacility.id, type: 'theme-park'}],
  facets: [{id: '140cm-or-taller', group: 'height'}],
};

const standbyPassFacility = {
  id: 'entDPATronLightcycle;entityType=Attraction;destination=shdr',
  name: 'TRON Lightcycle Power Run (Standby Pass Required)',
  type: 'Attraction',
  ancestors: [{id: parkFacility.id, type: 'theme-park'}],
};

const showFacility = {
  id: 'entMickeyStorybookExpress;entityType=Entertainment;destination=shdr',
  name: "Mickey's Storybook Express",
  type: 'Entertainment',
  ancestors: [{id: parkFacility.id, type: 'theme-park'}],
};

const facilities = [parkFacility, rideFacility, standbyPassFacility, showFacility];

const rideEntry = {id: rideFacility.id, waitTime: {status: 'Operating', postedWaitMinutes: 20, singleRider: false}};
const standbyEntry = {id: standbyPassFacility.id, waitTime: {status: 'Operating'}};
const showEntry = {id: showFacility.id, waitTime: {status: 'Operating'}};
const waitTimes = [rideEntry, standbyEntry, showEntry];

const rideSchedDay1 = {type: 'Operating', date: '2026-09-21', startTime: '09:00:00', endTime: '21:00:00'};
const rideSchedDay2 = {type: 'Operating', date: '2026-09-22', startTime: '09:00:00', endTime: '20:00:00'};
const rideSchedClosed = {type: 'Closed', date: '2026-09-23', startTime: '00:00:00', endTime: '00:00:00'};
const scheduleActivities = [{id: rideFacility.id, schedule: {schedules: [rideSchedDay1, rideSchedDay2, rideSchedClosed]}}];

function stubbedPark(includeRaw: boolean): ShanghaiDisneylandResort {
  const park = new ShanghaiDisneylandResort();
  park.includeRaw = includeRaw;
  vi.spyOn(park as any, 'getFacilities').mockResolvedValue(facilities);
  vi.spyOn(park as any, 'getWaitTimes').mockResolvedValue(waitTimes);
  vi.spyOn(park as any, 'getScheduleActivities').mockResolvedValue(scheduleActivities);
  return park;
}

const rawOf = (element: object) => (element as WithRaw<object>).raw;

describe('ShanghaiDisneylandResort raw upstream pieces', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('attaches the wait-times row to a live row, and both rows as a list where the standby-pass entry also contributed', async () => {
    const live = await stubbedPark(true).getLiveData();
    expect(live.map((l) => l.id)).toEqual([rideFacility.id, showFacility.id]);

    const rideRaw = rawOf(live[0])!.waitTimes as unknown[];
    expect(rideRaw).toEqual([rideEntry, standbyEntry]);
    expect(rideRaw[0]).toBe(rideEntry);
    expect(rideRaw[1]).toBe(standbyEntry);
    expect(live[0].queue).toEqual({
      STANDBY: {waitTime: 20},
      RETURN_TIME: expect.objectContaining({state: 'AVAILABLE'}),
    });

    expect(rawOf(live[1])).toEqual({waitTimes: showEntry});
    expect(rawOf(live[1])!.waitTimes).toBe(showEntry);
  });

  it('attaches the facility row to each entity, nothing to the destination', async () => {
    const entities = await stubbedPark(true).getEntities();
    expect(entities.map((e) => e.id)).toEqual([
      'shanghaidisneyresort', parkFacility.id, rideFacility.id, showFacility.id,
    ]);

    expect(rawOf(entities[0])).toBeUndefined();

    expect(rawOf(entities[1])).toEqual({facilities: parkFacility});
    expect(rawOf(entities[1])!.facilities).toBe(parkFacility);

    expect(rawOf(entities[2])).toEqual({facilities: rideFacility});
    expect(rawOf(entities[2])!.facilities).toBe(rideFacility);
    expect(entities[2].tags).toHaveLength(1);

    expect(rawOf(entities[3])).toEqual({facilities: showFacility});
    expect(rawOf(entities[3])!.facilities).toBe(showFacility);
  });

  it('attaches the schedule entry to each day, and skips the non-Operating one entirely', async () => {
    const [rideSchedule] = await stubbedPark(true).getSchedules();
    expect(rideSchedule.id).toBe(rideFacility.id);
    expect(rideSchedule.schedule.map((e) => e.date)).toEqual(['2026-09-21', '2026-09-22']);

    expect(rawOf(rideSchedule.schedule[0])).toEqual({schedules: rideSchedDay1});
    expect(rawOf(rideSchedule.schedule[0])!.schedules).toBe(rideSchedDay1);
    expect(rawOf(rideSchedule.schedule[1])!.schedules).toBe(rideSchedDay2);
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
