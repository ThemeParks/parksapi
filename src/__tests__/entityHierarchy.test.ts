/**
 * Test entity hierarchy resolution
 */

import {Destination} from '../destination.js';
import {Entity} from '@themeparks/typelib';

// Mock destination class for testing
class MockDestination extends Destination {
  async getDestinations(): Promise<Entity[]> {
    return [];
  }

  protected async buildEntityList(): Promise<Entity[]> {
    return [];
  }

  protected async buildLiveData(): Promise<any[]> {
    return [];
  }

  protected async buildSchedules(): Promise<any[]> {
    return [];
  }

  // Expose protected method for testing
  public testResolveHierarchy(entities: Entity[]): Entity[] {
    return this.resolveEntityHierarchy(entities);
  }
}

describe('Entity Hierarchy Resolution', () => {
  let destination: MockDestination;

  beforeEach(() => {
    destination = new MockDestination();
  });

  test('getEntities() should automatically resolve hierarchy', async () => {
    // Create a mock that returns entities via buildEntityList
    class AutoResolveDestination extends Destination {
      async getDestinations(): Promise<Entity[]> {
        return [];
      }

      protected async buildEntityList(): Promise<Entity[]> {
        return [
          {
            id: 'dest1',
            name: 'Test Destination',
            entityType: 'DESTINATION',
            timezone: 'America/New_York',
          } as Entity,
          {
            id: 'park1',
            name: 'Test Park',
            entityType: 'PARK',
            parentId: 'dest1',
            timezone: 'America/New_York',
          } as Entity,
          {
            id: 'attraction1',
            name: 'Test Ride',
            entityType: 'ATTRACTION',
            parentId: 'park1',
            timezone: 'America/New_York',
          } as Entity,
        ];
      }

      protected async buildLiveData(): Promise<any[]> {
        return [];
      }

      protected async buildSchedules(): Promise<any[]> {
        return [];
      }
    }

    const dest = new AutoResolveDestination();
    const entities = await dest.getEntities();

    // Verify hierarchy was automatically resolved
    expect(entities[0].destinationId).toBe('dest1');
    expect(entities[0].parkId).toBeUndefined();

    expect(entities[1].destinationId).toBe('dest1');
    expect(entities[1].parkId).toBeUndefined();

    expect(entities[2].destinationId).toBe('dest1');
    expect(entities[2].parkId).toBe('park1');  // Automatically set!
  });

  test('should set destinationId to self for DESTINATION entities', () => {
    const entities: Entity[] = [
      {
        id: 'dest1',
        name: 'Test Destination',
        entityType: 'DESTINATION',
        timezone: 'America/New_York',
      } as Entity,
    ];

    const resolved = destination.testResolveHierarchy(entities);

    expect(resolved[0].destinationId).toBe('dest1');
    expect(resolved[0].parkId).toBeUndefined();
    expect(resolved[0].parentId).toBeUndefined();
  });

  test('should set destinationId for PARK entities based on parent', () => {
    const entities: Entity[] = [
      {
        id: 'dest1',
        name: 'Test Destination',
        entityType: 'DESTINATION',
        timezone: 'America/New_York',
      } as Entity,
      {
        id: 'park1',
        name: 'Test Park',
        entityType: 'PARK',
        parentId: 'dest1',
        timezone: 'America/New_York',
      } as Entity,
    ];

    const resolved = destination.testResolveHierarchy(entities);

    expect(resolved[1].destinationId).toBe('dest1');
    expect(resolved[1].parkId).toBeUndefined();
  });

  test('should set parkId for attraction inside a park', () => {
    const entities: Entity[] = [
      {
        id: 'dest1',
        name: 'Test Destination',
        entityType: 'DESTINATION',
        timezone: 'America/New_York',
      } as Entity,
      {
        id: 'park1',
        name: 'Test Park',
        entityType: 'PARK',
        parentId: 'dest1',
        timezone: 'America/New_York',
      } as Entity,
      {
        id: 'attraction1',
        name: 'Test Ride',
        entityType: 'ATTRACTION',
        parentId: 'park1',
        timezone: 'America/New_York',
      } as Entity,
    ];

    const resolved = destination.testResolveHierarchy(entities);

    expect(resolved[2].parkId).toBe('park1');
    expect(resolved[2].destinationId).toBe('dest1');
  });

  test('should NOT set parkId for attraction at destination (no park parent)', () => {
    const entities: Entity[] = [
      {
        id: 'dest1',
        name: 'Disney Springs',
        entityType: 'DESTINATION',
        timezone: 'America/New_York',
      } as Entity,
      {
        id: 'attraction1',
        name: 'Train at Disney Springs',
        entityType: 'ATTRACTION',
        parentId: 'dest1',
        timezone: 'America/New_York',
      } as Entity,
    ];

    const resolved = destination.testResolveHierarchy(entities);

    expect(resolved[1].parkId).toBeUndefined();
    expect(resolved[1].destinationId).toBe('dest1');
  });

  test('should handle nested hierarchy (attraction -> restaurant -> park -> destination)', () => {
    const entities: Entity[] = [
      {
        id: 'dest1',
        name: 'Universal Orlando',
        entityType: 'DESTINATION',
        timezone: 'America/New_York',
      } as Entity,
      {
        id: 'park1',
        name: 'Islands of Adventure',
        entityType: 'PARK',
        parentId: 'dest1',
        timezone: 'America/New_York',
      } as Entity,
      {
        id: 'restaurant1',
        name: 'Three Broomsticks',
        entityType: 'RESTAURANT',
        parentId: 'park1',
        timezone: 'America/New_York',
      } as Entity,
      {
        id: 'attraction1',
        name: 'Hagrid Motorbike',
        entityType: 'ATTRACTION',
        parentId: 'park1',
        timezone: 'America/New_York',
      } as Entity,
    ];

    const resolved = destination.testResolveHierarchy(entities);

    // Restaurant should have parkId
    expect(resolved[2].parkId).toBe('park1');
    expect(resolved[2].destinationId).toBe('dest1');

    // Attraction should have parkId
    expect(resolved[3].parkId).toBe('park1');
    expect(resolved[3].destinationId).toBe('dest1');
  });

  test('should handle hotels inside parks vs at destination', () => {
    const entities: Entity[] = [
      {
        id: 'dest1',
        name: 'Universal Orlando',
        entityType: 'DESTINATION',
        timezone: 'America/New_York',
      } as Entity,
      {
        id: 'park1',
        name: 'EPCOT',
        entityType: 'PARK',
        parentId: 'dest1',
        timezone: 'America/New_York',
      } as Entity,
      {
        id: 'hotel1',
        name: 'Hotel Inside Park',
        entityType: 'HOTEL',
        parentId: 'park1',
        timezone: 'America/New_York',
      } as Entity,
      {
        id: 'hotel2',
        name: 'Hotel at CityWalk',
        entityType: 'HOTEL',
        parentId: 'dest1',
        timezone: 'America/New_York',
      } as Entity,
    ];

    const resolved = destination.testResolveHierarchy(entities);

    // Hotel inside park
    expect(resolved[2].parkId).toBe('park1');
    expect(resolved[2].destinationId).toBe('dest1');

    // Hotel at destination
    expect(resolved[3].parkId).toBeUndefined();
    expect(resolved[3].destinationId).toBe('dest1');
  });

  test('should detect circular references', () => {
    const entities: Entity[] = [
      {
        id: 'entity1',
        name: 'Entity 1',
        entityType: 'ATTRACTION',
        parentId: 'entity2',
        timezone: 'America/New_York',
      } as Entity,
      {
        id: 'entity2',
        name: 'Entity 2',
        entityType: 'ATTRACTION',
        parentId: 'entity1',
        timezone: 'America/New_York',
      } as Entity,
    ];

    expect(() => {
      destination.testResolveHierarchy(entities);
    }).toThrow('Circular parent reference');
  });

  test('should preserve existing destinationId if no destination found in chain', () => {
    const entities: Entity[] = [
      {
        id: 'attraction1',
        name: 'Orphaned Attraction',
        entityType: 'ATTRACTION',
        destinationId: 'preset-dest',
        timezone: 'America/New_York',
      } as Entity,
    ];

    const resolved = destination.testResolveHierarchy(entities);

    // Should preserve preset destinationId
    expect(resolved[0].destinationId).toBe('preset-dest');
    expect(resolved[0].parkId).toBeUndefined();
  });

  test('should throw error when entity has no destination', () => {
    const entities: Entity[] = [
      {
        id: 'attraction1',
        name: 'Orphaned Attraction',
        entityType: 'ATTRACTION',
        timezone: 'America/New_York',
      } as Entity,
    ];

    expect(() => {
      destination.testResolveHierarchy(entities);
    }).toThrow('has no DESTINATION in parent chain');
  });

  test('should throw error when park has no destination parent', () => {
    const entities: Entity[] = [
      {
        id: 'park1',
        name: 'Orphaned Park',
        entityType: 'PARK',
        timezone: 'America/New_York',
      } as Entity,
    ];

    expect(() => {
      destination.testResolveHierarchy(entities);
    }).toThrow('has no DESTINATION in parent chain');
  });
});
