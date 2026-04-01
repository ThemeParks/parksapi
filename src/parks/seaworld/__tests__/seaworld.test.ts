/**
 * Unit tests for the SeaWorld / Busch Gardens TypeScript implementation.
 *
 * These tests use mock HTTP responses derived from real HAR data to verify:
 * - Entity list building (parks, attractions, shows, restaurants)
 * - Live data building (wait times, show times)
 * - Schedule building (operating hours)
 * - Correct use of localIsoFromFakeUtc for time handling
 * - Cache key prefix isolation across destinations
 */

import {
  SeaworldOrlando,
  SeaworldSanAntonio,
  SeaworldSanDiego,
  BuschGardensTampa,
  BuschGardensWilliamsburg,
} from '../seaworld.js';

// ---------------------------------------------------------------------------
// Minimal mock park detail fixture (SeaWorld Orlando UUID)
// ---------------------------------------------------------------------------
const MOCK_PARK_ID_SWO = 'AC3AF402-3C62-4893-8B05-822F19B9D2BC';
const MOCK_PARK_DETAIL_SWO = {
  Id: MOCK_PARK_ID_SWO,
  park_Name: 'SeaWorld Orlando',
  TimeZone: 'America/New_York',
  map_center: {Latitude: 28.41, Longitude: -81.46},
  POIs: {
    Rides: [
      {
        Id: 'ride-001',
        Name: 'Ice Breaker',
        Type: 'Rides',
        Coordinate: {Latitude: 28.411, Longitude: -81.461},
      },
    ],
    Slides: [
      {
        Id: 'slide-001',
        Name: 'Aquatica Slide',
        Type: 'Slides',
        Coordinate: {Latitude: 28.412, Longitude: -81.462},
      },
    ],
    Shows: [
      {
        Id: 'show-001',
        Name: 'Dolphin Theater',
        Type: 'Shows',
        Coordinate: {Latitude: 28.413, Longitude: -81.463},
      },
    ],
    Dining: [
      {
        Id: 'dining-001',
        Name: 'Sharks Underwater Grill',
        Type: 'Dining',
        Coordinate: {Latitude: 28.414, Longitude: -81.464},
      },
    ],
    // These should be skipped
    Services: [
      {Id: 'svc-001', Name: 'First Aid', Type: 'Services'},
    ],
    AnimalExperiences: [
      {Id: 'ae-001', Name: 'Dolphin Encounter', Type: 'Animal Experiences'},
    ],
  },
  open_hours: [
    {
      opens_at: '2026-04-01T09:00:00.0000000Z',
      closes_at: '2026-04-01T21:00:00.0000000Z',
      date: '04/01/2026',
    },
    {
      opens_at: '2026-04-02T09:00:00.0000000Z',
      closes_at: '2026-04-02T21:00:00.0000000Z',
      date: '04/02/2026',
    },
  ],
};

const MOCK_AVAILABILITY_SWO = {
  WaitTimes: [
    // Normal wait time
    {Id: 'ride-001', Minutes: 30, Status: '', StatusDisplay: null, Title: 'Ice Breaker', LastUpDateTime: '2026-04-01T10:00:00Z'},
    // Closed ride (negative minutes)
    {Id: 'ride-002', Minutes: -1, Status: '', StatusDisplay: null, Title: 'Closed Ride', LastUpDateTime: '2026-04-01T10:00:00Z'},
    // Zero wait time (walk-on)
    {Id: 'ride-003', Minutes: 0, Status: '', StatusDisplay: null, Title: 'Walk On Ride', LastUpDateTime: '2026-04-01T10:00:00Z'},
  ],
  ShowTimes: [
    // Show with actual times
    {
      Id: 'show-001',
      ShowTimes: [
        {
          StartDateTime: '2026-04-01T16:00:00Z',
          EndDateTime: '2026-04-01T16:30:00Z',
          StartTime: '2026-04-01T12:00:00',
          EndTime: '2026-04-01T12:30:00',
        },
      ],
    },
    // Show with no times
    {Id: 'show-002', ShowTimes: []},
  ],
};

