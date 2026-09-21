import {describe, test, expect, vi, beforeEach, afterEach} from 'vitest';
import {SixFlags} from '../sixflags.js';
import type {WithRaw} from '../../../destination.js';

/**
 * With `includeRaw` on, every element carries the upstream piece it was built
 * from: the venue-status detail and the wait-times detail for a ride, the
 * venue-status detail plus today's show block for a show, the POI row for a
 * child entity, the park's own entry from the Firebase configuration for a
 * destination or park, and the operating-hours day for a schedule entry — the
 * same day object on the haunt entry of that night. Off, nothing carries
 * anything.
 */
const NOW = new Date('2026-09-21T14:00:00Z'); // 10:00 in New York

const MAIN_PARK_ID = 905;
const WATER_PARK_ID = 925;

const waterPark = {parkId: WATER_PARK_ID, code: 'HHNJ', name: 'Hurricane Harbor New Jersey', label: 'Water Park'};
const mainPark = {parkId: MAIN_PARK_ID, code: 'GADV', name: 'Six Flags Great Adventure', waterParks: [waterPark]};

const ridePoi = {fimsId: 'RIDE-905-00001', name: 'Nitro', parkId: MAIN_PARK_ID, venueId: 1, location: {latitude: '40.1375', longitude: '-74.4408'}};
const showPoi = {fimsId: 'SHOW-905-00002', name: 'Fireworks', parkId: MAIN_PARK_ID, venueId: 2};
const mazePoi = {fimsId: 'MAZE-905-00003', name: 'NEW! The Manor', parkId: MAIN_PARK_ID, venueId: 3};
const waterRidePoi = {fimsId: 'RIDE-925-00004', name: 'King Cobra', parkId: WATER_PARK_ID, venueId: 1, location: {latitude: '40.1402', longitude: '-74.4432'}};
const poiRows = [ridePoi, showPoi, mazePoi, waterRidePoi];

const rideStatus = {fimsId: 'RIDE-905-00001', status: 'Opened'};
const showStatus = {fimsId: 'SHOW-905-00002', status: 'Opened'};
const mazeStatus = {fimsId: 'MAZE-905-00003', status: 'Not Scheduled'};
const venueStatus = {
  parkName: 'Six Flags Great Adventure',
  lat: '40.1375',
  lng: '-74.4408',
  venues: [
    {venueId: 1, details: [rideStatus]},
    {venueId: 2, details: [showStatus]},
    {venueId: 3, details: [mazeStatus]},
  ],
};

// The second ride posts a wait but is missing from the venue-status roster,
// so it reaches live data through the union with no status row of its own.
const rideWait = {fimsId: 'RIDE-905-00001', regularWaittime: {waitTime: 35}};
const rosterlessWait = {fimsId: 'RIDE-905-00072', regularWaittime: {waitTime: 60}};
const waitTimes = {venues: [{venueId: 1, details: [rideWait, rosterlessWait]}]};

const showBlock = {fimsId: 'SHOW-905-00002', items: [{times: '02:00 PM, 05:15 PM'}]};
const operatingDay = {
  date: '09/21/2026',
  isParkClosed: false,
  venues: [{venueId: 1, detailHours: [{operatingTimeFrom: '10:00', operatingTimeTo: '20:00'}]}],
  operatings: [
    {operatingTypeId: 24, operatingTypeName: 'Park', items: [{timeFrom: '10:00', timeTo: '20:00'}]},
    {operatingTypeId: 25, operatingTypeName: 'Fright Fest', items: [{timeFrom: '19:00', timeTo: '01:00'}]},
  ],
  shows: [showBlock],
};
const operatingHours = {dates: [operatingDay]};

function stubbedPark(includeRaw: boolean): SixFlags {
  const park = new SixFlags();
  park.includeRaw = includeRaw;
  vi.spyOn(park, 'getParkData').mockResolvedValue([mainPark]);
  vi.spyOn(park, 'getPOI').mockResolvedValue(poiRows as any);
  vi.spyOn(park, 'getVenueStatus').mockImplementation(
    async (parkId: number) => (parkId === MAIN_PARK_ID ? venueStatus as any : null),
  );
  vi.spyOn(park, 'getWaitTimes').mockImplementation(
    async (parkId: number) => (parkId === MAIN_PARK_ID ? waitTimes as any : null),
  );
  // Three months are requested; only the current one has a published day.
  vi.spyOn(park, 'getOperatingHours').mockImplementation(
    async (parkId: number, date: string) =>
      (parkId === MAIN_PARK_ID && date === '202609' ? operatingHours as any : null),
  );
  return park;
}

const rawOf = (element: object) => (element as WithRaw<object>).raw;

