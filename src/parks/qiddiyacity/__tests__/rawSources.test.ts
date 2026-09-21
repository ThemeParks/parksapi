import {describe, it, expect, vi, beforeEach, afterEach} from 'vitest';
import {QiddiyaCity} from '../qiddiyacity.js';
import type {WithRaw} from '../../../destination.js';

/**
 * With `includeRaw` on, every element carries the upstream piece it was
 * built from: the activity row for entities and live data, the dashboard for
 * a Six Flags live row (the piece that decides sixFlagsOpen), and the
 * website's weekly schedule for every day the weekly pattern produces, the
 * same object on each day. Off, nothing carries anything.
 */
const NOW = new Date('2026-09-21T12:00:00Z');

const rideSixFlags = {
  id: 'ride-1',
  name: 'falcons-flight',
  title: "Falcon's Flight",
  category: 'RIDES' as const,
  categoryTitle: 'Rides',
  location: {latitude: 24.588, longitude: 46.333},
  minHeight: 140,
  waitTime: 20,
  mobileImageAttribute: {externalPath: '/assets/sixflags/falcons-flight.jpg'},
};

const rideAquaRabia = {
  id: 'ride-2',
  name: 'wave-pool',
  title: 'Wave Pool',
  category: 'RIDES' as const,
  categoryTitle: 'Rides',
  location: {latitude: 24.586, longitude: 46.326},
  waitTime: 10,
  mobileImageAttribute: {externalPath: '/assets/aquarabia/wave-pool.jpg'},
};

const diningItem = {
  id: 'dine-1',
  name: 'burger-joint',
  title: 'Burger Joint',
  category: 'DINING' as const,
  categoryTitle: 'Dining',
  location: {latitude: 24.587, longitude: 46.331},
  mobileImageAttribute: {externalPath: '/assets/sixflags/burger.jpg'},
};

const showItem = {
  id: 'show-1',
  name: 'light-show',
  title: 'Light Show',
  category: 'ENTERTAINMENT' as const,
  categoryTitle: 'Entertainment',
  mobileImageAttribute: {externalPath: '/assets/aquarabia/light-show.jpg'},
};

const activities = [rideSixFlags, rideAquaRabia, diningItem, showItem];

const dashboardOpen = {parkInfo: {isOpen: true, openingHours: '4:00 PM - 12:00 AM KSA'}};

const weekHours = {open: '16:00', close: '00:00'};
const websiteSchedule = {weekdaysSchedule: 'Weekdays: 4 PM - 12 AM', weekendsSchedule: 'Weekends: 4 PM - 12 AM'};

function stubbedPark(includeRaw: boolean): QiddiyaCity {
  const park = new QiddiyaCity();
  park.includeRaw = includeRaw;
  vi.spyOn(park as any, 'getActivities').mockResolvedValue(activities);
  vi.spyOn(park as any, 'getDashboard').mockResolvedValue(dashboardOpen);
  vi.spyOn(park as any, 'getWebsiteSchedule').mockResolvedValue({
    hours: {0: weekHours, 1: weekHours, 2: weekHours, 3: weekHours, 4: weekHours, 5: weekHours, 6: weekHours},
    source: websiteSchedule,
  });
  return park;
}

const rawOf = (element: object) => (element as WithRaw<object>).raw;

describe('QiddiyaCity raw upstream pieces', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('attaches the activity row to each live ride, the dashboard only to the Six Flags ride it decided', async () => {
    const live = await stubbedPark(true).getLiveData();
    expect(live.map((l) => l.id)).toEqual(['ride-1', 'ride-2']);

    expect(rawOf(live[0])).toEqual({activities: rideSixFlags, dashboard: dashboardOpen});
    expect(rawOf(live[0])!.activities).toBe(rideSixFlags);
    expect(rawOf(live[0])!.dashboard).toBe(dashboardOpen);
    expect(live[0].queue).toEqual({STANDBY: {waitTime: 20}});

    expect(rawOf(live[1])).toEqual({activities: rideAquaRabia});
    expect(rawOf(live[1])!.activities).toBe(rideAquaRabia);
    expect(live[1].queue).toEqual({STANDBY: {waitTime: 10}});
  });

  it('attaches the activity row to each entity, nothing to either park', async () => {
    const entities = await stubbedPark(true).getEntities();
    expect(entities.map((e) => e.id)).toEqual([
      'qiddiyacity', 'sixflagsqiddiyacity', 'aquarabiaqiddiyacity', 'ride-1', 'ride-2', 'dine-1', 'show-1',
    ]);

    expect(rawOf(entities[0])).toBeUndefined();
    expect(rawOf(entities[1])).toBeUndefined();
    expect(rawOf(entities[2])).toBeUndefined();

    expect(rawOf(entities[3])).toEqual({activities: rideSixFlags});
    expect(rawOf(entities[3])!.activities).toBe(rideSixFlags);
    expect(entities[3].tags).toHaveLength(1);

    expect(rawOf(entities[4])).toEqual({activities: rideAquaRabia});
    expect(rawOf(entities[5])).toEqual({activities: diningItem});
    expect(rawOf(entities[6])).toEqual({activities: showItem});
  });

  it('attaches the website\'s weekly schedule to each day the weekly pattern produces, the same object every day', async () => {
    const schedules = await stubbedPark(true).getSchedules();
    const sixFlagsSchedule = schedules.find((s) => s.id === 'sixflagsqiddiyacity')!;
    expect(sixFlagsSchedule.schedule.length).toBeGreaterThan(1);

    expect(rawOf(sixFlagsSchedule.schedule[0])).toEqual({website: websiteSchedule});
    expect(rawOf(sixFlagsSchedule.schedule[0])!.website).toBe(websiteSchedule);
    expect(rawOf(sixFlagsSchedule.schedule[1])!.website).toBe(websiteSchedule);

    const aquaRabiaSchedule = schedules.find((s) => s.id === 'aquarabiaqiddiyacity')!;
    expect(aquaRabiaSchedule.schedule).toEqual([]);
  });

  it('falls back to the dashboard for a single day when the website schedule is unavailable, and attaches it', async () => {
    const park = new QiddiyaCity();
    park.includeRaw = true;
    vi.spyOn(park as any, 'getActivities').mockResolvedValue([]);
    vi.spyOn(park as any, 'getDashboard').mockResolvedValue(dashboardOpen);
    vi.spyOn(park as any, 'getWebsiteSchedule').mockResolvedValue({hours: {}, source: null});

    const schedules = await park.getSchedules();
    const sixFlagsSchedule = schedules.find((s) => s.id === 'sixflagsqiddiyacity')!;
    expect(sixFlagsSchedule.schedule).toHaveLength(1);
    expect(rawOf(sixFlagsSchedule.schedule[0])).toEqual({dashboard: dashboardOpen});
    expect(rawOf(sixFlagsSchedule.schedule[0])!.dashboard).toBe(dashboardOpen);
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
