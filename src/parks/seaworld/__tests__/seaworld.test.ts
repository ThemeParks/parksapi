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
  SesamePlacePhiladelphia,
  SesamePlaceSanDiego,
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
    Pools: [
      {
        Id: 'pool-001',
        Name: 'Roa’s Rapids',
        Type: 'Pools',
        Coordinate: {Latitude: 28.415, Longitude: -81.465},
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
    // Water-park amenities that sit alongside Pools/Slides and must NOT be
    // promoted to attractions when Pools is.
    Cabanas: [
      {Id: 'cab-001', Name: 'Private Cabana 12', Type: 'Cabanas'},
    ],
    Restrooms: [
      {Id: 'wc-001', Name: 'Restroom', Type: 'Restrooms'},
    ],
    Shops: [
      {Id: 'shop-001', Name: 'Gift Shop', Type: 'Shops'},
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
  // Each sibling park returns its OWN Id. Returning a shared fixture for every
  // non-SWO UUID would collapse Aquatica and Discovery Cove onto one entity id
  // and hide a duplicate-park bug rather than expose it.
  const SIBLINGS: Record<string, string> = {
    '4B040706-968A-41B4-9967-D93C7814E665': 'Aquatica Orlando',
    '1FB04DFC-B6C0-4918-BE36-EE6DD14FE741': 'Discovery Cove Orlando',
  };
  park.getParkDetail = async (parkId: string) => {
    if (parkId === MOCK_PARK_ID_SWO) {
      return MOCK_PARK_DETAIL_SWO as any;
    }
    return {
      Id: parkId,
      park_Name: SIBLINGS[parkId] ?? 'Unknown Park',
      TimeZone: 'America/New_York',
      map_center: {Latitude: 28.42, Longitude: -81.47},
      POIs: {Rides: [], Shows: [], Dining: [], Slides: [], Pools: []},
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

    it('has three resort IDs', () => {
      const park = new SeaworldOrlando();
      expect(park.resortIds).toHaveLength(3);
      expect(park.resortIds[0]).toBe('AC3AF402-3C62-4893-8B05-822F19B9D2BC');
      expect(park.resortIds[1]).toBe('4B040706-968A-41B4-9967-D93C7814E665');
      expect(park.resortIds[2]).toBe('1FB04DFC-B6C0-4918-BE36-EE6DD14FE741');
    });

    it('keeps SeaWorld Orlando first so the destination pin does not move', () => {
      // getDestinations() reads map_center off resortIds[0]. A reorder here
      // would relocate the destination without failing anything else.
      const park = new SeaworldOrlando();
      expect(park.resortIds[0]).toBe('AC3AF402-3C62-4893-8B05-822F19B9D2BC');
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
    it('includes destination, parks, attractions (rides+slides+pools), shows, restaurants', async () => {
      const park = createMockedOrlando();
      const entities = await (park as any).buildEntityList();

      const byType = (type: string) => entities.filter((e: any) => e.entityType === type);

      expect(byType('DESTINATION')).toHaveLength(1);
      expect(byType('PARK')).toHaveLength(3); // SWO + Aquatica + Discovery Cove
      expect(byType('ATTRACTION')).toHaveLength(3); // 1 ride + 1 slide + 1 pool (SWO only)
      expect(byType('SHOW')).toHaveLength(1);
      expect(byType('RESTAURANT')).toHaveLength(1);
    });

    it('emits one PARK per resort ID with distinct ids', async () => {
      const park = createMockedOrlando();
      const entities = await (park as any).buildEntityList();
      const parkIds = entities.filter((e: any) => e.entityType === 'PARK').map((e: any) => e.id);
      expect(new Set(parkIds).size).toBe(parkIds.length);
      expect(parkIds).toEqual(park.resortIds);
    });

    it('maps Pools as a RIDE attraction (water-park headline items)', async () => {
      const park = createMockedOrlando();
      const entities = await (park as any).buildEntityList();
      const pool = entities.find((e: any) => e.id === 'pool-001');
      expect(pool).toBeDefined();
      expect(pool.entityType).toBe('ATTRACTION');
      expect(pool.attractionType).toBe('RIDE');
      expect(pool.parentId).toBe(MOCK_PARK_ID_SWO);
    });

    it('does not include Services or AnimalExperiences', async () => {
      const park = createMockedOrlando();
      const entities = await (park as any).buildEntityList();
      const ids = entities.map((e: any) => e.id);
      expect(ids).not.toContain('svc-001');
      expect(ids).not.toContain('ae-001');
    });

    it('does not promote water-park amenities alongside Pools', async () => {
      // Cabanas outnumber every real attraction at these parks (45 at Adventure
      // Island). Letting them through would swamp the park with rentals.
      const park = createMockedOrlando();
      const entities = await (park as any).buildEntityList();
      const ids = entities.map((e: any) => e.id);
      expect(ids).not.toContain('cab-001');
      expect(ids).not.toContain('wc-001');
      expect(ids).not.toContain('shop-001');
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

  // -------------------------------------------------------------------------
  // Regression: upstream 403 on one park UUID must not take its siblings down.
  //
  // All three Orlando parks share one upstream. src/http.ts treats 4xx as
  // non-retryable, so a bot-protection block rejects immediately; before the
  // fix the unguarded `await` in the resortIds loop propagated that rejection
  // and buildLiveData() emitted nothing for the entire destination.
  // -------------------------------------------------------------------------
  describe('per-park failure isolation', () => {
    const DISCOVERY_COVE = '1FB04DFC-B6C0-4918-BE36-EE6DD14FE741';

    // Reject for one park UUID only; the others keep serving the fixture.
    function failOnePark(park: any, failingParkId: string) {
      park.getAvailability = async (parkId: string) => {
        if (parkId === failingParkId) {
          throw new Error('Request failed with status code 403');
        }
        return MOCK_AVAILABILITY_SWO as any;
      };
    }

    it('still returns sibling park live data when one park 403s', async () => {
      const park = createMockedOrlando();
      failOnePark(park, DISCOVERY_COVE);

      const liveData = await (park as any).buildLiveData();

      // SeaWorld Orlando's own rides must still report.
      const ride001 = liveData.find((ld: any) => ld.id === 'ride-001');
      expect(ride001).toBeDefined();
      expect(ride001.status).toBe('OPERATING');
      expect(ride001.queue.STANDBY.waitTime).toBe(30);
    });

    it('returns an empty list rather than throwing when every park 403s', async () => {
      const park = createMockedOrlando();
      park.getAvailability = async () => {
        throw new Error('Request failed with status code 403');
      };

      // No rows is correct here: emitting a fabricated CLOSED for a park we
      // cannot see would push invented state to the wiki.
      await expect((park as any).buildLiveData()).resolves.toEqual([]);
    });

    // The next two guard the deliberate asymmetry. The collector diffs the
    // entity list and issues DELETE v1/entity/<id> for anything missing, so
    // swallowing a failure here would delete the failed park's entities from
    // the wiki. These must keep throwing.
    it('buildEntityList still throws when a park fetch fails', async () => {
      const park = createMockedOrlando();
      park.getParkDetail = async (parkId: string) => {
        if (parkId === DISCOVERY_COVE) {
          throw new Error('Request failed with status code 403');
        }
        return MOCK_PARK_DETAIL_SWO as any;
      };

      await expect((park as any).buildEntityList()).rejects.toThrow(/403/);
    });

    it('buildSchedules still throws when a park fetch fails', async () => {
      const park = createMockedOrlando();
      park.getParkDetail = async (parkId: string) => {
        if (parkId === DISCOVERY_COVE) {
          throw new Error('Request failed with status code 403');
        }
        return MOCK_PARK_DETAIL_SWO as any;
      };

      await expect((park as any).buildSchedules()).rejects.toThrow(/403/);
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
      new SesamePlacePhiladelphia(),
      new SesamePlaceSanDiego(),
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
    expect(park.resortIds).toHaveLength(2);
    expect(park.resortIds[0]).toBe('F4040D22-8B8D-4394-AEC7-D05FA5DEA945');
    expect(park.resortIds[1]).toBe('04668F50-A57E-4DE6-8E70-D4567D9B46B5'); // Aquatica SA
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
    expect(park.resortIds).toHaveLength(2);
    expect(park.resortIds[0]).toBe('C001866B-555D-4E92-B48E-CC67E195DE96');
    expect(park.resortIds[1]).toBe('770E691C-E6DA-4264-AF27-863189380D0B'); // Adventure Island
  });

  it('BuschGardensWilliamsburg preserves legacy destinationId typo', () => {
    const park = new BuschGardensWilliamsburg();
    // "willamsburg" — one 'l' — matches JS implementation
    expect(park.destinationId).toBe('buschgardenswillamsburg');
    expect(park.resortIds).toHaveLength(2);
    expect(park.resortIds[0]).toBe('45FE1F31-D4E4-4B1E-90E0-5255111070F2');
    expect(park.resortIds[1]).toBe('66480532-A73C-4617-9B2D-EDC4430CAB86'); // Water Country USA
  });

  it('SesamePlacePhiladelphia has correct config', () => {
    const park = new SesamePlacePhiladelphia();
    expect(park.destinationId).toBe('sesameplacephiladelphia');
    expect(park.destinationName).toBe('Sesame Place Philadelphia');
    expect(park.timezone).toBe('America/New_York');
    expect(park.resortIds).toEqual(['F7408854-28CB-4B1E-98E5-4449FE600E85']);
  });

  it('SesamePlaceSanDiego has correct config', () => {
    const park = new SesamePlaceSanDiego();
    expect(park.destinationId).toBe('sesameplacesandiego');
    expect(park.destinationName).toBe('Sesame Place San Diego');
    expect(park.timezone).toBe('America/Los_Angeles');
    expect(park.resortIds).toEqual(['A988F4CE-6A81-4527-9535-DDB378689E52']);
  });
});

describe('Park UUID assignment across destinations', () => {
  const ALL = () => [
    new SeaworldOrlando(),
    new SeaworldSanAntonio(),
    new SeaworldSanDiego(),
    new BuschGardensTampa(),
    new BuschGardensWilliamsburg(),
    new SesamePlacePhiladelphia(),
    new SesamePlaceSanDiego(),
  ];

  it('assigns every park UUID to exactly one destination', () => {
    // A UUID pasted into two destinations would publish the same PARK twice
    // under different parents, and the collector would see it flap between them.
    const all = ALL().flatMap((p) => p.resortIds);
    expect(new Set(all).size).toBe(all.length);
  });

  it('covers all 12 parks the operator publishes', () => {
    expect(ALL().flatMap((p) => p.resortIds)).toHaveLength(12);
  });

  it('gives every destination a unique id and at least one park', () => {
    const parks = ALL();
    const ids = parks.map((p) => p.destinationId);
    expect(new Set(ids).size).toBe(parks.length);
    for (const p of parks) expect(p.resortIds.length).toBeGreaterThan(0);
  });
});

describe('SeaworldDestination.buildSchedules — event hours vs normal hours', () => {
  const AQUATICA_ID = '4B040706-968A-41B4-9967-D93C7814E665';

  // Build an Orlando instance whose Aquatica park returns the given open_hours.
  function orlandoWithAquaticaHours(
    openHours: Array<{opens_at: string; closes_at: string; date: string}>,
  ) {
    const park = new SeaworldOrlando();
    park.resortIds = [AQUATICA_ID];
    park.getParkDetail = (async (parkId: string) =>
      ({
        Id: parkId,
        park_Name: 'Aquatica Orlando',
        TimeZone: 'America/New_York',
        map_center: {Latitude: 28.42, Longitude: -81.47},
        POIs: {Rides: [], Shows: [], Dining: [], Slides: []},
        open_hours: openHours,
      }) as any) as typeof park.getParkDetail;
    return park;
  }

  async function schedFor(park: SeaworldOrlando, date: string) {
    const scheds = await (park as any).buildSchedules();
    const aq = scheds.find((s: any) => String(s.id).toUpperCase() === AQUATICA_ID);
    return (aq?.schedule ?? []).filter((e: any) => e.date === date);
  }

  it('types the evening event block as TICKETED_EVENT, not a second OPERATING', async () => {
    // Real Aquatica summer-night shape: 9am–7:30pm normal, then 8–11pm event.
    const park = orlandoWithAquaticaHours([
      {opens_at: '2026-07-23T09:00:00.0000000Z', closes_at: '2026-07-23T19:30:00.0000000Z', date: '07/23/2026'},
      {opens_at: '2026-07-23T20:00:00.0000000Z', closes_at: '2026-07-23T23:00:00.0000000Z', date: '07/23/2026'},
    ]);
    const day = await schedFor(park, '2026-07-23');

    expect(day).toHaveLength(2);
    const operating = day.filter((e: any) => e.type === 'OPERATING');
    const events = day.filter((e: any) => e.type === 'TICKETED_EVENT');
    // Exactly one OPERATING (the real 9–7:30 hours), one event (8–11pm).
    expect(operating).toHaveLength(1);
    expect(operating[0].openingTime).toContain('T09:00:00');
    expect(operating[0].closingTime).toContain('T19:30:00');
    expect(events).toHaveLength(1);
    expect(events[0].openingTime).toContain('T20:00:00');
  });

  it('leaves a single-block day as OPERATING', async () => {
    const park = orlandoWithAquaticaHours([
      {opens_at: '2026-07-26T09:00:00.0000000Z', closes_at: '2026-07-26T19:00:00.0000000Z', date: '07/26/2026'},
    ]);
    const day = await schedFor(park, '2026-07-26');
    expect(day).toHaveLength(1);
    expect(day[0].type).toBe('OPERATING');
  });

  it('picks the daytime session as OPERATING regardless of API ordering', async () => {
    // Event listed before the normal block — order must not decide the type.
    const park = orlandoWithAquaticaHours([
      {opens_at: '2026-07-24T20:00:00.0000000Z', closes_at: '2026-07-24T23:00:00.0000000Z', date: '07/24/2026'},
      {opens_at: '2026-07-24T09:00:00.0000000Z', closes_at: '2026-07-24T19:30:00.0000000Z', date: '07/24/2026'},
    ]);
    const day = await schedFor(park, '2026-07-24');
    const operating = day.filter((e: any) => e.type === 'OPERATING');
    expect(operating).toHaveLength(1);
    expect(operating[0].openingTime).toContain('T09:00:00');
  });

  it('classifies a pre-opening early-entry event as TICKETED_EVENT, not OPERATING', async () => {
    // Event OPENS BEFORE normal hours — "earliest block" would invert this.
    const park = orlandoWithAquaticaHours([
      {opens_at: '2026-07-24T07:00:00.0000000Z', closes_at: '2026-07-24T09:00:00.0000000Z', date: '07/24/2026'},
      {opens_at: '2026-07-24T09:00:00.0000000Z', closes_at: '2026-07-24T19:30:00.0000000Z', date: '07/24/2026'},
    ]);
    const day = await schedFor(park, '2026-07-24');
    const operating = day.filter((e: any) => e.type === 'OPERATING');
    const events = day.filter((e: any) => e.type === 'TICKETED_EVENT');
    expect(operating).toHaveLength(1);
    expect(operating[0].openingTime).toContain('T09:00:00'); // the real daytime session
    expect(events).toHaveLength(1);
    expect(events[0].openingTime).toContain('T07:00:00');
  });

  it('classifies a midnight-start event as TICKETED_EVENT, not OPERATING', async () => {
    const park = orlandoWithAquaticaHours([
      {opens_at: '2026-07-24T00:00:00.0000000Z', closes_at: '2026-07-24T03:00:00.0000000Z', date: '07/24/2026'},
      {opens_at: '2026-07-24T09:00:00.0000000Z', closes_at: '2026-07-24T19:30:00.0000000Z', date: '07/24/2026'},
    ]);
    const day = await schedFor(park, '2026-07-24');
    const operating = day.filter((e: any) => e.type === 'OPERATING');
    expect(operating).toHaveLength(1);
    expect(operating[0].openingTime).toContain('T09:00:00');
    expect(day.filter((e: any) => e.type === 'TICKETED_EVENT')[0].openingTime).toContain('T00:00:00');
  });

  it('keeps the daytime session OPERATING even when it is shorter than the event', async () => {
    // Short shoulder-season day (4h) + longer evening event (5h): duration alone
    // would misclassify, but the midday-overlapping block is still operating.
    const park = orlandoWithAquaticaHours([
      {opens_at: '2026-07-24T10:00:00.0000000Z', closes_at: '2026-07-24T14:00:00.0000000Z', date: '07/24/2026'},
      {opens_at: '2026-07-24T18:00:00.0000000Z', closes_at: '2026-07-24T23:00:00.0000000Z', date: '07/24/2026'},
    ]);
    const day = await schedFor(park, '2026-07-24');
    const operating = day.filter((e: any) => e.type === 'OPERATING');
    expect(operating).toHaveLength(1);
    expect(operating[0].openingTime).toContain('T10:00:00');
  });

  it('crossing-midnight event that opens in the evening stays TICKETED_EVENT (not clamped, <25h)', async () => {
    const park = orlandoWithAquaticaHours([
      {opens_at: '2026-07-24T09:00:00.0000000Z', closes_at: '2026-07-24T19:00:00.0000000Z', date: '07/24/2026'},
      {opens_at: '2026-07-24T20:00:00.0000000Z', closes_at: '2026-07-25T01:00:00.0000000Z', date: '07/24/2026'},
    ]);
    const day = await schedFor(park, '2026-07-24');
    const events = day.filter((e: any) => e.type === 'TICKETED_EVENT');
    expect(events).toHaveLength(1);
    expect(events[0].openingTime).toContain('T20:00:00');
    expect(events[0].closingTime).toContain('2026-07-25T01:00:00'); // 5h overnight close preserved
  });

  it('clamps a >25h source glitch (next-day close on a daytime block) back to the same day', async () => {
    // Real SeaWorld Orlando glitch on Howl-O-Scream dates: opens 09/18 09:00 but
    // closes_at is dated 09/19 → a bogus 34h "operating" span.
    const park = orlandoWithAquaticaHours([
      {opens_at: '2026-09-18T09:00:00.0000000Z', closes_at: '2026-09-19T19:00:00.0000000Z', date: '09/18/2026'},
    ]);
    const day = await schedFor(park, '2026-09-18');
    expect(day).toHaveLength(1);
    expect(day[0].type).toBe('OPERATING');
    // Rolled back one day: 09:00–19:00 same day, not 34h.
    expect(day[0].closingTime).toContain('2026-09-18T19:00:00');
  });
});
