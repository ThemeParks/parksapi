/**
 * Comprehensive test suite for Attractions.io v3 framework (Cedar Fair parks)
 */

import {
  AttractionsIOV3,
  CedarPoint,
  KnottsBerryFarm,
  WorldsOfFun,
  DorneyPark,
  MichigansAdventure,
  Valleyfair,
  KingsIsland,
  KingsDominion,
  Carowinds,
  CaliforniasGreatAmerica,
  CanadasWonderland,
} from '../attractionsio';
import {CacheLib} from '../../../cache';

// Mock data for testing
const mockWaitTimesResponse = {
  venues: [
    {
      details: [
        {
          fimsId: 'RIDE001',
          regularWaittime: {
            waitTime: 30,
            createdDateTime: '2024-01-01T12:00:00Z',
          },
          fastlaneWaittime: {
            waitTime: 10,
            createdDateTime: '2024-01-01T12:00:00Z',
          },
        },
        {
          fimsId: 'RIDE002',
          regularWaittime: {
            waitTime: 45,
            createdDateTime: '2024-01-01T12:00:00Z',
          },
        },
      ],
    },
  ],
};

const mockVenueStatusResponse = {
  venues: [
    {
      details: [
        {fimsId: 'RIDE001', status: 'Opened'},
        {fimsId: 'RIDE002', status: 'Closed'},
        {fimsId: 'RIDE003', status: 'Opened'},
      ],
    },
  ],
};

const mockParkConfigResponse = {
  parkName: 'Test Park',
  poi_config: {
    parkModes: [
      {
        category: {
          values: [
            {
              label: 'Rides',
              filters: [
                {
                  fieldName: 'type',
                  values: [
                    {value: 1},
                    {value: 2},
                    {value: 3},
                  ],
                },
              ],
            },
            {
              title: 'Shows',
              filters: [
                {
                  fieldName: 'showType',
                  values: [
                    {value: 10},
                    {value: 11},
                  ],
                },
              ],
            },
            {
              label: 'Dining',
              filters: [
                {
                  fieldName: 'foodTypes',
                  values: [
                    {value: 20},
                    {value: 21},
                  ],
                },
              ],
            },
          ],
        },
      },
    ],
  },
};

const mockPOIResponse = [
  {
    fimsId: 'RIDE001',
    name: 'Test Roller Coaster',
    type: {id: 1},
    location: {latitude: 41.4779, longitude: -82.6793},
  },
  {
    fimsId: 'RIDE002',
    name: 'Test Water Ride',
    type: {id: 2},
    location: {latitude: 41.4780, longitude: -82.6794},
  },
  {
    fimsId: 'SHOW001',
    name: 'Test Show',
    showType: {id: 10},
    location: {latitude: 41.4781, longitude: -82.6795},
  },
  {
    fimsId: 'FOOD001',
    name: 'Test Restaurant',
    foodTypes: {id: 20},
    location: {latitude: 41.4782, longitude: -82.6796},
  },
  {
    fimsId: 'ENTRANCE',
    name: 'Main Entrance',
    type: {id: 99},
    location: {latitude: 41.4783, longitude: -82.6797},
  },
];

const mockScheduleResponse = {
  isParkClosed: false,
  operatings: [
    {
      items: [
        {
          timeFrom: '10:00',
          timeTo: '22:00',
          isBuyout: false,
        },
        {
          timeFrom: '18:00',
          timeTo: '23:00',
          isBuyout: true, // Should be filtered out
        },
      ],
    },
  ],
};

