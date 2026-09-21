import {describe, it, expect, vi, beforeEach, afterEach} from 'vitest';
import {DisneylandParis} from '../disneylandparis.js';
import {CacheLib} from '../../../cache.js';
import type {WithRaw} from '../../../destination.js';

/**
 * With `includeRaw` on, every element carries the upstream pieces it was built
 * from. A live row is assembled from up to five requests, so it can carry
 * several keys at once: the wait-times row, the premier-access row, the
 * virtual-queue activity, today's performances. A baseline row Disney's wait
 * feed never mentions carries its POI entry instead. Entities carry their POI
 * entry, the injected Walt Disney Studios Park carries nothing, and each
 * schedule day carries the window it was built from. Off, nothing carries
 * anything.
 */
const NOW = new Date('2026-09-21T10:00:00Z');
const TODAY = '2026-09-21';

const parkPoi = {id: 'P1', name: 'Disneyland Park', type: 'ThemePark'};
const ridePoi = {
  id: 'P1RA00', name: 'Big Thunder Mountain', type: 'Attraction',
  location: {id: 'P1'}, singleRider: true,
};
const walkthroughPoi = {
  id: 'P1MA01', name: 'Discovery Gallery', type: 'Attraction', location: {id: 'P1'},
};
const showPoi = {
  id: 'P1G200', name: 'The Lion King', type: 'Entertainment',
  subType: 'Stage Show', location: {id: 'P1'},
};
const diningPoi = {
  id: 'P1RR01', name: 'Casa de Coco', type: 'Restaurant', location: {id: 'P1'},
};

const waitRow = {
  entityId: 'P1RA00', type: 'Attraction', status: 'OPERATING', postedWaitMinutes: '30',
};
const premierRow = {
  attractionId: 'P1RA00', available: true,
  nextTimeSlotStartDateTime: `${TODAY}T15:00:00.000+0200`,
  nextTimeSlotEndDateTime: `${TODAY}T16:00:00.000+0200`,
  price: 12,
};
const vqueueRow = {
  queueId: 'q1', enabled: true, queueContentId: 'P1G200', activityId: 'Shows',
  waves: [{
    waveId: 'w1', name: 'morning', status: 'OPEN',
    openAt: `${TODAY}T09:45:00.000+0200`, closedAt: `${TODAY}T13:30:00.000+0200`,
  }],
};

const parkWindow = {date: TODAY, startTime: '09:30:00', endTime: '22:00:00', status: 'OPERATING'};
const performance = {date: TODAY, startTime: '14:00:00', endTime: '14:00:00', status: 'PERFORMANCE_TIME'};
const diningWindow = {date: TODAY, startTime: '11:00:00', endTime: '21:30:00', status: 'OPERATING'};

const todayRows = [
  {id: 'P1', name: 'Disneyland Park', schedules: [parkWindow]},
  {id: 'P1G200', name: 'The Lion King', schedules: [performance]},
  {id: 'P1RR01', name: 'Casa de Coco', schedules: [diningWindow]},
];

function stubbedPark(includeRaw: boolean): DisneylandParis {
  const park = new DisneylandParis();
  park.includeRaw = includeRaw;

  vi.spyOn(park as any, 'getPOIData').mockResolvedValue({
    ThemePark: [parkPoi],
    Attraction: [ridePoi, walkthroughPoi],
    Entertainment: [showPoi],
    Restaurant: [diningPoi],
  });
  vi.spyOn(park as any, 'getWaitTimes').mockResolvedValue([waitRow]);
  vi.spyOn(park as any, 'getPremierAccess').mockResolvedValue([premierRow]);
  vi.spyOn(park as any, 'getVirtualQueueData').mockResolvedValue([vqueueRow]);
  vi.spyOn(park as any, 'getScheduleForDate').mockImplementation(
    async (...args: unknown[]) => (args[0] === TODAY ? todayRows : []),
  );

  return park;
}

const rawOf = (element: object) => (element as WithRaw<object>).raw;

