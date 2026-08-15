import {describe, it, expect, vi, afterEach} from 'vitest';
import {DisneylandParis} from '../disneylandparis.js';

/**
 * IGNORE_ENTITIES drops POI records Disney types as attractions but which are
 * not venues we publish: a land-entry pass (P2EA02), an entrance building
 * (P2FD03), assorted test rows.
 *
 * Nothing in the POI record distinguishes them. World Premiere arrives with
 * the same shape as Phantom Manor — `type: "Attraction"`, empty `subType`,
 * `anyHeight`, one Guest Entrance coordinate — so the id list is the only
 * place the distinction can live, and it has to hold across all three of
 * entities, live data and schedules.
 */
function stubbedPark(): DisneylandParis {
  const park = new DisneylandParis();

  vi.spyOn(park as any, 'getPOIData').mockResolvedValue({
    ThemePark: [
      {id: 'P1', name: 'Disneyland Park', type: 'ThemePark'},
      {id: 'P2', name: 'Disney Adventure World', type: 'ThemePark'},
    ],
    Attraction: [
      {
        // The entrance building. Byte-for-byte the shape of a real ride.
        id: 'P2FD03',
        name: 'World Premiere',
        type: 'Attraction',
        subType: '',
        location: {id: 'P2'},
        coordinates: [{lat: 48.867857, lng: 2.780041, type: 'Guest Entrance'}],
        height: [{id: 'anyHeight'}],
        schedules: [],
      },
      {
        // The land-entry pass, already ignored — the control that proves this
        // test would catch a regression in the mechanism, not just the new id.
        id: 'P2EA02',
        name: 'Entry to World of Frozen',
        type: 'Attraction',
        subType: '',
        location: {id: 'P2'},
      },
      {
        // A real ride with the identical record shape: must publish.
        id: 'P1RA03',
        name: 'Phantom Manor',
        type: 'Attraction',
        subType: '',
        location: {id: 'P1'},
        coordinates: [{lat: 48.8725, lng: 2.7762, type: 'Guest Entrance'}],
        height: [{id: 'anyHeight'}],
        schedules: [],
      },
    ],
  });

  vi.spyOn(park as any, 'getPremierAccess').mockResolvedValue([]);
  vi.spyOn(park as any, 'getVirtualQueueData').mockResolvedValue([]);
  vi.spyOn(park as any, 'getWaitTimes').mockResolvedValue([
    // The wait feed carries World Premiere as a bare OPERATING row, which is
    // what would otherwise pull it back in through the live path.
    {id: 'P2FD03', status: 'OPERATING'},
    {id: 'P1RA03', status: 'OPERATING', postedWaitMinutes: 25},
  ]);
  vi.spyOn(park as any, 'getScheduleForDate').mockResolvedValue([
    {
      id: 'P2FD03',
      name: 'World Premiere',
      location: {id: 'P2'},
      schedules: [{date: '2026-08-20', startTime: '09:30', endTime: '22:00', status: 'OPERATING'}],
    },
  ]);

  return park;
}

describe('DLP ignored entities', () => {
  afterEach(() => vi.restoreAllMocks());

  it('does not publish World Premiere as an attraction', async () => {
    const entities = await stubbedPark().getEntities();

    expect(entities.find((e) => e.id === 'P2FD03')).toBeUndefined();
  });

  it('still publishes a real ride carrying the identical record shape', async () => {
    const entities = await stubbedPark().getEntities();

    const manor = entities.find((e) => e.id === 'P1RA03');
    expect(manor?.entityType).toBe('ATTRACTION');
  });

  it('keeps the land-entry pass out, so the mechanism is under test too', async () => {
    const entities = await stubbedPark().getEntities();

    expect(entities.find((e) => e.id === 'P2EA02')).toBeUndefined();
  });

  it('publishes no live row for an ignored id the wait feed still reports', async () => {
    const live = await stubbedPark().getLiveData();

    expect(live.find((l) => l.id === 'P2FD03')).toBeUndefined();
    expect(live.find((l) => l.id === 'P1RA03')).toBeDefined();
  });

  it('leaves no orphan schedule behind for an ignored id', async () => {
    const schedules = await stubbedPark().getSchedules();

    expect(schedules.find((s) => s.id === 'P2FD03')).toBeUndefined();
  });
});
