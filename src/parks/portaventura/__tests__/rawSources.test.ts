import {describe, it, expect, vi, beforeEach, afterEach} from 'vitest';
import {PortAventuraWorld} from '../portaventura.js';
import type {WithRaw} from '../../../destination.js';

/**
 * With `includeRaw` on, every park entity carries its parks-CMS record,
 * every attraction its attractions-CMS record, every live row its wait-time
 * entry, and every schedule entry its schedules-CMS record. Off, nothing
 * carries anything.
 */
const NOW = new Date('2026-09-21T10:00:00Z');

const parkMain = {id: 1, attributes: {name: 'PortAventura Park'}};
const parkFerrari = {id: 2, attributes: {name: 'Ferrari Land'}};

const attractionDragon = {id: 501, attributes: {name: 'Dragon Khan', park: {data: {id: 1}}, latitude: '41.0876', longitude: '1.1523', FTPName: 'DRAGONKHAN'}};
const attractionShambhala = {id: 502, attributes: {name: 'Shambhala', park: {data: {id: 1}}, latitude: '41.0891', longitude: '1.1534', FTPName: 'SHAMBHALA'}};
const attractionRedForce = {id: 503, attributes: {name: 'Red Force', park: {data: {id: 2}}, latitude: '41.0865', longitude: '1.1490', FTPName: 'REDFORCE'}};

const waitTimes: Record<string, any> = {
  DRAGONKHAN: {id: 'DRAGONKHAN', queue: 15, closed: false},
  SHAMBHALA: {id: 'SHAMBHALA', queue: null, closed: true},
  UNKNOWNRIDE: {id: 'UNKNOWNRIDE', queue: 5, closed: false},
};

const scheduleMainDay = {id: 9001, attributes: {date: '2026-09-21', openingTime: '10:00:00', closingTime: '20:00:00', park: {data: {id: 1}}}};
const scheduleFerrariInvalid = {id: 9002, attributes: {date: '2026-09-21', openingTime: '00:00:00', closingTime: '00:00:00', park: {data: {id: 2}}}};
const scheduleFerrariDay = {id: 9003, attributes: {date: '2026-09-22', openingTime: '10:00:00', closingTime: '18:00:00', park: {data: {id: 2}}}};

function stubbedPark(includeRaw: boolean): PortAventuraWorld {
  const park = new PortAventuraWorld();
  park.includeRaw = includeRaw;
  vi.spyOn(park as any, 'getParks').mockResolvedValue([parkMain, parkFerrari]);
  vi.spyOn(park as any, 'getAttractions').mockResolvedValue([attractionDragon, attractionShambhala, attractionRedForce]);
  vi.spyOn(park as any, 'getWaitTimes').mockResolvedValue(waitTimes);
  vi.spyOn(park as any, 'getScheduleData').mockResolvedValue([scheduleMainDay, scheduleFerrariInvalid, scheduleFerrariDay]);
  return park;
}

const rawOf = (element: object) => (element as WithRaw<object>).raw;

describe('PortAventuraWorld raw upstream pieces', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('attaches the wait-time entry to each live row, drops unmapped FTP names', async () => {
    const live = await stubbedPark(true).getLiveData();
    expect(live.map((l) => l.id)).toEqual(['501', '502']);

    expect(rawOf(live[0])).toEqual({waitTimes: waitTimes.DRAGONKHAN});
    expect(rawOf(live[0])!.waitTimes).toBe(waitTimes.DRAGONKHAN);
    expect(live[0].queue).toEqual({STANDBY: {waitTime: 15}});

    expect(rawOf(live[1])).toEqual({waitTimes: waitTimes.SHAMBHALA});
    expect(live[1].status).toBe('CLOSED');
    expect(live[1].queue).toBeUndefined();
  });

  it('attaches the CMS record to each park and attraction, nothing to the destination', async () => {
    const entities = await stubbedPark(true).getEntities();
    expect(entities.map((e) => e.id)).toEqual(['portaventuraworld', 'park_1', 'park_2', '501', '502', '503']);

    expect(rawOf(entities[0])).toBeUndefined();

    expect(rawOf(entities[1])).toEqual({parks: parkMain});
    expect(rawOf(entities[1])!.parks).toBe(parkMain);
    expect(entities[1].name).toBe('PortAventura Park');
    expect(rawOf(entities[2])!.parks).toBe(parkFerrari);

    expect(rawOf(entities[3])).toEqual({attractions: attractionDragon});
    expect(rawOf(entities[3])!.attractions).toBe(attractionDragon);
    expect(entities[3].name).toBe('Dragon Khan');
    expect(rawOf(entities[4])!.attractions).toBe(attractionShambhala);
    expect(rawOf(entities[5])!.attractions).toBe(attractionRedForce);
  });

  it('attaches the schedules-CMS record to each day, skips invalid windows', async () => {
    const schedules = await stubbedPark(true).getSchedules();
    expect(schedules.map((s) => s.id)).toEqual(['park_1', 'park_2']);

    const [mainPark, ferrariLand] = schedules;
    expect(mainPark.schedule).toHaveLength(1);
    expect(rawOf(mainPark.schedule[0])).toEqual({schedules: scheduleMainDay.attributes});
    expect(rawOf(mainPark.schedule[0])!.schedules).toBe(scheduleMainDay.attributes);
    expect(mainPark.schedule[0].openingTime).toBe('2026-09-21T10:00:00+02:00');
    expect(mainPark.schedule[0].closingTime).toBe('2026-09-21T20:00:00+02:00');

    expect(ferrariLand.schedule).toHaveLength(1);
    expect(rawOf(ferrariLand.schedule[0])!.schedules).toBe(scheduleFerrariDay.attributes);
    expect(ferrariLand.schedule[0].date).toBe('2026-09-22');
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
