/**
 * Tests for destinationRegistry utility functions:
 * getAllCategories, listDestinationIds, getDestinationsByCategory (array category),
 * and registerDestination.
 *
 * These tests use registerDestination() to inject known test entries rather than
 * relying on auto-discovery of the full parks directory.
 */

import {
  registerDestination,
  getAllCategories,
  listDestinationIds,
  getDestinationsByCategory,
  getDestinationById,
} from '../destinationRegistry.js';
import {Destination} from '../destination.js';
import {Entity, LiveData, EntitySchedule} from '@themeparks/typelib';

// Minimal concrete Destination for registry tests
class TestDestA extends Destination {
  protected async buildEntityList(): Promise<Entity[]> { return []; }
  protected async buildLiveData(): Promise<LiveData[]> { return []; }
  protected async buildSchedules(): Promise<EntitySchedule[]> { return []; }
  async getDestinations(): Promise<Entity[]> { return []; }
}

class TestDestB extends Destination {
  protected async buildEntityList(): Promise<Entity[]> { return []; }
  protected async buildLiveData(): Promise<LiveData[]> { return []; }
  protected async buildSchedules(): Promise<EntitySchedule[]> { return []; }
  async getDestinations(): Promise<Entity[]> { return []; }
}

class TestDestMultiCat extends Destination {
  protected async buildEntityList(): Promise<Entity[]> { return []; }
  protected async buildLiveData(): Promise<LiveData[]> { return []; }
  protected async buildSchedules(): Promise<EntitySchedule[]> { return []; }
  async getDestinations(): Promise<Entity[]> { return []; }
}

// Unique IDs unlikely to clash with real parks
const ID_A = '__test_registry_a__';
const ID_B = '__test_registry_b__';
const ID_MULTI = '__test_registry_multi__';

beforeAll(() => {
  registerDestination({id: ID_A, name: 'Test Dest A', DestinationClass: TestDestA as any, category: 'TestCatX'});
  registerDestination({id: ID_B, name: 'Test Dest B', DestinationClass: TestDestB as any, category: 'TestCatY'});
  registerDestination({id: ID_MULTI, name: 'Test Multi Cat', DestinationClass: TestDestMultiCat as any, category: ['TestCatX', 'TestCatZ']});
});

describe('destinationRegistry', () => {
  describe('registerDestination', () => {
    test('registered entry is findable by id', async () => {
      const entry = await getDestinationById(ID_A);
      expect(entry).toBeDefined();
      expect(entry?.name).toBe('Test Dest A');
      expect(entry?.category).toBe('TestCatX');
    });

    test('duplicate registration is ignored (no double entry)', async () => {
      registerDestination({id: ID_A, name: 'Duplicate', DestinationClass: TestDestA as any, category: 'Other'});
      const entry = await getDestinationById(ID_A);
      // Name should still be the original, not 'Duplicate'
      expect(entry?.name).toBe('Test Dest A');
    });
  });

  describe('listDestinationIds', () => {
    test('includes registered test IDs', async () => {
      const ids = await listDestinationIds();
      expect(ids).toContain(ID_A);
      expect(ids).toContain(ID_B);
      expect(ids).toContain(ID_MULTI);
    });
  });

  describe('getAllCategories', () => {
    test('includes categories from single-category and multi-category entries', async () => {
      const categories = await getAllCategories();
      expect(categories).toContain('TestCatX');
      expect(categories).toContain('TestCatY');
      expect(categories).toContain('TestCatZ');
    });

    test('returns sorted list without duplicates', async () => {
      const categories = await getAllCategories();
      // TestCatX appears in both ID_A and ID_MULTI — should appear once
      const xCount = categories.filter(c => c === 'TestCatX').length;
      expect(xCount).toBe(1);
      // List should be sorted
      const sorted = [...categories].sort();
      expect(categories).toEqual(sorted);
    });
  });

  describe('getDestinationsByCategory', () => {
    test('returns destinations with matching string category', async () => {
      const results = await getDestinationsByCategory('TestCatY');
      const ids = results.map(r => r.id);
      expect(ids).toContain(ID_B);
      expect(ids).not.toContain(ID_A);
    });

    test('returns destinations where array category includes the target', async () => {
      const results = await getDestinationsByCategory('TestCatZ');
      const ids = results.map(r => r.id);
      expect(ids).toContain(ID_MULTI);
      expect(ids).not.toContain(ID_A);
      expect(ids).not.toContain(ID_B);
    });

    test('returns both string-match and array-match destinations for shared category', async () => {
      // TestCatX: ID_A (string) and ID_MULTI (array)
      const results = await getDestinationsByCategory('TestCatX');
      const ids = results.map(r => r.id);
      expect(ids).toContain(ID_A);
      expect(ids).toContain(ID_MULTI);
    });

    test('returns empty array for unknown category', async () => {
      const results = await getDestinationsByCategory('__nonexistent_cat__');
      expect(results).toHaveLength(0);
    });
  });
});
