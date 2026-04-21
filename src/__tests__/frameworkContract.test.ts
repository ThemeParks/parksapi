/**
 * Framework contract tests.
 *
 * Verify the core framework behaviors that all park implementations rely on:
 * - @destinationController auto-discovery and registration
 * - @destinationController auto-applies @config
 * - Cache key isolation between parks sharing a base class
 * - Template method pattern (build* methods called correctly)
 * - Entity hierarchy auto-resolution
 */

import { describe, test, expect, afterAll } from 'vitest';
import { Destination, DestinationConstructor } from '../destination.js';
import { Entity, LiveData, EntitySchedule } from '@themeparks/typelib';
import config from '../config.js';
import { destinationController } from '../destinationRegistry.js';
import { getAllDestinations, getDestinationById } from '../destinationRegistry.js';
import { stopHttpQueue } from '../http.js';

afterAll(() => {
  stopHttpQueue();
});

describe('Destination registry', () => {
  test('all parks are discoverable via getAllDestinations', async () => {
    const destinations = await getAllDestinations();
    expect(destinations.length).toBeGreaterThan(0);

    // Every entry has required fields
    for (const d of destinations) {
      expect(d).toHaveProperty('id');
      expect(d).toHaveProperty('name');
      expect(d).toHaveProperty('DestinationClass');
      expect(d).toHaveProperty('category');
      expect(typeof d.DestinationClass).toBe('function');
    }
  });

  test('getDestinationById returns correct entry', async () => {
    const entry = await getDestinationById('efteling');
    expect(entry).toBeDefined();
    expect(entry!.id).toBe('efteling');
    expect(entry!.name).toBe('Efteling');
  });

  test('getDestinationById returns undefined for unknown park', async () => {
    const entry = await getDestinationById('nonexistent_park_xyz');
    expect(entry).toBeUndefined();
  });

  test('registered parks can be instantiated', async () => {
    const entry = await getDestinationById('efteling');
    expect(entry).toBeDefined();

    const park = new entry!.DestinationClass();
    expect(park).toBeInstanceOf(Destination);
  });

  test('known parks are all registered', async () => {
    const expectedParks = [
      'efteling',
      'phantasialand',
      'universalorlando',
      'universalstudios',
      'liseberg',
      'portaventuraworld',
      'sixflags',
      'movieparkgermany',
      'bobbejaanland',
      'mirabilandia',
      'parquedeatraccionesmadrid',
      'parquewarnermadrid',
      'dollywood',
      'silverdollarcity',
      'kennywood',
    ];

    for (const parkId of expectedParks) {
      const entry = await getDestinationById(parkId);
      expect(entry, `Park ${parkId} should be registered`).toBeDefined();
    }
  });
});

describe('@destinationController auto-applies @config', () => {
  test('park instances have config proxy (env vars resolve)', async () => {
    // Set a test env var for Efteling
    process.env.EFTELING_TIMEZONE = 'test/timezone';

    const entry = await getDestinationById('efteling');
    const park = new entry!.DestinationClass();

    // The @config proxy should resolve EFTELING_TIMEZONE
    expect((park as any).timezone).toBe('test/timezone');

    delete process.env.EFTELING_TIMEZONE;
  });

  test('config prefix resolution works for registered parks', async () => {
    process.env.STAYAPP_AUTHTOKEN = 'test-token-123';

    const entry = await getDestinationById('movieparkgermany');
    const park = new entry!.DestinationClass();

    // Should resolve via STAYAPP prefix (shared)
    expect((park as any).authToken).toBe('test-token-123');

    delete process.env.STAYAPP_AUTHTOKEN;
  });
});