// ---------------------------------------------------------------------------
// Helper to create an instance with mocked HTTP
// ---------------------------------------------------------------------------
function createMockedOrlando() {
  const park = new SeaworldOrlando();

  // Mock getParkDetail to return our fixture only for the SWO park
  // and a minimal fixture for Aquatica
  park.getParkDetail = async (parkId: string) => {
    if (parkId === MOCK_PARK_ID_SWO) {
      return MOCK_PARK_DETAIL_SWO as any;
    }
    // Aquatica minimal
    return {
      Id: '4B040706-968A-41B4-9967-D93C7814E665',
      park_Name: 'Aquatica Orlando',
      TimeZone: 'America/New_York',
      map_center: {Latitude: 28.42, Longitude: -81.47},
      POIs: {Rides: [], Shows: [], Dining: [], Slides: []},
      open_hours: [],
    } as any;
  };

  // Mock getAvailability
  park.getAvailability = async (_parkId: string, _searchDate: string) => {
    return MOCK_AVAILABILITY_SWO as any;
  };

  return park;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SeaworldOrlando', () => {
  describe('destination registration', () => {
    it('has correct destinationId', () => {
      const park = new SeaworldOrlando();
      expect(park.destinationId).toBe('seaworldorlandoresort');
    });

    it('has correct timezone', () => {
      const park = new SeaworldOrlando();
      expect(park.timezone).toBe('America/New_York');
    });

    it('has two resort IDs', () => {
      const park = new SeaworldOrlando();
      expect(park.resortIds).toHaveLength(2);
      expect(park.resortIds[0]).toBe('AC3AF402-3C62-4893-8B05-822F19B9D2BC');
      expect(park.resortIds[1]).toBe('4B040706-968A-41B4-9967-D93C7814E665');
    });

    it('getCacheKeyPrefix returns destination-specific prefix', () => {
      const park = new SeaworldOrlando();
      expect(park.getCacheKeyPrefix()).toBe('seaworld:seaworldorlandoresort');
    });
  });

  describe('getDestinations', () => {
    it('returns destination entity with correct fields', async () => {
      const park = createMockedOrlando();
      const destinations = await park.getDestinations();
      expect(destinations).toHaveLength(1);
      const dest = destinations[0];
      expect(dest.id).toBe('seaworldorlandoresort');
      expect(dest.name).toBe('SeaWorld Parks and Resorts Orlando');
      expect(dest.entityType).toBe('DESTINATION');
      expect(dest.timezone).toBe('America/New_York');
    });

    it('includes location from first park map_center', async () => {
      const park = createMockedOrlando();
      const destinations = await park.getDestinations();
      expect(destinations[0].location).toBeDefined();
      expect(destinations[0].location?.latitude).toBeCloseTo(28.41);
    });
  });

  describe('buildEntityList', () => {
    it('includes destination, parks, attractions (rides+slides), shows, restaurants', async () => {
      const park = createMockedOrlando();
      const entities = await (park as any).buildEntityList();

      const byType = (type: string) => entities.filter((e: any) => e.entityType === type);

      expect(byType('DESTINATION')).toHaveLength(1);
      expect(byType('PARK')).toHaveLength(2); // SWO + Aquatica
      expect(byType('ATTRACTION')).toHaveLength(2); // 1 ride + 1 slide (SWO only)
      expect(byType('SHOW')).toHaveLength(1);
      expect(byType('RESTAURANT')).toHaveLength(1);
    });

    it('does not include Services or AnimalExperiences', async () => {
      const park = createMockedOrlando();
      const entities = await (park as any).buildEntityList();
      const ids = entities.map((e: any) => e.id);
      expect(ids).not.toContain('svc-001');
      expect(ids).not.toContain('ae-001');
    });

    it('entity IDs are strings (UUIDs preserved)', async () => {
      const park = createMockedOrlando();
      const entities = await (park as any).buildEntityList();
      for (const entity of entities) {
        expect(typeof entity.id).toBe('string');
      }
    });

    it('park entity has correct parentId (destinationId)', async () => {
      const park = createMockedOrlando();
      const entities = await (park as any).buildEntityList();
      const parkEntity = entities.find((e: any) => e.id === MOCK_PARK_ID_SWO);
      expect(parkEntity).toBeDefined();
      expect(parkEntity.parentId).toBe('seaworldorlandoresort');
      expect(parkEntity.entityType).toBe('PARK');
    });

    it('attraction has correct parentId (parkId)', async () => {
      const park = createMockedOrlando();
      const entities = await (park as any).buildEntityList();
      const rideEntity = entities.find((e: any) => e.id === 'ride-001');
      expect(rideEntity).toBeDefined();
      expect(rideEntity.parentId).toBe(MOCK_PARK_ID_SWO);
      expect(rideEntity.entityType).toBe('ATTRACTION');
    });

    it('entities include location when Coordinate is present', async () => {
      const park = createMockedOrlando();
      const entities = await (park as any).buildEntityList();
      const ride = entities.find((e: any) => e.id === 'ride-001');
      expect(ride.location).toBeDefined();
      expect(ride.location.latitude).toBeCloseTo(28.411);
      expect(ride.location.longitude).toBeCloseTo(-81.461);
    });
  });

  describe('buildLiveData', () => {
    it('returns live data for rides with positive wait times', async () => {
      const park = createMockedOrlando();
      const liveData = await (park as any).buildLiveData();
      const ride001 = liveData.find((ld: any) => ld.id === 'ride-001');
      expect(ride001).toBeDefined();
      expect(ride001.status).toBe('OPERATING');
      expect(ride001.queue?.STANDBY?.waitTime).toBe(30);
    });

    it('marks rides with negative minutes as CLOSED', async () => {
      const park = createMockedOrlando();
      const liveData = await (park as any).buildLiveData();
      const ride002 = liveData.find((ld: any) => ld.id === 'ride-002');
      expect(ride002).toBeDefined();
      expect(ride002.status).toBe('CLOSED');
    });

    it('handles zero wait time (walk-on) as OPERATING', async () => {
      const park = createMockedOrlando();
      const liveData = await (park as any).buildLiveData();
      const ride003 = liveData.find((ld: any) => ld.id === 'ride-003');
      expect(ride003).toBeDefined();
      expect(ride003.status).toBe('OPERATING');
      expect(ride003.queue?.STANDBY?.waitTime).toBe(0);
    });

    it('includes show times for shows with data', async () => {
      const park = createMockedOrlando();
      const liveData = await (park as any).buildLiveData();
      const show001 = liveData.find((ld: any) => ld.id === 'show-001');
      expect(show001).toBeDefined();
      expect(show001.status).toBe('OPERATING');
      expect(show001.showtimes).toHaveLength(1);
    });

    it('does not mark shows without ShowTimes as OPERATING', async () => {
      const park = createMockedOrlando();
      const liveData = await (park as any).buildLiveData();
      const show002 = liveData.find((ld: any) => ld.id === 'show-002');
      // show-002 has empty ShowTimes array — no status override happens
      // It may or may not appear; if it does appear it should be CLOSED (default)
      if (show002) {
        expect(show002.status).toBe('CLOSED');
      }
    });

    it('show start/end times are correctly formatted with timezone offset', async () => {
      const park = createMockedOrlando();
      const liveData = await (park as any).buildLiveData();
      const show001 = liveData.find((ld: any) => ld.id === 'show-001');
      // StartTime: '2026-04-01T12:00:00' in America/New_York (EDT = -04:00)
      // Expected: '2026-04-01T12:00:00-04:00'
      expect(show001.showtimes[0].startTime).toMatch(/^2026-04-01T12:00:00/);
      expect(show001.showtimes[0].startTime).toContain('-04:00');
      expect(show001.showtimes[0].type).toBe('Performance');
    });
  });

  describe('buildSchedules', () => {
    it('returns schedule for each park with open_hours', async () => {
      const park = createMockedOrlando();
      const schedules = await (park as any).buildSchedules();
      const swoSchedule = schedules.find((s: any) => s.id === MOCK_PARK_ID_SWO);
      expect(swoSchedule).toBeDefined();
      expect(swoSchedule.schedule).toHaveLength(2);
    });

    it('schedule entries have correct date and times with timezone offset', async () => {
      const park = createMockedOrlando();
      const schedules = await (park as any).buildSchedules();
      const swoSchedule = schedules.find((s: any) => s.id === MOCK_PARK_ID_SWO);
      const firstDay = swoSchedule.schedule[0];
      // opens_at: '2026-04-01T09:00:00Z' parsed as local 09:00 → '2026-04-01T09:00:00-04:00'
      expect(firstDay.date).toBe('2026-04-01');
      expect(firstDay.openingTime).toMatch(/^2026-04-01T09:00:00/);
      expect(firstDay.openingTime).toContain('-04:00');
      expect(firstDay.closingTime).toMatch(/^2026-04-01T21:00:00/);
      expect(firstDay.type).toBe('OPERATING');
    });
  });
});

