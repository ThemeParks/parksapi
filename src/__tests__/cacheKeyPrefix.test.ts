/**
 * Tests for cache key prefix functionality
 */

import {CacheLib, cache} from '../cache';
import {Destination} from '../destination';

describe('Cache Key Prefix', () => {
  beforeEach(() => {
    CacheLib.clear();
  });

  afterAll(() => {
    CacheLib.clear();
  });

  describe('getCacheKeyPrefix() method', () => {
    it('should use getCacheKeyPrefix() method for cache keys', async () => {
      class TestDestination extends Destination {
        parkId = '123';

        getCacheKeyPrefix(): string {
          return `test:${this.parkId}`;
        }

        @cache({ttlSeconds: 60})
        async getData(): Promise<string> {
          return 'data';
        }
      }

      const dest1 = new TestDestination();
      const dest2 = new TestDestination();
      dest2.parkId = '456';

      // Call both destinations
      await dest1.getData();
      await dest2.getData();

      // Should have 2 separate cache entries
      const keys = CacheLib.keys();
      expect(keys.length).toBe(2);
      expect(keys.some(k => k.includes('test:123'))).toBe(true);
      expect(keys.some(k => k.includes('test:456'))).toBe(true);
    });

    it('should support async getCacheKeyPrefix()', async () => {
      class TestDestination extends Destination {
        parkId = 'async123';

        async getCacheKeyPrefix(): Promise<string> {
          return `async:${this.parkId}`;
        }

        @cache({ttlSeconds: 60})
        async getData(): Promise<string> {
          return 'data';
        }
      }

      const dest = new TestDestination();
      await dest.getData();

      const keys = CacheLib.keys();
      expect(keys.length).toBe(1);
      expect(keys[0]).toContain('async:async123');
    });

    it('should prevent cache collisions between instances', async () => {
      let counter1 = 0;
      let counter2 = 0;

      class TestDestination extends Destination {
        parkId = '';

        getCacheKeyPrefix(): string {
          return `test:${this.parkId}`;
        }

        @cache({ttlSeconds: 60})
        async getData(): Promise<number> {
          // Each instance should have its own counter
          if (this.parkId === '1') {
            return ++counter1;
          } else {
            return ++counter2;
          }
        }
      }

      const dest1 = new TestDestination();
      dest1.parkId = '1';
      const dest2 = new TestDestination();
      dest2.parkId = '2';

      // First calls - should execute and cache
      const result1 = await dest1.getData();
      const result2 = await dest2.getData();
      expect(result1).toBe(1);
      expect(result2).toBe(1);

      // Second calls - should return cached values (counters don't increment)
      const result1b = await dest1.getData();
      const result2b = await dest2.getData();
      expect(result1b).toBe(1); // Still 1 (from cache)
      expect(result2b).toBe(1); // Still 1 (from cache)

      // Verify separate cache entries exist
      const keys = CacheLib.keys();
      expect(keys.length).toBe(2);
    });
  });

  describe('cacheKeyPrefix property', () => {
    it('should use cacheKeyPrefix property for cache keys', async () => {
      class TestDestination extends Destination {
        constructor() {
          super();
          this.cacheKeyPrefix = 'prefix:123';
        }

        @cache({ttlSeconds: 60})
        async getData(): Promise<string> {
          return 'data';
        }
      }

      const dest = new TestDestination();
      await dest.getData();

      const keys = CacheLib.keys();
      expect(keys.length).toBe(1);
      expect(keys[0]).toContain('prefix:123');
    });

    it('should give precedence to getCacheKeyPrefix() over property', async () => {
      class TestDestination extends Destination {
        constructor() {
          super();
          this.cacheKeyPrefix = 'property:prefix';
        }

        getCacheKeyPrefix(): string {
          return 'method:prefix';
        }

        @cache({ttlSeconds: 60})
        async getData(): Promise<string> {
          return 'data';
        }
      }

      const dest = new TestDestination();
      await dest.getData();

      const keys = CacheLib.keys();
      expect(keys.length).toBe(1);
      expect(keys[0]).toContain('method:prefix');
      expect(keys[0]).not.toContain('property:prefix');
    });
  });

  describe('prefix with custom cache keys', () => {
    it('should prepend prefix to custom cache keys', async () => {
      class TestDestination extends Destination {
        getCacheKeyPrefix(): string {
          return 'custom:prefix';
        }

        @cache({ttlSeconds: 60, key: 'myCustomKey'})
        async getData(): Promise<string> {
          return 'data';
        }
      }

      const dest = new TestDestination();
      await dest.getData();

      const keys = CacheLib.keys();
      expect(keys.length).toBe(1);
      expect(keys[0]).toBe('custom:prefix:myCustomKey');
    });

    it('should prepend prefix to function-based cache keys', async () => {
      class TestDestination extends Destination {
        parkId = '789';

        getCacheKeyPrefix(): string {
          return 'func:prefix';
        }

        @cache({ttlSeconds: 60, key: function() { return `dynamic:${this.parkId}`; }})
        async getData(): Promise<string> {
          return 'data';
        }
      }

      const dest = new TestDestination();
      await dest.getData();

      const keys = CacheLib.keys();
      expect(keys.length).toBe(1);
      expect(keys[0]).toBe('func:prefix:dynamic:789');
    });
  });

  describe('prefix with method arguments', () => {
    it('should include arguments in cache key with prefix', async () => {
      class TestDestination extends Destination {
        getCacheKeyPrefix(): string {
          return 'args:prefix';
        }

        @cache({ttlSeconds: 60})
        async getData(arg1: string, arg2: number): Promise<string> {
          return `${arg1}:${arg2}`;
        }
      }

      const dest = new TestDestination();
      await dest.getData('test', 123);

      const keys = CacheLib.keys();
      expect(keys.length).toBe(1);
      expect(keys[0]).toContain('args:prefix');
      expect(keys[0]).toContain('"test"');
      expect(keys[0]).toContain('123');
    });
  });

  describe('no prefix (default behavior)', () => {
    it('should work without prefix', async () => {
      class TestDestination extends Destination {
        @cache({ttlSeconds: 60})
        async getData(): Promise<string> {
          return 'data';
        }
      }

      const dest = new TestDestination();
      await dest.getData();

      const keys = CacheLib.keys();
      expect(keys.length).toBe(1);
      // Should use default className:methodName:args format
      expect(keys[0]).toContain('TestDestination:getData');
    });
  });
});
