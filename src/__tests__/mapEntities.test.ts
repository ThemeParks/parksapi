/**
 * Test Destination.mapEntities() helper
 */

import {Destination, EntityMapperConfig} from '../destination.js';
import {Entity} from '../parkTypes.js';

// Mock destination class for testing mapEntities
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

  // Expose protected mapEntities method for testing
  public testMapEntities<T>(items: T[], config: EntityMapperConfig<T>): Entity[] {
    return this.mapEntities(items, config);
  }
}

// Sample API response types for testing
type APIAttraction = {
  Id: number;
  MblDisplayName: string;
  VenueId: number;
  Latitude: number;
  Longitude: number;
  IsActive: boolean;
  Tags?: string[];
};

type APIPark = {
  parkId: string;
  parkName: string;
  parentDestination: string;
  coordinates: {
    lat: number;
    lng: number;
  };
  status: 'open' | 'closed';
};

describe('Destination.mapEntities()', () => {
  let destination: MockDestination;

  beforeEach(() => {
    destination = new MockDestination();
  });

  describe('Basic Field Mapping', () => {
    test('should map simple field names', () => {
      const attractions: APIAttraction[] = [
        {
          Id: 123,
          MblDisplayName: 'Test Ride',
          VenueId: 456,
          Latitude: 28.3747,
          Longitude: -81.5494,
          IsActive: true
        }
      ];

      const entities = destination.testMapEntities(attractions, {
        idField: 'Id',
        nameField: 'MblDisplayName',
        entityType: 'ATTRACTION',
        destinationId: 'test-dest',
        timezone: 'America/New_York'
      });

      expect(entities).toHaveLength(1);
      expect(entities[0].id).toBe('123');
      expect(entities[0].name).toBe('Test Ride');
      expect(entities[0].entityType).toBe('ATTRACTION');
      expect(entities[0].destinationId).toBe('test-dest');
      expect(entities[0].timezone).toBe('America/New_York');
    });

    test('should convert numeric IDs to strings', () => {
      const items = [
        { Id: 12345, Name: 'Item 1' }
      ];

      const entities = destination.testMapEntities(items, {
        idField: 'Id',
        nameField: 'Name',
        entityType: 'ATTRACTION',
        destinationId: 'test',
        timezone: 'UTC'
      });

      expect(entities[0].id).toBe('12345');
      expect(typeof entities[0].id).toBe('string');
    });

    test('should handle string IDs', () => {
      const items = [
        { id: 'abc-123', name: 'Item 1' }
      ];

      const entities = destination.testMapEntities(items, {
        idField: 'id',
        nameField: 'name',
        entityType: 'PARK',
        destinationId: 'test',
        timezone: 'UTC'
      });

      expect(entities[0].id).toBe('abc-123');
    });
  });

  describe('Extractor Functions', () => {
    test('should use extractor function for ID', () => {
      const parks: APIPark[] = [
        {
          parkId: 'park-1',
          parkName: 'Test Park',
          parentDestination: 'dest-1',
          coordinates: { lat: 28.5, lng: -81.5 },
          status: 'open'
        }
      ];

      const entities = destination.testMapEntities(parks, {
        idField: (park) => park.parkId,
        nameField: 'parkName',
        entityType: 'PARK',
        destinationId: 'dest',
        timezone: 'America/New_York'
      });

      expect(entities[0].id).toBe('park-1');
    });

    test('should use extractor function for name', () => {
      const parks: APIPark[] = [
        {
          parkId: 'park-1',
          parkName: 'Test Park',
          parentDestination: 'dest-1',
          coordinates: { lat: 28.5, lng: -81.5 },
          status: 'open'
        }
      ];

      const entities = destination.testMapEntities(parks, {
        idField: 'parkId',
        nameField: (park) => `${park.parkName} (${park.status})`,
        entityType: 'PARK',
        destinationId: 'dest',
        timezone: 'America/New_York'
      });

      expect(entities[0].name).toBe('Test Park (open)');
    });

    test('should use extractor function for parentId', () => {
      const parks: APIPark[] = [
        {
          parkId: 'park-1',
          parkName: 'Test Park',
          parentDestination: 'dest-1',
          coordinates: { lat: 28.5, lng: -81.5 },
          status: 'open'
        }
      ];

      const entities = destination.testMapEntities(parks, {
        idField: 'parkId',
        nameField: 'parkName',
        entityType: 'PARK',
        parentIdField: (park) => park.parentDestination,
        destinationId: 'dest',
        timezone: 'America/New_York'
      });

      expect(entities[0].parentId).toBe('dest-1');
    });

    test('should use extractor function for location', () => {
      const parks: APIPark[] = [
        {
          parkId: 'park-1',
          parkName: 'Test Park',
          parentDestination: 'dest-1',
          coordinates: { lat: 28.5, lng: -81.5 },
          status: 'open'
        }
      ];

      const entities = destination.testMapEntities(parks, {
        idField: 'parkId',
        nameField: 'parkName',
        entityType: 'PARK',
        locationFields: {
          lat: (park) => park.coordinates.lat,
          lng: (park) => park.coordinates.lng
        },
        destinationId: 'dest',
        timezone: 'America/New_York'
      });

      expect(entities[0].location).toEqual({
        latitude: 28.5,
        longitude: -81.5
      });
    });
  });

  describe('Parent Relationships', () => {
    test('should set parentId from field', () => {
      const attractions: APIAttraction[] = [
        {
          Id: 1,
          MblDisplayName: 'Ride 1',
          VenueId: 100,
          Latitude: 28.5,
          Longitude: -81.5,
          IsActive: true
        }
      ];

      const entities = destination.testMapEntities(attractions, {
        idField: 'Id',
        nameField: 'MblDisplayName',
        entityType: 'ATTRACTION',
        parentIdField: 'VenueId',
        destinationId: 'dest',
        timezone: 'UTC'
      });

      expect(entities[0].parentId).toBe('100');
    });

    test('should not set parentId if field is undefined', () => {
      const items = [
        { id: 1, name: 'Item', parent: undefined }
      ];

      const entities = destination.testMapEntities(items, {
        idField: 'id',
        nameField: 'name',
        entityType: 'PARK',
        parentIdField: 'parent',
        destinationId: 'dest',
        timezone: 'UTC'
      });

      expect(entities[0].parentId).toBeUndefined();
    });

    test('should not set parentId if field is null', () => {
      const items = [
        { id: 1, name: 'Item', parent: null }
      ];

      const entities = destination.testMapEntities(items, {
        idField: 'id',
        nameField: 'name',
        entityType: 'PARK',
        parentIdField: 'parent',
        destinationId: 'dest',
        timezone: 'UTC'
      });

      expect(entities[0].parentId).toBeUndefined();
    });

    test('should not set parentId if parentIdField not provided', () => {
      const items = [
        { id: 1, name: 'Item' }
      ];

      const entities = destination.testMapEntities(items, {
        idField: 'id',
        nameField: 'name',
        entityType: 'DESTINATION',
        destinationId: 'dest',
        timezone: 'UTC'
      });

      expect(entities[0].parentId).toBeUndefined();
    });
  });

  describe('Location Mapping', () => {
    test('should map location from field names', () => {
      const attractions: APIAttraction[] = [
        {
          Id: 1,
          MblDisplayName: 'Ride',
          VenueId: 100,
          Latitude: 28.3747,
          Longitude: -81.5494,
          IsActive: true
        }
      ];

      const entities = destination.testMapEntities(attractions, {
        idField: 'Id',
        nameField: 'MblDisplayName',
        entityType: 'ATTRACTION',
        locationFields: {
          lat: 'Latitude',
          lng: 'Longitude'
        },
        destinationId: 'dest',
        timezone: 'UTC'
      });

      expect(entities[0].location).toEqual({
        latitude: 28.3747,
        longitude: -81.5494
      });
    });

    test('should not set location if fields are undefined', () => {
      const items = [
        { id: 1, name: 'Item', lat: undefined, lng: undefined }
      ];

      const entities = destination.testMapEntities(items, {
        idField: 'id',
        nameField: 'name',
        entityType: 'ATTRACTION',
        locationFields: {
          lat: 'lat',
          lng: 'lng'
        },
        destinationId: 'dest',
        timezone: 'UTC'
      });

      expect(entities[0].location).toBeUndefined();
    });

    test('should not set location if fields are null', () => {
      const items = [
        { id: 1, name: 'Item', lat: null, lng: null }
      ];

      const entities = destination.testMapEntities(items, {
        idField: 'id',
        nameField: 'name',
        entityType: 'ATTRACTION',
        locationFields: {
          lat: 'lat',
          lng: 'lng'
        },
        destinationId: 'dest',
        timezone: 'UTC'
      });

      expect(entities[0].location).toBeUndefined();
    });

    test('should not set location if only one coordinate is provided', () => {
      const items = [
        { id: 1, name: 'Item', lat: 28.5, lng: null }
      ];

      const entities = destination.testMapEntities(items, {
        idField: 'id',
        nameField: 'name',
        entityType: 'ATTRACTION',
        locationFields: {
          lat: 'lat',
          lng: 'lng'
        },
        destinationId: 'dest',
        timezone: 'UTC'
      });

      expect(entities[0].location).toBeUndefined();
    });

    test('should not set location if locationFields not provided', () => {
      const items = [
        { id: 1, name: 'Item', lat: 28.5, lng: -81.5 }
      ];

      const entities = destination.testMapEntities(items, {
        idField: 'id',
        nameField: 'name',
        entityType: 'PARK',
        destinationId: 'dest',
        timezone: 'UTC'
      });

      expect(entities[0].location).toBeUndefined();
    });

    test('should convert location values to numbers', () => {
      const items = [
        { id: 1, name: 'Item', lat: '28.5', lng: '-81.5' }
      ];

      const entities = destination.testMapEntities(items, {
        idField: 'id',
        nameField: 'name',
        entityType: 'ATTRACTION',
        locationFields: {
          lat: 'lat',
          lng: 'lng'
        },
        destinationId: 'dest',
        timezone: 'UTC'
      });

      expect(entities[0].location).toEqual({
        latitude: 28.5,
        longitude: -81.5
      });
      expect(typeof entities[0].location?.latitude).toBe('number');
      expect(typeof entities[0].location?.longitude).toBe('number');
    });
  });

  describe('Filter Functionality', () => {
    test('should filter items based on filter function', () => {
      const attractions: APIAttraction[] = [
        { Id: 1, MblDisplayName: 'Active Ride', VenueId: 100, Latitude: 28.5, Longitude: -81.5, IsActive: true },
        { Id: 2, MblDisplayName: 'Inactive Ride', VenueId: 100, Latitude: 28.5, Longitude: -81.5, IsActive: false },
        { Id: 3, MblDisplayName: 'Another Active', VenueId: 100, Latitude: 28.5, Longitude: -81.5, IsActive: true }
      ];

      const entities = destination.testMapEntities(attractions, {
        idField: 'Id',
        nameField: 'MblDisplayName',
        entityType: 'ATTRACTION',
        filter: (attr) => attr.IsActive,
        destinationId: 'dest',
        timezone: 'UTC'
      });

      expect(entities).toHaveLength(2);
      expect(entities[0].name).toBe('Active Ride');
      expect(entities[1].name).toBe('Another Active');
    });

    test('should return all items if filter function returns true for all', () => {
      const items = [
        { id: 1, name: 'Item 1' },
        { id: 2, name: 'Item 2' }
      ];

      const entities = destination.testMapEntities(items, {
        idField: 'id',
        nameField: 'name',
        entityType: 'PARK',
        filter: () => true,
        destinationId: 'dest',
        timezone: 'UTC'
      });

      expect(entities).toHaveLength(2);
    });

    test('should return empty array if filter function returns false for all', () => {
      const items = [
        { id: 1, name: 'Item 1' },
        { id: 2, name: 'Item 2' }
      ];

      const entities = destination.testMapEntities(items, {
        idField: 'id',
        nameField: 'name',
        entityType: 'PARK',
        filter: () => false,
        destinationId: 'dest',
        timezone: 'UTC'
      });

      expect(entities).toHaveLength(0);
    });

    test('should handle complex filter logic', () => {
      const attractions: APIAttraction[] = [
        { Id: 1, MblDisplayName: 'Ride A', VenueId: 100, Latitude: 28.5, Longitude: -81.5, IsActive: true, Tags: ['thrill'] },
        { Id: 2, MblDisplayName: 'Ride B', VenueId: 100, Latitude: 28.5, Longitude: -81.5, IsActive: true, Tags: ['family'] },
        { Id: 3, MblDisplayName: 'Ride C', VenueId: 100, Latitude: 28.5, Longitude: -81.5, IsActive: false, Tags: ['thrill'] }
      ];

      const entities = destination.testMapEntities(attractions, {
        idField: 'Id',
        nameField: 'MblDisplayName',
        entityType: 'ATTRACTION',
        filter: (attr) => attr.IsActive && (attr.Tags?.includes('thrill') ?? false),
        destinationId: 'dest',
        timezone: 'UTC'
      });

      expect(entities).toHaveLength(1);
      expect(entities[0].name).toBe('Ride A');
    });

    test('should handle undefined filter (include all)', () => {
      const items = [
        { id: 1, name: 'Item 1' },
        { id: 2, name: 'Item 2' }
      ];

      const entities = destination.testMapEntities(items, {
        idField: 'id',
        nameField: 'name',
        entityType: 'PARK',
        destinationId: 'dest',
        timezone: 'UTC'
      });

      expect(entities).toHaveLength(2);
    });
  });

  describe('Transform Functionality', () => {
    test('should apply transform function to each entity', () => {
      const items = [
        { id: 1, name: 'Item', tags: ['tag1', 'tag2'] }
      ];

      const entities = destination.testMapEntities(items, {
        idField: 'id',
        nameField: 'name',
        entityType: 'ATTRACTION',
        destinationId: 'dest',
        timezone: 'UTC',
        transform: (entity, source) => {
          (entity as any).tags = source.tags;
          return entity;
        }
      });

      expect((entities[0] as any).tags).toEqual(['tag1', 'tag2']);
    });

    test('should provide both entity and source item to transform', () => {
      const attractions: APIAttraction[] = [
        {
          Id: 1,
          MblDisplayName: 'Ride',
          VenueId: 100,
          Latitude: 28.5,
          Longitude: -81.5,
          IsActive: true,
          Tags: ['thrill', 'outdoor']
        }
      ];

      const entities = destination.testMapEntities(attractions, {
        idField: 'Id',
        nameField: 'MblDisplayName',
        entityType: 'ATTRACTION',
        destinationId: 'dest',
        timezone: 'UTC',
        transform: (entity, source) => {
          (entity as any).isActive = source.IsActive;
          (entity as any).tagCount = source.Tags?.length || 0;
          return entity;
        }
      });

      expect((entities[0] as any).isActive).toBe(true);
      expect((entities[0] as any).tagCount).toBe(2);
    });

    test('should allow transform to modify entity', () => {
      const items = [
        { id: 1, name: 'Item Name', shortName: 'Item' }
      ];

      const entities = destination.testMapEntities(items, {
        idField: 'id',
        nameField: 'name',
        entityType: 'PARK',
        destinationId: 'dest',
        timezone: 'UTC',
        transform: (entity, source) => {
          // Override the name with shortName
          entity.name = source.shortName;
          return entity;
        }
      });

      expect(entities[0].name).toBe('Item');
    });

    test('should handle undefined transform (no transformation)', () => {
      const items = [
        { id: 1, name: 'Item' }
      ];

      const entities = destination.testMapEntities(items, {
        idField: 'id',
        nameField: 'name',
        entityType: 'PARK',
        destinationId: 'dest',
        timezone: 'UTC'
      });

      expect(entities[0].id).toBe('1');
      expect(entities[0].name).toBe('Item');
    });
  });

  describe('Multiple Entity Types', () => {
    test('should map DESTINATION entities', () => {
      const items = [{ id: 'dest-1', name: 'Test Destination' }];

      const entities = destination.testMapEntities(items, {
        idField: 'id',
        nameField: 'name',
        entityType: 'DESTINATION',
        destinationId: 'dest-1',
        timezone: 'America/New_York'
      });

      expect(entities[0].entityType).toBe('DESTINATION');
    });

    test('should map PARK entities', () => {
      const items = [{ id: 'park-1', name: 'Test Park' }];

      const entities = destination.testMapEntities(items, {
        idField: 'id',
        nameField: 'name',
        entityType: 'PARK',
        destinationId: 'dest',
        timezone: 'UTC'
      });

      expect(entities[0].entityType).toBe('PARK');
    });

    test('should map ATTRACTION entities', () => {
      const items = [{ id: 'attr-1', name: 'Test Ride' }];

      const entities = destination.testMapEntities(items, {
        idField: 'id',
        nameField: 'name',
        entityType: 'ATTRACTION',
        destinationId: 'dest',
        timezone: 'UTC'
      });

      expect(entities[0].entityType).toBe('ATTRACTION');
    });

    test('should map SHOW entities', () => {
      const items = [{ id: 'show-1', name: 'Test Show' }];

      const entities = destination.testMapEntities(items, {
        idField: 'id',
        nameField: 'name',
        entityType: 'SHOW',
        destinationId: 'dest',
        timezone: 'UTC'
      });

      expect(entities[0].entityType).toBe('SHOW');
    });

    test('should map RESTAURANT entities', () => {
      const items = [{ id: 'rest-1', name: 'Test Restaurant' }];

      const entities = destination.testMapEntities(items, {
        idField: 'id',
        nameField: 'name',
        entityType: 'RESTAURANT',
        destinationId: 'dest',
        timezone: 'UTC'
      });

      expect(entities[0].entityType).toBe('RESTAURANT');
    });
  });

  describe('Edge Cases', () => {
    test('should handle empty array', () => {
      const entities = destination.testMapEntities([], {
        idField: 'id',
        nameField: 'name',
        entityType: 'PARK',
        destinationId: 'dest',
        timezone: 'UTC'
      });

      expect(entities).toEqual([]);
    });

    test('should handle single item array', () => {
      const items = [{ id: 1, name: 'Only Item' }];

      const entities = destination.testMapEntities(items, {
        idField: 'id',
        nameField: 'name',
        entityType: 'PARK',
        destinationId: 'dest',
        timezone: 'UTC'
      });

      expect(entities).toHaveLength(1);
      expect(entities[0].name).toBe('Only Item');
    });

    test('should handle large arrays', () => {
      const items = Array.from({ length: 1000 }, (_, i) => ({
        id: i,
        name: `Item ${i}`
      }));

      const entities = destination.testMapEntities(items, {
        idField: 'id',
        nameField: 'name',
        entityType: 'ATTRACTION',
        destinationId: 'dest',
        timezone: 'UTC'
      });

      expect(entities).toHaveLength(1000);
      expect(entities[0].name).toBe('Item 0');
      expect(entities[999].name).toBe('Item 999');
    });

    test('should handle special characters in names', () => {
      const items = [
        { id: 1, name: "Test's Ride™" },
        { id: 2, name: 'Ride & Show®' },
        { id: 3, name: 'Ride <script>alert("xss")</script>' }
      ];

      const entities = destination.testMapEntities(items, {
        idField: 'id',
        nameField: 'name',
        entityType: 'ATTRACTION',
        destinationId: 'dest',
        timezone: 'UTC'
      });

      expect(entities[0].name).toBe("Test's Ride™");
      expect(entities[1].name).toBe('Ride & Show®');
      expect(entities[2].name).toBe('Ride <script>alert("xss")</script>');
    });

    test('should handle different timezones', () => {
      const timezones = [
        'America/New_York',
        'America/Los_Angeles',
        'Europe/London',
        'Asia/Tokyo',
        'Australia/Sydney'
      ];

      timezones.forEach(tz => {
        const entities = destination.testMapEntities([{ id: 1, name: 'Item' }], {
          idField: 'id',
          nameField: 'name',
          entityType: 'PARK',
          destinationId: 'dest',
          timezone: tz
        });

        expect(entities[0].timezone).toBe(tz);
      });
    });
  });

  describe('Combined Features', () => {
    test('should use all features together', () => {
      const attractions: APIAttraction[] = [
        {
          Id: 1,
          MblDisplayName: 'Active Thrill Ride',
          VenueId: 100,
          Latitude: 28.3747,
          Longitude: -81.5494,
          IsActive: true,
          Tags: ['thrill', 'outdoor']
        },
        {
          Id: 2,
          MblDisplayName: 'Inactive Ride',
          VenueId: 100,
          Latitude: 28.3747,
          Longitude: -81.5494,
          IsActive: false,
          Tags: ['family']
        },
        {
          Id: 3,
          MblDisplayName: 'Active Family Ride',
          VenueId: 200,
          Latitude: 28.4747,
          Longitude: -81.6494,
          IsActive: true,
          Tags: ['family', 'indoor']
        }
      ];

      const entities = destination.testMapEntities(attractions, {
        idField: (attr) => `attraction-${attr.Id}`,
        nameField: 'MblDisplayName',
        entityType: 'ATTRACTION',
        parentIdField: 'VenueId',
        locationFields: {
          lat: 'Latitude',
          lng: 'Longitude'
        },
        destinationId: 'universal-orlando',
        timezone: 'America/New_York',
        filter: (attr) => attr.IsActive,
        transform: (entity, source) => {
          (entity as any).tags = source.Tags;
          (entity as any).rideType = source.Tags?.includes('thrill') ? 'THRILL' : 'FAMILY';
          return entity;
        }
      });

      expect(entities).toHaveLength(2);

      expect(entities[0].id).toBe('attraction-1');
      expect(entities[0].name).toBe('Active Thrill Ride');
      expect(entities[0].parentId).toBe('100');
      expect(entities[0].location).toEqual({ latitude: 28.3747, longitude: -81.5494 });
      expect((entities[0] as any).rideType).toBe('THRILL');

      expect(entities[1].id).toBe('attraction-3');
      expect(entities[1].name).toBe('Active Family Ride');
      expect(entities[1].parentId).toBe('200');
      expect((entities[1] as any).rideType).toBe('FAMILY');
    });
  });
});