describe('DLP raw upstream pieces', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    CacheLib.clearByClassName('DisneylandParis', {includePersistent: true});
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('attaches every request that fed a live row', async () => {
    const live = await stubbedPark(true).getLiveData();
    expect(live.map((l) => l.id)).toEqual(['P1RA00', 'P1G200', 'P1MA01', 'P1RR01']);

    // Wait times and premier access both land on the ride.
    expect(rawOf(live[0])).toEqual({waitTimes: waitRow, premierAccess: premierRow});
    expect(rawOf(live[0])!.waitTimes).toBe(waitRow);
    expect(rawOf(live[0])!.premierAccess).toBe(premierRow);
    expect(live[0].queue?.STANDBY).toEqual({waitTime: 30});

    // The show is created by the virtual queue and then given its showtimes.
    expect(rawOf(live[1])).toEqual({vQueueActivity: vqueueRow, scheduleForDate: [performance]});
    expect(rawOf(live[1])!.vQueueActivity).toBe(vqueueRow);
    expect((rawOf(live[1])!.scheduleForDate as unknown[])[0]).toBe(performance);
    expect(live[1].showtimes?.[0]?.startTime).toBe('2026-09-21T14:00:00+02:00');

    // The restaurant's status comes from today's window alone.
    expect(rawOf(live[3])).toEqual({scheduleForDate: diningWindow});
    expect(rawOf(live[3])!.scheduleForDate).toBe(diningWindow);
    expect(live[3].status).toBe('OPERATING');
  });

  it('attaches the POI entry to a baseline row the wait feed never mentions', async () => {
    const live = await stubbedPark(true).getLiveData();

    const walkthrough = live.find((l) => l.id === 'P1MA01');
    expect(walkthrough?.status).toBe('OPERATING');
    // No row of its own today, so the park's windows decided the status.
    expect(rawOf(walkthrough!)).toEqual({poi: {...walkthroughPoi, category: 'Attraction'}, scheduleForDate: [parkWindow]});
    expect((rawOf(walkthrough!)!.scheduleForDate as unknown[])[0]).toBe(parkWindow);
    expect(walkthrough?.queue).toBeUndefined();
  });

  it('attaches the POI entry to each entity, nothing to the injected park', async () => {
    const entities = await stubbedPark(true).getEntities();
    expect(entities.map((e) => e.id)).toEqual(
      ['dlp', 'P1', 'P2', 'P1RA00', 'P1MA01', 'P1G200', 'P1RR01'],
    );

    // The destination is built from constants, and Disney dropped P2 from the
    // POI list, so the park entity standing in for it has no record behind it.
    expect(rawOf(entities[0])).toBeUndefined();
    expect(rawOf(entities[2])).toBeUndefined();

    expect(rawOf(entities[1])).toEqual({poi: {...parkPoi, category: 'ThemePark'}});
    expect(rawOf(entities[3])).toEqual({poi: {...ridePoi, category: 'Attraction'}});
    expect(entities[3].name).toBe('Big Thunder Mountain');
    expect(rawOf(entities[5])).toEqual({poi: {...showPoi, category: 'Entertainment'}});
    expect(entities[5].entityType).toBe('SHOW');
  });

  it('attaches the schedule window to each day', async () => {
    const schedules = await stubbedPark(true).getSchedules();
    expect(schedules.map((s) => s.id)).toEqual(['P1', 'P1G200', 'P1RR01']);

    const [park, show] = schedules;
    expect(park.schedule).toHaveLength(1);
    expect(rawOf(park.schedule[0])).toEqual({scheduleForDate: parkWindow});
    expect(rawOf(park.schedule[0])!.scheduleForDate).toBe(parkWindow);
    expect(park.schedule[0].closingTime).toBe('2026-09-21T22:00:00+02:00');

    expect(rawOf(show.schedule[0])).toEqual({scheduleForDate: performance});
    expect(rawOf(show.schedule[0])!.scheduleForDate).toBe(performance);
    expect(show.schedule[0].type).toBe('INFO');
  });

  it('carries nothing when includeRaw is off', async () => {
    const park = stubbedPark(false);
    for (const element of await park.getLiveData()) expect(rawOf(element)).toBeUndefined();
    for (const element of await park.getEntities()) expect(rawOf(element)).toBeUndefined();
    for (const entity of await park.getSchedules()) {
      for (const element of entity.schedule) expect(rawOf(element)).toBeUndefined();
    }
  });
});