describe('Template method pattern', () => {
  test('getEntities calls buildEntityList', async () => {
    let buildCalled = false;

    @destinationController({ category: 'Test' })
    class TestTemplatePark extends Destination {
      constructor(options?: DestinationConstructor) {
        super(options);
      }

      protected async buildEntityList(): Promise<Entity[]> {
        buildCalled = true;
        return [
          { id: 'dest1', name: 'Dest', entityType: 'DESTINATION', timezone: 'UTC' } as Entity,
          { id: 'park1', name: 'Park', entityType: 'PARK', parentId: 'dest1', timezone: 'UTC' } as Entity,
          { id: 'test1', name: 'Test', entityType: 'ATTRACTION', parentId: 'park1', timezone: 'UTC' } as Entity,
        ];
      }

      protected async buildLiveData(): Promise<LiveData[]> { return []; }
      protected async buildSchedules(): Promise<EntitySchedule[]> { return []; }
      async getDestinations(): Promise<Entity[]> { return []; }
    }

    const park = new TestTemplatePark();
    const entities = await park.getEntities();

    expect(buildCalled).toBe(true);
    expect(entities.length).toBe(3);
    expect(entities.find(e => e.id === 'test1')).toBeDefined();
  });

  test('getLiveData calls buildLiveData', async () => {
    let buildCalled = false;

    @destinationController({ category: 'Test' })
    class TestLivePark extends Destination {
      constructor(options?: DestinationConstructor) {
        super(options);
      }

      protected async buildEntityList(): Promise<Entity[]> { return []; }

      protected async buildLiveData(): Promise<LiveData[]> {
        buildCalled = true;
        return [{ id: 'ride1', status: 'OPERATING' } as LiveData];
      }

      protected async buildSchedules(): Promise<EntitySchedule[]> { return []; }
      async getDestinations(): Promise<Entity[]> { return []; }
    }

    const park = new TestLivePark();
    const liveData = await park.getLiveData();

    expect(buildCalled).toBe(true);
    expect(liveData.length).toBe(1);
  });

  test('framework strips undefined values from live data, entities, and schedules', async () => {
    // Guards against the collector's hashObject() which rejects undefined.
    // Parks sometimes produce undefined via patterns like
    //   { waitTime: cond ? n : undefined }
    //   location: { latitude, longitude: maybe }
    // The framework should scrub these before returning.
    @destinationController({ category: 'Test' })
    class TestUndefPark extends Destination {
      constructor(options?: DestinationConstructor) {
        super(options);
      }

      async getDestinations(): Promise<Entity[]> {
        return [{ id: 'dest', name: 'D', entityType: 'DESTINATION', timezone: 'UTC' } as Entity];
      }

      protected async buildEntityList(): Promise<Entity[]> {
        return [
          {
            id: 'ride1',
            name: 'R',
            entityType: 'ATTRACTION',
            parentId: 'dest',
            timezone: 'UTC',
            location: { latitude: 1, longitude: 2 },
            tags: undefined,
          } as any as Entity,
        ];
      }

      protected async buildLiveData(): Promise<LiveData[]> {
        return [
          {
            id: 'ride1',
            status: 'OPERATING',
            queue: { STANDBY: { waitTime: undefined } },
            nested: { keep: 'me', drop: undefined, inner: { gone: undefined, stay: 1 } },
          } as any as LiveData,
        ];
      }

      protected async buildSchedules(): Promise<EntitySchedule[]> {
        return [
          {
            id: 'ride1',
            schedule: [
              {
                date: '2026-01-01',
                openingTime: 'x', closingTime: 'y', type: 'OPERATING',
                description: undefined,
              } as any,
            ],
          } as EntitySchedule,
        ];
      }
    }

    const park = new TestUndefPark();

    const entities = await park.getEntities();
    const ride = entities.find(e => e.id === 'ride1')!;
    expect('tags' in ride).toBe(false);

    const liveData = await park.getLiveData();
    const entry = liveData[0] as any;
    expect('drop' in entry.nested).toBe(false);
    expect('gone' in entry.nested.inner).toBe(false);
    expect(entry.nested.inner.stay).toBe(1);
    // waitTime:undefined is removed (not null-coerced) because the existing
    // waitTime guard treats `undefined == null` as already-valid. Either
    // outcome is hash-safe; the important thing is the key carries no
    // undefined value.
    expect('waitTime' in entry.queue.STANDBY).toBe(false);

    const schedules = await park.getSchedules();
    const day = schedules[0].schedule[0] as any;
    expect('description' in day).toBe(false);
  });
});

describe('Cache key isolation', () => {
  test('getCacheKeyPrefix returns unique values per park instance', async () => {
    // This tests the pattern used by framework parks (Parcs Reunidos, HFE, etc.)
    // where multiple parks share a base class and need isolated cache keys

    @config
    class TestCacheBase extends Destination {
      @config parkCode: string = '';

      getCacheKeyPrefix(): string {
        return `testbase:${this.parkCode}`;
      }

      constructor(options?: DestinationConstructor) {
        super(options);
      }

      protected async buildEntityList(): Promise<Entity[]> { return []; }
      protected async buildLiveData(): Promise<LiveData[]> { return []; }
      protected async buildSchedules(): Promise<EntitySchedule[]> { return []; }
      async getDestinations(): Promise<Entity[]> { return []; }
    }

    const park1 = new TestCacheBase({ config: { parkCode: 'park_a' } });
    const park2 = new TestCacheBase({ config: { parkCode: 'park_b' } });

    expect(park1.getCacheKeyPrefix()).toBe('testbase:park_a');
    expect(park2.getCacheKeyPrefix()).toBe('testbase:park_b');
    expect(park1.getCacheKeyPrefix()).not.toBe(park2.getCacheKeyPrefix());
  });
});

describe('Entity hierarchy resolution', () => {
  test('parkId and destinationId are auto-resolved from parent chains', async () => {
    @destinationController({ category: 'Test' })
    class TestHierarchyPark extends Destination {
      constructor(options?: DestinationConstructor) {
        super(options);
      }

      protected async buildEntityList(): Promise<Entity[]> {
        return [
          { id: 'dest1', name: 'Dest', entityType: 'DESTINATION', timezone: 'UTC' } as Entity,
          { id: 'park1', name: 'Park', entityType: 'PARK', parentId: 'dest1', timezone: 'UTC' } as Entity,
          { id: 'ride1', name: 'Ride', entityType: 'ATTRACTION', parentId: 'park1', timezone: 'UTC' } as Entity,
        ];
      }

      protected async buildLiveData(): Promise<LiveData[]> { return []; }
      protected async buildSchedules(): Promise<EntitySchedule[]> { return []; }
      async getDestinations(): Promise<Entity[]> { return []; }
    }

    const park = new TestHierarchyPark();
    const entities = await park.getEntities();

    const ride = entities.find(e => e.id === 'ride1');
    expect(ride).toBeDefined();
    // Framework should auto-resolve parkId and destinationId
    expect(ride!.parkId).toBe('park1');
    expect(ride!.destinationId).toBe('dest1');
  });
});
