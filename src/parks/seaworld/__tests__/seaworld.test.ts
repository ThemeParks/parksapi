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

/**
 * Stamps are US Eastern wall time with no zone suffix — that is the real shape
 * for readings and closures (the fractional `…Z` form only ever appears on
 * no-reading rows). These sit a few minutes before CLOCK_PARK_OPEN, which is
 * 14:00 Eastern, matching the 3-minute median age measured in the wild.
 */
const FRESH_STAMP = '2026-08-15T13:57:00';
/** Same shape, but hours old — the frozen-value case. */
const STALE_STAMP = '2026-08-15T09:30:00';
/**
 * Fresh against CLOCK_PARK_SHUT (23:00 Eastern) rather than the open clock.
 * Models the two things that actually happen after close: the feed refreshing a
 * 0 every few minutes, and a genuinely live reading during an unlisted event.
 */
const FRESH_STAMP_NIGHT = '2026-08-15T22:57:00';

// Field shapes match the five combinations seen across a 41-round census
// (5002 observations, 2026-08-15). Note measured rows carry StatusDisplay: ''
// while no-reading rows carry null — the API distinguishes them, so the
// fixture does too:
//   Status non-empty          -> genuinely closed        (842 obs)
//   Minutes >= 0, Display ''  -> operating with a reading (1890 obs)
//   Minutes < 0, Display null -> no current reading       (2270 obs, 45%)
const MOCK_AVAILABILITY_SWO = {
  WaitTimes: [
    // Normal wait time
    {Id: 'ride-001', Minutes: 30, Status: '', StatusDisplay: '', Title: 'Ice Breaker', LastUpDateTime: FRESH_STAMP},
    // No current reading: -1 sentinel with a blank status. NOT a closure.
    {Id: 'ride-002', Minutes: -1, Status: '', StatusDisplay: null, Title: 'Unmeasured Ride', LastUpDateTime: FRESH_STAMP},
    // Zero wait time (walk-on)
    {Id: 'ride-003', Minutes: 0, Status: '', StatusDisplay: '', Title: 'Walk On Ride', LastUpDateTime: FRESH_STAMP},
    // Genuinely closed, with the closure reason in both status fields
    {Id: 'ride-004', Minutes: -1, Status: 'Closed Temporarily', StatusDisplay: 'Closed Temporarily', Title: 'Closed Ride', LastUpDateTime: FRESH_STAMP},
    // Closure string that did not exist when this park was first implemented —
    // guards against anyone reintroducing a hardcoded list of known strings
    {Id: 'ride-005', Minutes: -1, Status: 'Closed Due To Weather', StatusDisplay: 'Closed Due To Weather', Title: 'Weathered Ride', LastUpDateTime: FRESH_STAMP},
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
// Operating-hours helpers
//
// An unmeasured ride reads as open or closed depending on whether the park is
// operating, so those tests pin BOTH the hours and the clock. An earlier
// version derived the window from Date.now(), which failed for the 60 minutes
// of the DST fall-back when the ambiguous wall clock resolved to the earlier
// offset and the window stopped bracketing now. Gate tests must never be flaky,
// so the clock is injected instead.
// ---------------------------------------------------------------------------

/** Local 09:00-21:00 on 2026-08-15, in "fake UTC" (local wall time with a Z). */
const HOURS_TODAY = [
  {opens_at: '2026-08-15T09:00:00.0000000Z', closes_at: '2026-08-15T21:00:00.0000000Z', date: '08/15/2026'},
];

/** 14:00 America/New_York — inside HOURS_TODAY. */
const CLOCK_PARK_OPEN = new Date('2026-08-15T18:00:00Z');
/**
 * 23:00 America/New_York on the same local day — after the 21:00 close, which
 * is the window this whole change is about. Still the same calendar day, so
 * today's hours are present and the park is simply shut rather than unknown.
 */
const CLOCK_PARK_SHUT = new Date('2026-08-16T03:00:00Z');

function pinClock(at: Date) {
  vi.useFakeTimers({toFake: ['Date']});
  vi.setSystemTime(at);
}

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

  // Mock getAvailability, per park. Returning the SWO fixture for every resort
  // id (as this used to) made the wait-time rows get processed three times, and
  // the last park's verdict overwrote the first two. That silently defanged the
  // closure tests: deleting closure detection entirely still left them green,
  // because they were really asserting Discovery Cove's no-hours fallback.
  // The real feed returns each park's own rides, so mirror that.
  park.getAvailability = async (parkId: string, _searchDate: string) => {
    if (parkId === MOCK_PARK_ID_SWO) return MOCK_AVAILABILITY_SWO as any;
    return {WaitTimes: [], ShowTimes: []} as any;
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
    // A reading is only published when the park is demonstrably operating, so
    // these need a fixed "now" that the fixture's stamps are fresh against.
    beforeEach(() => pinClock(CLOCK_PARK_OPEN));
    afterEach(() => vi.useRealTimers());

    it('returns live data for rides with positive wait times', async () => {
      const park = createMockedOrlando();
      const liveData = await (park as any).buildLiveData();
      const ride001 = liveData.find((ld: any) => ld.id === 'ride-001');
      expect(ride001).toBeDefined();
      expect(ride001.status).toBe('OPERATING');
      expect(ride001.queue?.STANDBY?.waitTime).toBe(30);
    });

    it('treats a -1 with blank status as "no reading", not a closure', async () => {
      // Pin the park open: the no-reading state is read against operating hours.
      pinClock(CLOCK_PARK_OPEN);
      const park = createMockedOrlando();
      const detail = (park as any).getParkDetail;
      (park as any).getParkDetail = async (id: string) => ({
        ...(await detail(id)), open_hours: HOURS_TODAY,
      });
      const liveData = await (park as any).buildLiveData();
      const ride002 = liveData.find((ld: any) => ld.id === 'ride-002');
      expect(ride002).toBeDefined();
      // The ride is open, we simply have no wait time for it. Publishing CLOSED
      // here mislabelled 59 of 122 rides in a sampled round family-wide and,
      // worse, meant a ride
      // already showing CLOSED produced no visible change when it really closed.
      expect(ride002.status).toBe('OPERATING');
      expect(ride002.queue?.STANDBY?.waitTime).toBeNull();
    });

    it('marks a ride carrying a closure status as CLOSED', async () => {
      const park = createMockedOrlando();
      const liveData = await (park as any).buildLiveData();
      const ride004 = liveData.find((ld: any) => ld.id === 'ride-004');
      expect(ride004).toBeDefined();
      expect(ride004.status).toBe('CLOSED');
      expect(ride004.queue?.STANDBY?.waitTime).toBeNull();
    });

    it('honours a closure string it has never seen before', async () => {
      const park = createMockedOrlando();
      const liveData = await (park as any).buildLiveData();
      const ride005 = liveData.find((ld: any) => ld.id === 'ride-005');
      expect(ride005).toBeDefined();
      expect(ride005.status).toBe('CLOSED');
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
  // Regression: the three wait-time states must stay distinct.
  //
  // OBSERVED_SEQUENCE below is a real transition from a 41-round census (5002
  // observations, 2026-08-15). Other rows in this block are deliberately
  // defensive shapes that the census never produced (blank Status with only
  // StatusDisplay set, a missing Minutes field, whitespace) — they pin
  // behaviour the code claims to have rather than behaviour the feed exhibits.
  // -------------------------------------------------------------------------
  describe('wait-time state semantics', () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    function availabilityWith(waitTimes: any[]) {
      return {WaitTimes: waitTimes, ShowTimes: []};
    }

    /**
     * `open` controls whether the pinned clock falls inside published operating
     * hours, which is what decides how an unmeasured ride is read. `hours` lets
     * a test supply its own blocks (events, corrupt spans).
     */
    function parkReturning(waitTimes: any[], open = true, hours: any[] = HOURS_TODAY) {
      pinClock(open ? CLOCK_PARK_OPEN : CLOCK_PARK_SHUT);
      const park = createMockedOrlando();
      (park as any).getAvailability = async () => availabilityWith(waitTimes) as any;
      (park as any).getParkDetail = async () => ({
        ...MOCK_PARK_DETAIL_SWO,
        open_hours: hours,
      }) as any;
      return park;
    }

    // Observed: Elmo's Choo Choo Train, Slimey's Slider and Sunny Day Carousel
    // each ran norecord (18:30Z) -> Closed Due To Weather (20:41Z) -> 0 min
    // (21:52Z). The same ride is unmeasured, then closed, then reporting — so
    // the states are distinct and none of them is a permanent ride property.
    const OBSERVED_SEQUENCE = [
      {
        label: 'no reading',
        row: {Id: 'r', Minutes: -1, Status: '', StatusDisplay: null, Title: 'Sunny Day Carousel', LastUpDateTime: 'x'},
        expected: {status: 'OPERATING', waitTime: null},
      },
      {
        label: 'weather closure',
        row: {Id: 'r', Minutes: -1, Status: 'Closed Due To Weather', StatusDisplay: 'Closed Due To Weather', Title: 'Sunny Day Carousel', LastUpDateTime: 'x'},
        expected: {status: 'CLOSED', waitTime: null},
      },
      {
        label: 'reporting a walk-on',
        row: {Id: 'r', Minutes: 0, Status: '', StatusDisplay: null, Title: 'Sunny Day Carousel', LastUpDateTime: 'x'},
        expected: {status: 'OPERATING', waitTime: 0},
      },
    ];

    for (const step of OBSERVED_SEQUENCE) {
      it(`maps the observed "${step.label}" state correctly`, async () => {
        const park = parkReturning([step.row]);
        const liveData = await (park as any).buildLiveData();
        const row = liveData.find((ld: any) => ld.id === 'r');
        expect(row.status).toBe(step.expected.status);
        expect(row.queue?.STANDBY?.waitTime).toBe(step.expected.waitTime);
      });
    }

    it('distinguishes a real closure from an absent reading on the same payload', async () => {
      // Busch Gardens Tampa is the stress case: 10 genuine closures sitting
      // beside 12 rides with no reading in a single response.
      const park = parkReturning([
        {Id: 'closed', Minutes: -1, Status: 'Closed For The Day', StatusDisplay: 'Closed For The Day', Title: 'A', LastUpDateTime: 'x'},
        {Id: 'noreading', Minutes: -1, Status: '', StatusDisplay: null, Title: 'B', LastUpDateTime: 'x'},
      ]);
      const liveData = await (park as any).buildLiveData();
      expect(liveData.find((ld: any) => ld.id === 'closed').status).toBe('CLOSED');
      expect(liveData.find((ld: any) => ld.id === 'noreading').status).toBe('OPERATING');
    });

    it('reads the closure from StatusDisplay when Status is blank', async () => {
      const park = parkReturning([
        {Id: 'r', Minutes: -1, Status: '', StatusDisplay: 'Closed Temporarily', Title: 'A', LastUpDateTime: 'x'},
      ]);
      const liveData = await (park as any).buildLiveData();
      expect(liveData.find((ld: any) => ld.id === 'r').status).toBe('CLOSED');
    });

    it('reports unmeasured rides as CLOSED once the park has shut', async () => {
      // Overnight the feed drops every ride to "no reading" and strips all
      // closure markers — a 02:16 local sample had all 17 SeaWorld Orlando
      // rides in that state. Without the operating-hours check this published
      // a shut park's whole ride list as OPERATING all night.
      const park = parkReturning([
        {Id: 'r', Minutes: -1, Status: '', StatusDisplay: null, Title: 'A', LastUpDateTime: 'x'},
      ], false);
      const liveData = await (park as any).buildLiveData();
      const row = liveData.find((ld: any) => ld.id === 'r');
      expect(row.status).toBe('CLOSED');
      expect(row.queue?.STANDBY?.waitTime).toBeNull();
    });

    it('publishes a live queue during an event the schedule does not list', async () => {
      // Early entry, a private hire, an extra ticketed hour. The calendar says
      // shut, the rides are running, and a real queue is being reported. This
      // must publish: suppressing a live reading is worse than any relic.
      const park = parkReturning([
        {Id: 'r', Minutes: 20, Status: '', StatusDisplay: '', Title: 'A', LastUpDateTime: FRESH_STAMP_NIGHT},
      ], false);
      const liveData = await (park as any).buildLiveData();
      const row = liveData.find((ld: any) => ld.id === 'r');
      expect(row.status).toBe('OPERATING');
      expect(row.queue?.STANDBY?.waitTime).toBe(20);
    });

    it('carries walk-ons and unmeasured rides through that same event', async () => {
      // One queue anywhere vouches for the park, so a 0 alongside it is a
      // genuine walk-on rather than the closed-park 0 — and an unmeasured ride
      // is presumed running too. Without this, an unlisted event would publish
      // only the rides that happened to have a queue.
      const park = parkReturning([
        {Id: 'queue', Minutes: 20, Status: '', StatusDisplay: '', Title: 'A', LastUpDateTime: FRESH_STAMP_NIGHT},
        {Id: 'walkon', Minutes: 0, Status: '', StatusDisplay: '', Title: 'B', LastUpDateTime: FRESH_STAMP_NIGHT},
        {Id: 'unmeasured', Minutes: -1, Status: '', StatusDisplay: null, Title: 'C', LastUpDateTime: FRESH_STAMP_NIGHT},
      ], false);
      const liveData = await (park as any).buildLiveData();
      expect(liveData.find((ld: any) => ld.id === 'walkon').status).toBe('OPERATING');
      expect(liveData.find((ld: any) => ld.id === 'walkon').queue?.STANDBY?.waitTime).toBe(0);
      expect(liveData.find((ld: any) => ld.id === 'unmeasured').status).toBe('OPERATING');
    });

    it('closes a walk-on zero once the park has actually shut', async () => {
      // The mirror of the test above, and the bug this change exists for. At
      // close the feed drops each ride to 0 and keeps REFRESHING that 0 all
      // night, so the stamp stays fresh and only the absence of any queue
      // anywhere distinguishes it. Kraken and Mako showed a walk-on at 3am.
      const park = parkReturning([
        {Id: 'a', Minutes: 0, Status: '', StatusDisplay: '', Title: 'A', LastUpDateTime: FRESH_STAMP_NIGHT},
        {Id: 'b', Minutes: 0, Status: '', StatusDisplay: '', Title: 'B', LastUpDateTime: FRESH_STAMP_NIGHT},
      ], false);
      const liveData = await (park as any).buildLiveData();
      for (const id of ['a', 'b']) {
        const row = liveData.find((ld: any) => ld.id === id);
        expect(row.status).toBe('CLOSED');
        expect(row.queue?.STANDBY?.waitTime).toBeNull();
      }
    });

    it('closes a frozen positive value once the park has shut', async () => {
      // The other half: values that freeze rather than dropping to 0. Observed
      // at 651 minutes old, still being served at midnight.
      const park = parkReturning([
        {Id: 'r', Minutes: 45, Status: '', StatusDisplay: '', Title: 'A', LastUpDateTime: STALE_STAMP},
      ], false);
      const liveData = await (park as any).buildLiveData();
      const row = liveData.find((ld: any) => ld.id === 'r');
      expect(row.status).toBe('CLOSED');
      expect(row.queue?.STANDBY?.waitTime).toBeNull();
    });

    it('a stale positive alone does not vouch for the park', async () => {
      // Only a FRESH positive counts as evidence. A frozen value must not drag
      // the rest of the park's rides back to OPERATING with it.
      const park = parkReturning([
        {Id: 'frozen', Minutes: 45, Status: '', StatusDisplay: '', Title: 'A', LastUpDateTime: STALE_STAMP},
        {Id: 'unmeasured', Minutes: -1, Status: '', StatusDisplay: null, Title: 'B', LastUpDateTime: FRESH_STAMP},
      ], false);
      const liveData = await (park as any).buildLiveData();
      expect(liveData.find((ld: any) => ld.id === 'unmeasured').status).toBe('CLOSED');
    });

    it('publishes a stale value normally while the park is open', async () => {
      // Staleness only decides things when the park is otherwise shut. During
      // opening hours a quiet ride's older number is still the best we have,
      // and discarding it would be the suppression this design avoids.
      const park = parkReturning([
        {Id: 'r', Minutes: 45, Status: '', StatusDisplay: '', Title: 'A', LastUpDateTime: STALE_STAMP},
      ], true);
      const liveData = await (park as any).buildLiveData();
      const row = liveData.find((ld: any) => ld.id === 'r');
      expect(row.status).toBe('OPERATING');
      expect(row.queue?.STANDBY?.waitTime).toBe(45);
    });

    it('reads the stamp as Eastern even for a Pacific park', async () => {
      // The stamp is US Eastern for EVERY park, not the park's own zone. San
      // Diego is where that matters: read as Pacific, an Eastern stamp lands
      // three hours in the future and the reading would be discarded.
      //
      // Clock is 20:00 Pacific, an hour after this park's 19:00 close, so the
      // schedule cannot supply the verdict — only the reading can.
      vi.useFakeTimers({toFake: ['Date']});
      vi.setSystemTime(new Date('2026-08-16T03:00:00Z')); // 23:00 ET / 20:00 PT

      const park = new SeaworldSanDiego();
      (park as any).getParkDetail = async () => ({
        ...MOCK_PARK_DETAIL_SWO,
        open_hours: [
          {opens_at: '2026-08-15T09:00:00.0000000Z', closes_at: '2026-08-15T19:00:00.0000000Z', date: '08/15/2026'},
        ],
      }) as any;
      (park as any).getAvailability = async () => ({
        // 22:57 Eastern = 19:57 Pacific = 3 minutes ago. Read as Pacific it
        // would be 22:57 PT, i.e. nearly three hours from now.
        WaitTimes: [{Id: 'r', Minutes: 25, Status: '', StatusDisplay: '', Title: 'A', LastUpDateTime: '2026-08-15T22:57:00'}],
        ShowTimes: [],
      }) as any;

      const liveData = await (park as any).buildLiveData();
      const row = liveData.find((ld: any) => ld.id === 'r');
      expect(row.status).toBe('OPERATING');
      expect(row.queue?.STANDBY?.waitTime).toBe(25);
    });

    it('does not treat a future-dated stamp as fresh', async () => {
      // Never observed in 1890 readings, so this only fires on corruption — but
      // a stamp from tomorrow would look eternally fresh and hold a shut park
      // open indefinitely.
      const park = parkReturning([
        {Id: 'r', Minutes: 30, Status: '', StatusDisplay: '', Title: 'A', LastUpDateTime: '2026-08-17T12:00:00'},
      ], false);
      const liveData = await (park as any).buildLiveData();
      const row = liveData.find((ld: any) => ld.id === 'r');
      expect(row.status).toBe('CLOSED');
    });

    it('survives an unparseable timestamp without taking down the park', async () => {
      // localFromFakeUtc throws on anything it cannot read, and this loop runs
      // outside the per-park try, so a malformed stamp would otherwise lose
      // live data for every park in the destination.
      const park = parkReturning([
        {Id: 'queue', Minutes: 20, Status: '', StatusDisplay: '', Title: 'A', LastUpDateTime: FRESH_STAMP},
        {Id: 'bad', Minutes: 10, Status: '', StatusDisplay: '', Title: 'B', LastUpDateTime: 'not-a-date'},
        {Id: 'worse', Minutes: 10, Status: '', StatusDisplay: '', Title: 'C', LastUpDateTime: 'x'},
        {Id: 'empty', Minutes: 10, Status: '', StatusDisplay: '', Title: 'D', LastUpDateTime: ''},
      ], true);
      const liveData = await (park as any).buildLiveData();
      for (const id of ['bad', 'worse', 'empty']) {
        expect(liveData.find((ld: any) => ld.id === id).status).toBe('OPERATING');
      }
    });

    it('falls back to CLOSED when operating hours cannot be determined', async () => {
      const park = parkReturning([
        {Id: 'r', Minutes: -1, Status: '', StatusDisplay: null, Title: 'A', LastUpDateTime: 'x'},
      ]);
      (park as any).getParkDetail = async () => {
        throw new Error('park detail unavailable');
      };
      const liveData = await (park as any).buildLiveData();
      const row = liveData.find((ld: any) => ld.id === 'r');
      // Conservative: never claim OPERATING on a guess.
      expect(row.status).toBe('CLOSED');
    });

    it('keeps live data when only the park detail fetch fails', async () => {
      // The hours lookup must not cost us the availability data we already have.
      const park = parkReturning([
        {Id: 'measured', Minutes: 45, Status: '', StatusDisplay: '', Title: 'A', LastUpDateTime: FRESH_STAMP},
      ]);
      (park as any).getParkDetail = async () => {
        throw new Error('park detail unavailable');
      };
      const liveData = await (park as any).buildLiveData();
      expect(liveData.find((ld: any) => ld.id === 'measured')?.queue?.STANDBY?.waitTime).toBe(45);
    });

    it('does not let a ride fall through to the CLOSED default', async () => {
      // getOrCreate seeds new entries as CLOSED. A missing Minutes field must
      // still be classified explicitly rather than inheriting that default.
      const park = parkReturning([
        {Id: 'r', Status: '', StatusDisplay: null, Title: 'A', LastUpDateTime: 'x'} as any,
      ]);
      const liveData = await (park as any).buildLiveData();
      const row = liveData.find((ld: any) => ld.id === 'r');
      expect(row.status).toBe('OPERATING');
      expect(row.queue?.STANDBY?.waitTime).toBeNull();
    });

    // The following pin behaviours that survived deliberate mutation of the
    // implementation, i.e. the code could be broken in these specific ways with
    // the rest of the suite still green.

    it('closes on Status alone, while the park is open', async () => {
      // Status carries the closure in 100% of real observations, yet ignoring
      // it entirely used to pass. Park pinned OPEN so the hours fallback cannot
      // produce the CLOSED verdict for us.
      const park = parkReturning([
        {Id: 'r', Minutes: -1, Status: 'Closed For The Day', StatusDisplay: null, Title: 'A', LastUpDateTime: 'x'},
      ], true);
      const liveData = await (park as any).buildLiveData();
      expect(liveData.find((ld: any) => ld.id === 'r').status).toBe('CLOSED');
    });

    it('closes on an unseen closure string, while the park is open', async () => {
      const park = parkReturning([
        {Id: 'r', Minutes: -1, Status: 'Closed For Private Event', StatusDisplay: 'Closed For Private Event', Title: 'A', LastUpDateTime: 'x'},
      ], true);
      const liveData = await (park as any).buildLiveData();
      expect(liveData.find((ld: any) => ld.id === 'r').status).toBe('CLOSED');
    });

    it('treats a whitespace-only Status as no reading, not a closure', async () => {
      // '   ' is truthy, so `Status || StatusDisplay` would pick it and then
      // trim to empty, throwing away a real closure. Each field is trimmed
      // separately for this reason.
      const park = parkReturning([
        {Id: 'blank', Minutes: -1, Status: '   ', StatusDisplay: null, Title: 'A', LastUpDateTime: 'x'},
        {Id: 'real', Minutes: -1, Status: '   ', StatusDisplay: 'Closed Temporarily', Title: 'B', LastUpDateTime: 'x'},
      ], true);
      const liveData = await (park as any).buildLiveData();
      expect(liveData.find((ld: any) => ld.id === 'blank').status).toBe('OPERATING');
      expect(liveData.find((ld: any) => ld.id === 'real').status).toBe('CLOSED');
    });

    it('does not throw the whole destination on a non-string Status', async () => {
      // This loop runs outside the per-park try, so a TypeError here would take
      // down every park in the destination and undo #312's isolation.
      const park = parkReturning([
        {Id: 'r', Minutes: -1, Status: 5 as any, StatusDisplay: null, Title: 'A', LastUpDateTime: 'x'},
      ], true);
      await expect((park as any).buildLiveData()).resolves.toBeInstanceOf(Array);
    });

    it('does not invent a walk-on from a null or empty Minutes', async () => {
      // Number(null) and Number('') are both 0, which is finite and >= 0.
      const park = parkReturning([
        {Id: 'nul', Minutes: null as any, Status: '', StatusDisplay: null, Title: 'A', LastUpDateTime: 'x'},
        {Id: 'empty', Minutes: '' as any, Status: '', StatusDisplay: null, Title: 'B', LastUpDateTime: 'x'},
      ], true);
      const liveData = await (park as any).buildLiveData();
      for (const id of ['nul', 'empty']) {
        expect(liveData.find((ld: any) => ld.id === id).queue?.STANDBY?.waitTime).toBeNull();
      }
    });

    it('honours an evening event block, not just the first block of the day', async () => {
      // Real event-day shape: daytime session already over, ticketed evening
      // session in progress. Only considering open_hours[0] would report closed.
      const park = parkReturning([
        {Id: 'r', Minutes: -1, Status: '', StatusDisplay: null, Title: 'A', LastUpDateTime: 'x'},
      ], true, [
        {opens_at: '2026-08-15T09:00:00.0000000Z', closes_at: '2026-08-15T13:00:00.0000000Z', date: '08/15/2026'},
        {opens_at: '2026-08-15T13:30:00.0000000Z', closes_at: '2026-08-15T23:00:00.0000000Z', date: '08/15/2026'},
      ]);
      // Clock is 14:00 local, inside the SECOND block only.
      const liveData = await (park as any).buildLiveData();
      expect(liveData.find((ld: any) => ld.id === 'r').status).toBe('OPERATING');
    });

    it('applies the >25h glitch guard so a mis-dated close does not hold the park open', async () => {
      // closes_at dated a day late yields a ~34h span. Ungurarded, the park
      // reads open right through the night and every unmeasured ride flips to
      // OPERATING. Clock is 08:00 local, before the 09:00 open.
      const park = parkReturning([
        {Id: 'r', Minutes: -1, Status: '', StatusDisplay: null, Title: 'A', LastUpDateTime: 'x'},
      ], false, [
        {opens_at: '2026-08-14T09:00:00.0000000Z', closes_at: '2026-08-15T19:00:00.0000000Z', date: '08/14/2026'},
      ]);
      const liveData = await (park as any).buildLiveData();
      expect(liveData.find((ld: any) => ld.id === 'r').status).toBe('CLOSED');
    });

    it('does not report open for an inverted block whose close precedes its open', async () => {
      const park = parkReturning([
        {Id: 'r', Minutes: -1, Status: '', StatusDisplay: null, Title: 'A', LastUpDateTime: 'x'},
      ], true, [
        {opens_at: '2026-08-15T09:00:00.0000000Z', closes_at: '2026-08-14T21:00:00.0000000Z', date: '08/15/2026'},
      ]);
      const liveData = await (park as any).buildLiveData();
      expect(liveData.find((ld: any) => ld.id === 'r').status).toBe('CLOSED');
    });

    it('treats the opening instant as open and the closing instant as shut', async () => {
      const row = {Id: 'r', Minutes: -1, Status: '', StatusDisplay: null, Title: 'A', LastUpDateTime: 'x'};
      // Exactly 09:00 local = 13:00Z.
      vi.useFakeTimers({toFake: ['Date']});
      vi.setSystemTime(new Date('2026-08-15T13:00:00Z'));
      let park = createMockedOrlando();
      (park as any).getAvailability = async () => availabilityWith([row]) as any;
      (park as any).getParkDetail = async () => ({...MOCK_PARK_DETAIL_SWO, open_hours: HOURS_TODAY}) as any;
      let liveData = await (park as any).buildLiveData();
      expect(liveData.find((ld: any) => ld.id === 'r').status).toBe('OPERATING');

      // Exactly 21:00 local = 01:00Z next day.
      vi.setSystemTime(new Date('2026-08-16T01:00:00Z'));
      park = createMockedOrlando();
      (park as any).getAvailability = async () => availabilityWith([row]) as any;
      (park as any).getParkDetail = async () => ({...MOCK_PARK_DETAIL_SWO, open_hours: HOURS_TODAY}) as any;
      liveData = await (park as any).buildLiveData();
      expect(liveData.find((ld: any) => ld.id === 'r').status).toBe('CLOSED');
    });

    it('survives sanitisation on the public getLiveData path', async () => {
      // Every other assertion here reads buildLiveData() output, before the base
      // class sanitises and strips undefined. The null-vs-undefined argument is
      // about what actually reaches consumers, so check the public path too.
      const park = parkReturning([
        {Id: 'ride-001', Minutes: -1, Status: '', StatusDisplay: null, Title: 'A', LastUpDateTime: 'x'},
      ], true);
      const liveData = await park.getLiveData();
      const row = liveData.find((ld: any) => ld.id === 'ride-001');
      expect(row).toBeDefined();
      expect(row!.queue?.STANDBY).toHaveProperty('waitTime');
      expect(row!.queue?.STANDBY?.waitTime).toBeNull();
    });

    it('asks for the park-local date, not the UTC date', async () => {
      // 21:30 on 15 Aug in New York is already 16 Aug in UTC. Asking for the
      // UTC date fetches TOMORROW's availability while the park is still open,
      // which is when summer nights and Howl-O-Scream run. The app itself sends
      // LocalDate.now(), i.e. the device-local date.
      vi.useFakeTimers({toFake: ['Date']});
      vi.setSystemTime(new Date('2026-08-16T01:30:00Z'));

      const seen: string[] = [];
      const park = createMockedOrlando();
      (park as any).getAvailability = async (_id: string, searchDate: string) => {
        seen.push(searchDate);
        return {WaitTimes: [], ShowTimes: []} as any;
      };
      await (park as any).buildLiveData();

      expect(seen.length).toBeGreaterThan(0);
      for (const d of seen) expect(d).toBe('2026-08-15');
    });

    it('asks for the park-local date in a western timezone too', async () => {
      // 17:30 on 15 Aug in Los Angeles is likewise 16 Aug in UTC.
      vi.useFakeTimers({toFake: ['Date']});
      vi.setSystemTime(new Date('2026-08-16T00:30:00Z'));

      const seen: string[] = [];
      const park = new SeaworldSanDiego();
      (park as any).getParkDetail = async () => ({...MOCK_PARK_DETAIL_SWO, open_hours: []}) as any;
      (park as any).getAvailability = async (_id: string, searchDate: string) => {
        seen.push(searchDate);
        return {WaitTimes: [], ShowTimes: []} as any;
      };
      await (park as any).buildLiveData();

      expect(seen).toContain('2026-08-15');
    });

    it('never emits a bare waitTime of undefined', async () => {
      // `{waitTime: undefined}` serialises to `"STANDBY": {}`, which says
      // nothing. Every branch must produce an explicit number or null.
      const park = parkReturning([
        {Id: 'a', Minutes: 15, Status: '', StatusDisplay: null, Title: 'A', LastUpDateTime: 'x'},
        {Id: 'b', Minutes: -1, Status: '', StatusDisplay: null, Title: 'B', LastUpDateTime: 'x'},
        {Id: 'c', Minutes: -1, Status: 'Closed Temporarily', StatusDisplay: 'Closed Temporarily', Title: 'C', LastUpDateTime: 'x'},
      ]);
      const liveData = await (park as any).buildLiveData();
      for (const row of liveData) {
        if (!row.queue?.STANDBY) continue;
        expect(row.queue.STANDBY).toHaveProperty('waitTime');
        expect(row.queue.STANDBY.waitTime).not.toBeUndefined();
      }
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
    beforeEach(() => pinClock(CLOCK_PARK_OPEN));
    afterEach(() => vi.useRealTimers());

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