describe('Six Flags raw upstream pieces', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  test('attaches both feeds to a ride and only what each row came from', async () => {
    const live = await stubbedPark(true).getLiveData();
    expect(live.map((l) => l.id)).toEqual(['RIDE-905-00001', 'MAZE-905-00003', 'RIDE-905-00072', 'SHOW-905-00002']);

    // Rostered ride with a posted wait: both feeds contributed.
    expect(rawOf(live[0])).toEqual({venueStatus: rideStatus, waitTimes: rideWait});
    expect(rawOf(live[0])!.venueStatus).toBe(rideStatus);
    expect(rawOf(live[0])!.waitTimes).toBe(rideWait);
    expect(live[0].queue).toEqual({STANDBY: {waitTime: 35}});

    // Maze posts no wait, so wait-times contributed nothing to it.
    expect(rawOf(live[1])).toEqual({venueStatus: mazeStatus});
    expect(rawOf(live[1])!.venueStatus).toBe(mazeStatus);
    expect(live[1].status).toBe('CLOSED');

    // Recovered from wait-times alone: there is no venue-status row for it.
    expect(rawOf(live[2])).toEqual({waitTimes: rosterlessWait});
    expect(rawOf(live[2])!.waitTimes).toBe(rosterlessWait);
    expect(live[2].status).toBe('OPERATING');
    expect(live[2].queue).toEqual({STANDBY: {waitTime: 60}});
  });

  test('attaches the status row and today show block to a show', async () => {
    const live = await stubbedPark(true).getLiveData();
    const show = live[3];

    expect(rawOf(show)).toEqual({operatingHours: showBlock, venueStatus: showStatus});
    expect(rawOf(show)!.venueStatus).toBe(showStatus);
    expect(rawOf(show)!.operatingHours).toBe(showBlock);
    expect((show as any).showtimes[0].startTime).toBe('2026-09-21T14:00:00-04:00');
  });

  test('attaches the POI row to each child and the park entry to each park', async () => {
    const entities = await stubbedPark(true).getEntities();
    expect(entities.map((e) => e.id)).toEqual([
      'sixflags_destination_GADV',
      'sixflags_park_GADV',
      'sixflags_park_HHNJ',
      'RIDE-905-00001',
      'SHOW-905-00002',
      'MAZE-905-00003',
      'RIDE-925-00004',
    ]);

    // Destination and park are named from the park's own configuration entry,
    // never from the whole Firebase configuration.
    expect(rawOf(entities[0])).toEqual({firebaseConfig: mainPark});
    expect(rawOf(entities[0])!.firebaseConfig).toBe(mainPark);
    expect(rawOf(entities[1])!.firebaseConfig).toBe(mainPark);
    expect(rawOf(entities[2])).toEqual({firebaseConfig: waterPark});
    expect(rawOf(entities[2])!.firebaseConfig).toBe(waterPark);
    expect(entities[2].name).toBe('Hurricane Harbor New Jersey');

    expect(rawOf(entities[3])).toEqual({poi: ridePoi});
    expect(rawOf(entities[3])!.poi).toBe(ridePoi);
    expect(rawOf(entities[4])!.poi).toBe(showPoi);

    expect(rawOf(entities[5])).toEqual({poi: mazePoi});
    expect(rawOf(entities[5])!.poi).toBe(mazePoi);
    expect(entities[5].name).toBe('The Manor');

    expect(rawOf(entities[6])!.poi).toBe(waterRidePoi);
    expect(entities[6].parentId).toBe('sixflags_park_HHNJ');
  });

  test('attaches the operating-hours day to the park day and its haunt night', async () => {
    const schedules = await stubbedPark(true).getSchedules();
    expect(schedules.map((s) => s.id)).toEqual(['sixflags_park_GADV', 'sixflags_park_HHNJ']);

    const [operating, haunt] = schedules[0].schedule;
    expect(rawOf(operating)).toEqual({operatingHours: operatingDay});
    expect(rawOf(operating)!.operatingHours).toBe(operatingDay);
    expect(operating.closingTime).toBe('2026-09-21T20:00:00-04:00');

    // The one day object produced both entries of that night.
    expect(haunt.type).toBe('TICKETED_EVENT');
    expect(rawOf(haunt)!.operatingHours).toBe(operatingDay);
    expect(haunt.closingTime).toBe('2026-09-22T01:00:00-04:00');

    // The water park publishes no hours, so it has no day to carry.
    expect(schedules[1].schedule).toEqual([]);
  });

  test('carries nothing when includeRaw is off', async () => {
    const park = stubbedPark(false);
    for (const element of await park.getLiveData()) expect(rawOf(element)).toBeUndefined();
    for (const element of await park.getEntities()) expect(rawOf(element)).toBeUndefined();
    for (const schedule of await park.getSchedules()) {
      for (const element of schedule.schedule) expect(rawOf(element)).toBeUndefined();
    }
  });
});