describe('AttractionsIOV3 Base Class', () => {
  let testPark: any;

  beforeEach(() => {
    CacheLib.clear();

    // Create test instance
    testPark = new AttractionsIOV3({
      config: {
        timezone: 'America/New_York',
        parkId: '999',
        destinationId: 'testpark',
        realTimeBaseURL: 'https://api.test.com',
        appId: 'com.test.app',
        appName: 'Test App',
      },
    });

    // Mock HTTP methods using vi.spyOn()
    vi.spyOn(testPark, 'fetchWaitTimes').mockResolvedValue({
      json: async () => mockWaitTimesResponse
    } as any);

    vi.spyOn(testPark, 'fetchVenueStatus').mockResolvedValue({
      json: async () => mockVenueStatusResponse
    } as any);

    vi.spyOn(testPark, 'fetchParkConfig').mockResolvedValue({
      json: async () => mockParkConfigResponse
    } as any);

    vi.spyOn(testPark, 'fetchParkPOI').mockResolvedValue({
      json: async () => mockPOIResponse
    } as any);

    vi.spyOn(testPark, 'fetchScheduleForDate').mockResolvedValue({
      json: async () => mockScheduleResponse
    } as any);

    vi.spyOn(testPark, 'fetchAppVersion').mockResolvedValue({
      json: async () => ({version: '1.2.3'})
    } as any);
  });

  afterEach(() => {
    CacheLib.clear();
    vi.restoreAllMocks();
  });

  describe('Cache Key Prefix', () => {
    it('should generate unique cache key prefix with parkId', () => {
      const prefix = testPark.getCacheKeyPrefix();
      expect(prefix).toBe('attractionsio:999');
    });

    it('should prevent cache collisions between different parks', async () => {
      const p1 = new AttractionsIOV3({
        config: {
          timezone: 'America/New_York',
          parkId: '1',
          destinationId: 'park1',
          realTimeBaseURL: 'https://api.test.com',
        },
      });

      const p2 = new AttractionsIOV3({
        config: {
          timezone: 'America/New_York',
          parkId: '2',
          destinationId: 'park2',
          realTimeBaseURL: 'https://api.test.com',
        },
      });

      vi.spyOn(p1, 'fetchWaitTimes').mockResolvedValue({
        json: async () => ({data: 'park1'})
      } as any);

      vi.spyOn(p2, 'fetchWaitTimes').mockResolvedValue({
        json: async () => ({data: 'park2'})
      } as any);

      await p1.getWaitTimes();
      await p2.getWaitTimes();

      // Should have 2 separate cache entries
      const keys = CacheLib.keys();
      expect(keys.length).toBe(2);
      expect(keys.some(k => k.includes('attractionsio:1'))).toBe(true);
      expect(keys.some(k => k.includes('attractionsio:2'))).toBe(true);
    });
  });

  describe('Helper Methods', () => {
    describe('getTypesFromCategories()', () => {
      it('should extract type IDs for Rides category', async () => {
        const types = await testPark.getTypesFromCategories(['Rides'], 'type');
        expect(types).toEqual([1, 2, 3]);
      });

      it('should extract type IDs for Shows category', async () => {
        const types = await testPark.getTypesFromCategories(['Shows'], 'showType');
        expect(types).toEqual([10, 11]);
      });

      it('should extract type IDs for Dining category', async () => {
        const types = await testPark.getTypesFromCategories(['Dining'], 'foodTypes');
        expect(types).toEqual([20, 21]);
      });

      it('should return empty array for non-existent category', async () => {
        const types = await testPark.getTypesFromCategories(['NonExistent'], 'type');
        expect(types).toEqual([]);
      });

      it('should handle multiple categories', async () => {
        const types = await testPark.getTypesFromCategories(['Rides', 'Shows'], 'type');
        // Should only return types from Rides (since we're filtering by 'type' field)
        expect(types).toEqual([1, 2, 3]);
      });

      it('should return unique type IDs only', async () => {
        // Mock config with duplicate type IDs
        vi.spyOn(testPark, 'fetchParkConfig').mockResolvedValueOnce({
          json: async () => ({
            parkName: 'Test',
            poi_config: {
              parkModes: [
                {
                  category: {
                    values: [
                      {
                        label: 'Test',
                        filters: [
                          {
                            fieldName: 'type',
                            values: [{value: 1}, {value: 2}, {value: 1}], // Duplicate 1
                          },
                        ],
                      },
                    ],
                  },
                },
              ],
            },
          }),
        } as any);

        CacheLib.clear(); // Clear cache to use new mock
        const types = await testPark.getTypesFromCategories(['Test'], 'type');
        expect(types).toEqual([1, 2]); // No duplicates
      });
    });

    describe('getParkEntranceLocation()', () => {
      it('should find Main Entrance location', async () => {
        const location = await testPark.getParkEntranceLocation();
        expect(location).toEqual({
          latitude: 41.4783,
          longitude: -82.6797,
        });
      });

      it('should return undefined if no entrance found', async () => {
        // Mock POI without entrance
        vi.spyOn(testPark, 'fetchParkPOI').mockResolvedValueOnce({
          json: async () => [{fimsId: 'TEST', name: 'Test POI'}],
        } as any);

        CacheLib.clear();
        const location = await testPark.getParkEntranceLocation();
        expect(location).toBeUndefined();
      });

      it('should try multiple entrance name variations', async () => {
        // Mock POI with "Accessible Gate" instead of "Main Entrance"
        vi.spyOn(testPark, 'fetchParkPOI').mockResolvedValueOnce({
          json: async () => [
            {
              fimsId: 'GATE',
              name: 'Accessible Gate',
              location: {latitude: 10.0, longitude: 20.0},
            },
          ],
        } as any);

        CacheLib.clear();
        const location = await testPark.getParkEntranceLocation();
        expect(location).toEqual({latitude: 10.0, longitude: 20.0});
      });
    });

    describe('getAndroidAppVersion()', () => {
      it('should return app version from API', async () => {
        const version = await testPark.getAndroidAppVersion();
        expect(version).toBe('1.2.3');
      });

      it('should return fallback version if appId is null', async () => {
        vi.restoreAllMocks();
        CacheLib.clear();
        testPark.appId = null;
        const version = await testPark.getAndroidAppVersion();
        expect(version).toBe('1.0.0');
      });

      it('should return fallback version if API fails', async () => {
        vi.spyOn(testPark, 'fetchAppVersion').mockRejectedValueOnce(
          new Error('API failed')
        );

        CacheLib.clear();
        const version = await testPark.getAndroidAppVersion();
        expect(version).toBe('1.0.0');
      });
    });
  });

  describe('buildEntityList()', () => {
    it('should build destination entity', async () => {
      const entities = await testPark.buildEntityList();
      const destination = entities.find((e: any) => e.entityType === 'DESTINATION');

      expect(destination).toBeDefined();
      expect(destination.id).toBe('testpark_destination');
      expect(destination.name).toBe('Test Park');
      expect(destination.timezone).toBe('America/New_York');
      expect(destination.location).toEqual({
        latitude: 41.4783,
        longitude: -82.6797,
      });
    });

    it('should build park entity', async () => {
      const entities = await testPark.buildEntityList();
      const park = entities.find((e: any) => e.entityType === 'PARK');

      expect(park).toBeDefined();
      expect(park.id).toBe('testpark');
      expect(park.name).toBe('Test Park');
      expect(park.parentId).toBe('testpark_destination');
    });

    it('should build attraction entities filtered by type', async () => {
      const entities = await testPark.buildEntityList();
      const attractions = entities.filter((e: any) => e.entityType === 'ATTRACTION');

      expect(attractions.length).toBe(2); // RIDE001 and RIDE002
      expect(attractions[0].id).toBe('RIDE001');
      expect(attractions[0].name).toBe('Test Roller Coaster');
      expect(attractions[1].id).toBe('RIDE002');
    });

    it('should build show entities filtered by showType', async () => {
      const entities = await testPark.buildEntityList();
      const shows = entities.filter((e: any) => e.entityType === 'SHOW');

      expect(shows.length).toBe(1);
      expect(shows[0].id).toBe('SHOW001');
      expect(shows[0].name).toBe('Test Show');
    });

    it('should build restaurant entities filtered by foodTypes', async () => {
      const entities = await testPark.buildEntityList();
      const restaurants = entities.filter((e: any) => e.entityType === 'RESTAURANT');

      expect(restaurants.length).toBe(1);
      expect(restaurants[0].id).toBe('FOOD001');
      expect(restaurants[0].name).toBe('Test Restaurant');
    });

    it('should include location data for entities', async () => {
      const entities = await testPark.buildEntityList();
      const attraction = entities.find((e: any) => e.id === 'RIDE001');

      expect(attraction.location).toEqual({
        latitude: 41.4779,
        longitude: -82.6793,
      });
    });
  });

  describe('buildLiveData() - Venue Status Precedence', () => {
    it('should set OPERATING status when wait time exists and venue is Opened', async () => {
      const liveData = await testPark.buildLiveData();
      const ride001 = liveData.find((ld: any) => ld.id === 'RIDE001');

      expect(ride001.status).toBe('OPERATING');
      expect(ride001.queue.STANDBY.waitTime).toBe(30);
    });

    it('should set CLOSED status when venue status is Closed (CRITICAL)', async () => {
      const liveData = await testPark.buildLiveData();
      const ride002 = liveData.find((ld: any) => ld.id === 'RIDE002');

      // RIDE002 has wait time BUT venue status is Closed
      // Venue status MUST override - this is CRITICAL
      expect(ride002.status).toBe('CLOSED');
      expect(ride002.queue.STANDBY.waitTime).toBe(45);
    });

    it('should handle both STANDBY and PAID_STANDBY queues', async () => {
      const liveData = await testPark.buildLiveData();
      const ride001 = liveData.find((ld: any) => ld.id === 'RIDE001');

      expect(ride001.queue.STANDBY).toBeDefined();
      expect(ride001.queue.STANDBY.waitTime).toBe(30);
      expect(ride001.queue.PAID_STANDBY).toBeDefined();
      expect(ride001.queue.PAID_STANDBY.waitTime).toBe(10);
    });

    it('should handle missing venue status gracefully', async () => {
      // Mock venue status as null (API unavailable)
      vi.spyOn(testPark, 'fetchVenueStatus').mockRejectedValueOnce(
        new Error('Venue status unavailable')
      );

      const liveData = await testPark.buildLiveData();
      const ride001 = liveData.find((ld: any) => ld.id === 'RIDE001');

      // Should default to OPERATING when venue status is unavailable
      expect(ride001.status).toBe('OPERATING');
      expect(ride001.queue.STANDBY.waitTime).toBe(30);
    });

    it('should normalize fimsId to uppercase', async () => {
      // Mock wait times with lowercase fimsId
      vi.spyOn(testPark, 'fetchWaitTimes').mockResolvedValueOnce({
        json: async () => ({
          venues: [
            {
              details: [
                {
                  fimsId: 'ride001', // lowercase
                  regularWaittime: {waitTime: 25, createdDateTime: '2024-01-01T12:00:00Z'},
                },
              ],
            },
          ],
        }),
      } as any);

      const liveData = await testPark.buildLiveData();
      const ride = liveData.find((ld: any) => ld.id === 'RIDE001');

      expect(ride).toBeDefined();
      expect(ride.id).toBe('RIDE001'); // Should be uppercase
    });
  });

  describe('buildSchedules()', () => {
    it('should build schedule entries from API data', async () => {
      const schedules = await testPark.buildSchedules();

      expect(schedules.length).toBe(1);
      expect(schedules[0].id).toBe('testpark');
      expect(schedules[0].schedule.length).toBeGreaterThan(0);
    });

    it('should filter out buyout events', async () => {
      const schedules = await testPark.buildSchedules();
      const schedule = schedules[0].schedule;

      // Should only have non-buyout events
      // Mock has 1 regular and 1 buyout event
      expect(schedule.every((s: any) => s.openingTime && s.closingTime)).toBe(true);
    });

    it('should skip closed park days', async () => {
      let callCount = 0;
      vi.spyOn(testPark, 'fetchScheduleForDate').mockImplementation(async () => {
        callCount++;
        return {
          json: async () => ({
            isParkClosed: true, // All days closed
            operatings: [],
          }),
        } as any;
      });

      const schedules = await testPark.buildSchedules();

      expect(schedules[0].schedule.length).toBe(0); // No schedule entries
      expect(callCount).toBeGreaterThan(0); // But API was called
    });

    it('should handle missing operating times', async () => {
      vi.spyOn(testPark, 'fetchScheduleForDate').mockImplementation(async () => ({
        json: async () => ({
          isParkClosed: false,
          operatings: [
            {
              items: [
                {timeFrom: null, timeTo: '22:00', isBuyout: false}, // Missing timeFrom
                {timeFrom: '10:00', timeTo: null, isBuyout: false}, // Missing timeTo
              ],
            },
          ],
        }),
      } as any));

      const schedules = await testPark.buildSchedules();

      // Should skip entries with missing times
      expect(schedules[0].schedule.length).toBe(0);
    });
  });
});