// ---------------------------------------------------------------------------
// Cross-destination isolation tests
// ---------------------------------------------------------------------------

describe('Cache key prefix isolation', () => {
  it('each destination has a unique cache key prefix', () => {
    const parks = [
      new SeaworldOrlando(),
      new SeaworldSanAntonio(),
      new SeaworldSanDiego(),
      new BuschGardensTampa(),
      new BuschGardensWilliamsburg(),
    ];
    const prefixes = parks.map(p => p.getCacheKeyPrefix());
    const uniquePrefixes = new Set(prefixes);
    expect(uniquePrefixes.size).toBe(parks.length);
  });
});

// ---------------------------------------------------------------------------
// Subclass registration tests
// ---------------------------------------------------------------------------

describe('Destination subclasses', () => {
  it('SeaworldSanAntonio has correct config', () => {
    const park = new SeaworldSanAntonio();
    expect(park.destinationId).toBe('seaworldsanantonio');
    expect(park.timezone).toBe('America/Chicago');
    expect(park.resortIds).toHaveLength(1);
    expect(park.resortIds[0]).toBe('F4040D22-8B8D-4394-AEC7-D05FA5DEA945');
  });

  it('SeaworldSanDiego has correct config', () => {
    const park = new SeaworldSanDiego();
    expect(park.destinationId).toBe('seaworldsandiego');
    expect(park.timezone).toBe('America/Los_Angeles');
    expect(park.resortIds[0]).toBe('4325312F-FDF1-41FF-ABF4-361A4FF03443');
  });

  it('BuschGardensTampa has correct config', () => {
    const park = new BuschGardensTampa();
    expect(park.destinationId).toBe('buschgardenstampa');
    expect(park.timezone).toBe('America/New_York');
    expect(park.resortIds[0]).toBe('C001866B-555D-4E92-B48E-CC67E195DE96');
  });

  it('BuschGardensWilliamsburg preserves legacy destinationId typo', () => {
    const park = new BuschGardensWilliamsburg();
    // "willamsburg" — one 'l' — matches JS implementation
    expect(park.destinationId).toBe('buschgardenswillamsburg');
    expect(park.resortIds[0]).toBe('45FE1F31-D4E4-4B1E-90E0-5255111070F2');
  });
});