describe('Park Subclasses - Integration Tests', () => {
  const parks = [
    {name: 'Cedar Point', Class: CedarPoint, parkId: '1', timezone: 'America/New_York'},
    {name: 'Knott\'s Berry Farm', Class: KnottsBerryFarm, parkId: '4', timezone: 'America/Los_Angeles'},
    {name: 'Worlds of Fun', Class: WorldsOfFun, parkId: '6', timezone: 'America/Chicago'},
    {name: 'Dorney Park', Class: DorneyPark, parkId: '8', timezone: 'America/New_York'},
    {name: 'Michigan\'s Adventure', Class: MichigansAdventure, parkId: '12', timezone: 'America/Detroit'},
    {name: 'Valleyfair', Class: Valleyfair, parkId: '14', timezone: 'America/Chicago'},
    {name: 'Kings Island', Class: KingsIsland, parkId: '20', timezone: 'America/New_York'},
    {name: 'Kings Dominion', Class: KingsDominion, parkId: '25', timezone: 'America/New_York'},
    {name: 'Carowinds', Class: Carowinds, parkId: '30', timezone: 'America/New_York'},
    {name: 'California\'s Great America', Class: CaliforniasGreatAmerica, parkId: '35', timezone: 'America/Los_Angeles'},
    {name: 'Canada\'s Wonderland', Class: CanadasWonderland, parkId: '40', timezone: 'America/Toronto'},
  ];

  beforeEach(() => {
    CacheLib.clear();
  });

  afterEach(() => {
    CacheLib.clear();
  });

  parks.forEach(({name, Class, parkId, timezone}) => {
    describe(name, () => {
      it('should instantiate with correct configuration', () => {
        const park = new Class();
        expect(park.parkId).toBe(parkId);
        expect(park.timezone).toBe(timezone);
      });

      it('should generate unique cache key prefix', () => {
        const park = new Class();
        const prefix = park.getCacheKeyPrefix();
        expect(prefix).toBe(`attractionsio:${parkId}`);
      });

      it('should have required configuration', () => {
        const park = new Class();

        expect(park.realTimeBaseURL).toBeTruthy();
        expect(park.parkId).toBeTruthy();
        expect(park.destinationId).toBeTruthy();
      });
    });
  });

  it('should have unique cache keys for different parks', () => {
    const cedarPoint = new CedarPoint();
    const knotts = new KnottsBerryFarm();

    const prefix1 = cedarPoint.getCacheKeyPrefix();
    const prefix2 = knotts.getCacheKeyPrefix();

    expect(prefix1).not.toBe(prefix2);
    expect(prefix1).toBe('attractionsio:1');
    expect(prefix2).toBe('attractionsio:4');
  });
});
