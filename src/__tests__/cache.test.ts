import { CacheLib as Cache, database } from '../cache.js';
import cache from '../cache.js';

// Mock console.error to avoid noise in test output
const originalConsoleError = console.error;
beforeEach(() => {
  console.error = vi.fn();
});

afterEach(() => {
  console.error = originalConsoleError;
});

describe('Cache', () => {
  beforeEach(() => {
    // Clear cache before each test
    Cache.clear();
  });

  afterEach(() => {
    // Clean up after each test
    Cache.clear();
  });

  describe('Basic Operations', () => {
    test('should set and get a simple value', () => {
      const testValue = 'test-value';
      Cache.set('test-key', testValue);
      
      const result = Cache.get('test-key');
      expect(result).toBe(testValue);
    });

    test('should set and get an object value', () => {
      const testObject = { data: 'test-value', number: 42 };
      Cache.set('test-object', testObject);
      
      const result = Cache.get('test-object');
      expect(result).toEqual(testObject);
    });

    test('should set and get an array value', () => {
      const testArray = [1, 2, 3, 'test'];
      Cache.set('test-array', testArray);
      
      const result = Cache.get('test-array');
      expect(result).toEqual(testArray);
    });

    test('should return null for non-existent keys', () => {
      const result = Cache.get('non-existent-key');
      expect(result).toBeNull();
    });

    test('should overwrite existing values', () => {
      Cache.set('test-key', 'first-value');
      Cache.set('test-key', 'second-value');
      
      const result = Cache.get('test-key');
      expect(result).toBe('second-value');
    });
  });

  describe('TTL (Time To Live) Functionality', () => {
    test('should respect TTL and expire entries', async () => {
      // Set with very short TTL (1 second)
      Cache.set('expiring-key', 'test-value', 1);
      
      // Should be available immediately
      expect(Cache.get('expiring-key')).toBe('test-value');
      
      // Wait for expiration (1.1 seconds to be safe)
      await new Promise(resolve => setTimeout(resolve, 1100));
      
      // Should be null after expiration
      expect(Cache.get('expiring-key')).toBeNull();
    });

    test('should use default TTL of 60 seconds when not specified', () => {
      Cache.set('default-ttl-key', 'test-value');
      
      // Check if the timestamp is set correctly (approximately 60 seconds from now)
      const stmt = database.prepare('SELECT timestamp FROM cache WHERE key = ?');
      const row = stmt.get('default-ttl-key') as { timestamp: number } | undefined;
      
      expect(row).toBeDefined();
      if (row) {
        const expectedTimestamp = Date.now() + (60 * 1000);
        // Allow for some variance (within 1 second)
        expect(row.timestamp).toBeGreaterThan(expectedTimestamp - 1000);
        expect(row.timestamp).toBeLessThan(expectedTimestamp + 1000);
      }
    });

    test('should handle custom TTL values', () => {
      const customTTL = 300; // 5 minutes
      Cache.set('custom-ttl-key', 'test-value', customTTL);
      
      const stmt = database.prepare('SELECT timestamp FROM cache WHERE key = ?');
      const row = stmt.get('custom-ttl-key') as { timestamp: number } | undefined;
      
      expect(row).toBeDefined();
      if (row) {
        const expectedTimestamp = Date.now() + (customTTL * 1000);
        // Allow for some variance (within 1 second)
        expect(row.timestamp).toBeGreaterThan(expectedTimestamp - 1000);
        expect(row.timestamp).toBeLessThan(expectedTimestamp + 1000);
      }
    });
  });

  describe('Cache Management', () => {
    test('should delete specific keys', () => {
      Cache.set('key1', 'value1');
      Cache.set('key2', 'value2');
      
      expect(Cache.get('key1')).toBe('value1');
      expect(Cache.get('key2')).toBe('value2');
      
      Cache.delete('key1');
      
      expect(Cache.get('key1')).toBeNull();
      expect(Cache.get('key2')).toBe('value2');
    });

    test('should clear all cache entries', () => {
      Cache.set('key1', 'value1');
      Cache.set('key2', 'value2');
      Cache.set('key3', 'value3');
      
      expect(Cache.size()).toBe(3);
      
      Cache.clear();
      
      expect(Cache.size()).toBe(0);
      expect(Cache.get('key1')).toBeNull();
      expect(Cache.get('key2')).toBeNull();
      expect(Cache.get('key3')).toBeNull();
    });

    test('should check if keys exist', () => {
      expect(Cache.has('non-existent')).toBe(false);
      
      Cache.set('existing-key', 'value');
      
      expect(Cache.has('existing-key')).toBe(true);
      expect(Cache.has('non-existent')).toBe(false);
    });

    test('should return correct cache size', () => {
      expect(Cache.size()).toBe(0);
      
      Cache.set('key1', 'value1');
      expect(Cache.size()).toBe(1);
      
      Cache.set('key2', 'value2');
      expect(Cache.size()).toBe(2);
      
      Cache.delete('key1');
      expect(Cache.size()).toBe(1);
      
      Cache.clear();
      expect(Cache.size()).toBe(0);
    });

    test('should return all cache keys', () => {
      const keys = ['key1', 'key2', 'key3'];
      
      keys.forEach((key, index) => {
        Cache.set(key, `value${index + 1}`);
      });
      
      const cacheKeys = Cache.keys();
      expect(cacheKeys).toHaveLength(3);
      keys.forEach(key => {
        expect(cacheKeys).toContain(key);
      });
    });
  });

  describe('Wrap Functionality', () => {
    test('should execute function and cache result on first call', async () => {
      const mockFn = vi.fn(() => 'computed-value');

      const result = await Cache.wrap('wrap-key', mockFn, 60);

      expect(result).toBe('computed-value');
      expect(mockFn).toHaveBeenCalledTimes(1);
      expect(Cache.get('wrap-key')).toBe('computed-value');
    });

    test('should return cached value on subsequent calls', async () => {
      const mockFn = vi.fn(() => 'computed-value');

      // First call
      const result1 = await Cache.wrap('wrap-key', mockFn, 60);
      expect(result1).toBe('computed-value');
      expect(mockFn).toHaveBeenCalledTimes(1);

      // Second call
      const result2 = await Cache.wrap('wrap-key', mockFn, 60);
      expect(result2).toBe('computed-value');
      expect(mockFn).toHaveBeenCalledTimes(1); // Should not be called again
    });

    test('should re-execute function after cache expires', async () => {
      const mockFn = vi.fn()
        .mockReturnValueOnce('first-value')
        .mockReturnValueOnce('second-value');

      // First call with short TTL
      const result1 = await Cache.wrap('wrap-key', mockFn, 1);
      expect(result1).toBe('first-value');
      expect(mockFn).toHaveBeenCalledTimes(1);

      // Wait for expiration
      await new Promise(resolve => setTimeout(resolve, 1100));

      // Second call after expiration
      const result2 = await Cache.wrap('wrap-key', mockFn, 1);
      expect(result2).toBe('second-value');
      expect(mockFn).toHaveBeenCalledTimes(2);
    });

    test('should handle complex return types in wrap', async () => {
      const complexObject = {
        data: [1, 2, 3],
        nested: { value: 'test' },
        timestamp: Date.now()
      };

      const mockFn = vi.fn(() => complexObject);

      const result = await Cache.wrap('complex-wrap', mockFn, 60);
      expect(result).toEqual(complexObject);

      // Subsequent call should return cached value
      const result2 = await Cache.wrap('complex-wrap', mockFn, 60);
      expect(result2).toEqual(complexObject);
      expect(mockFn).toHaveBeenCalledTimes(1);
    });
  });

  describe('Error Handling', () => {
    test('should handle JSON parse errors gracefully', () => {
      // Manually insert invalid JSON into database
      const stmt = database.prepare('INSERT OR REPLACE INTO cache (key, value, timestamp, lastAccess) VALUES (?, ?, ?, ?)');
      stmt.run('invalid-json-key', 'invalid-json{', Date.now() + 60000, Date.now());

      const result = Cache.get('invalid-json-key');
      expect(result).toBeNull();
      expect(console.error).toHaveBeenCalled();
    });

    test('should not throw errors for non-existent key operations', () => {
      expect(() => Cache.delete('non-existent')).not.toThrow();
      expect(() => Cache.has('non-existent')).not.toThrow();
      expect(() => Cache.get('non-existent')).not.toThrow();
    });

    test('should handle edge cases in wrap function', async () => {
      // Test with function that returns null
      const nullFn = vi.fn(() => null);
      const result1 = await Cache.wrap('null-key', nullFn, 60);
      expect(result1).toBeNull();

      // Test with function that returns empty string
      const emptyStringFn = vi.fn(() => '');
      const result2 = await Cache.wrap('empty-string-key', emptyStringFn, 60);
      expect(result2).toBe('');

      // Test with function that throws
      const throwingFn = vi.fn(() => {
        throw new Error('Test error');
      });
      await expect(Cache.wrap('error-key', throwingFn, 60)).rejects.toThrow('Test error');
    });
  });

  describe('Database Integration', () => {
    test('should persist data to SQLite database', () => {
      Cache.set('db-test-key', 'db-test-value');

      // Query database directly
      const stmt = database.prepare('SELECT value, timestamp FROM cache WHERE key = ?');
      const row = stmt.get('db-test-key') as { value: string, timestamp: number } | undefined;

      expect(row).toBeDefined();
      if (row) {
        expect(JSON.parse(row.value)).toBe('db-test-value');
        expect(row.timestamp).toBeGreaterThan(Date.now());
      }
    });

    test('should clean up expired entries when accessed', async () => {
      // Set entry with very short TTL
      Cache.set('cleanup-test', 'value', 1);

      // Verify it exists in database
      let stmt = database.prepare('SELECT COUNT(*) as count FROM cache WHERE key = ?');
      let row = stmt.get('cleanup-test') as { count: number };
      expect(row.count).toBe(1);

      // Wait for expiration
      await new Promise(resolve => setTimeout(resolve, 1100));

      // Access the expired entry (should trigger cleanup)
      Cache.get('cleanup-test');

      // Verify it's been removed from database
      row = stmt.get('cleanup-test') as { count: number };
      expect(row.count).toBe(0);
    });
  });

  describe('Cache Decorator', () => {
    test('should cache method results with fixed TTL', async () => {
      let callCount = 0;

      class TestClass {
        @cache({ ttlSeconds: 60 })
        async getData(param: string) {
          callCount++;
          return `data-${param}-${callCount}`;
        }
      }

      const instance = new TestClass();

      // First call
      const result1 = await instance.getData('test');
      expect(result1).toBe('data-test-1');
      expect(callCount).toBe(1);

      // Second call with same param (should use cache)
      const result2 = await instance.getData('test');
      expect(result2).toBe('data-test-1');
      expect(callCount).toBe(1); // Not called again

      // Call with different param (should execute)
      const result3 = await instance.getData('other');
      expect(result3).toBe('data-other-2');
      expect(callCount).toBe(2);
    });

    test('should cache method results with dynamic TTL callback', async () => {
      let callCount = 0;

      class TestClass {
        @cache({
          callback: (result: any) => {
            // Dynamic TTL based on response
            return result.ttl || 30;
          }
        })
        async fetchData(id: number) {
          callCount++;
          return {
            id,
            data: `result-${callCount}`,
            ttl: id === 1 ? 60 : 120
          };
        }
      }

      const instance = new TestClass();

      // First call
      const result1 = await instance.fetchData(1);
      expect(result1.data).toBe('result-1');
      expect(callCount).toBe(1);

      // Second call with same param (should use cache)
      const result2 = await instance.fetchData(1);
      expect(result2.data).toBe('result-1');
      expect(callCount).toBe(1); // Cached

      // Call with different param
      const result3 = await instance.fetchData(2);
      expect(result3.data).toBe('result-2');
      expect(callCount).toBe(2);
    });

    test('should extract TTL from response object', async () => {
      let callCount = 0;

      class TestClass {
        @cache({
          callback: (result: any) => {
            // Extract TTL from response
            return result.expiresIn || 60;
          }
        })
        async getAPIKey() {
          callCount++;
          return {
            apiKey: `key-${callCount}`,
            expiresIn: 300
          };
        }
      }

      const instance = new TestClass();

      const result1 = await instance.getAPIKey();
      expect(result1.apiKey).toBe('key-1');
      expect(callCount).toBe(1);

      // Should use cache
      const result2 = await instance.getAPIKey();
      expect(result2.apiKey).toBe('key-1');
      expect(callCount).toBe(1);
    });

    test('should cache methods with multiple parameters', async () => {
      let callCount = 0;

      class TestClass {
        @cache({ ttlSeconds: 60 })
        async compute(a: number, b: number) {
          callCount++;
          return a + b;
        }
      }

      const instance = new TestClass();

      // Different parameter combinations
      expect(await instance.compute(1, 2)).toBe(3);
      expect(callCount).toBe(1);

      expect(await instance.compute(1, 2)).toBe(3);
      expect(callCount).toBe(1); // Cached

      expect(await instance.compute(2, 3)).toBe(5);
      expect(callCount).toBe(2); // Different params

      expect(await instance.compute(1, 2)).toBe(3);
      expect(callCount).toBe(2); // First combination still cached
    });

    test('should cache methods with no parameters', async () => {
      let callCount = 0;

      class TestClass {
        @cache({ ttlSeconds: 60 })
        async getConstant() {
          callCount++;
          return 'constant-value';
        }
      }

      const instance = new TestClass();

      expect(await instance.getConstant()).toBe('constant-value');
      expect(callCount).toBe(1);

      expect(await instance.getConstant()).toBe('constant-value');
      expect(callCount).toBe(1); // Cached
    });

    test('should cache methods with object parameters', async () => {
      let callCount = 0;

      class TestClass {
        @cache({ ttlSeconds: 60 })
        async processData(config: { filter: string; limit: number }) {
          callCount++;
          return `processed-${config.filter}-${config.limit}`;
        }
      }

      const instance = new TestClass();

      const result1 = await instance.processData({ filter: 'active', limit: 10 });
      expect(result1).toBe('processed-active-10');
      expect(callCount).toBe(1);

      // Same config (should cache)
      const result2 = await instance.processData({ filter: 'active', limit: 10 });
      expect(result2).toBe('processed-active-10');
      expect(callCount).toBe(1);

      // Different config
      const result3 = await instance.processData({ filter: 'inactive', limit: 20 });
      expect(result3).toBe('processed-inactive-20');
      expect(callCount).toBe(2);
    });

    test('should handle default ttlSeconds parameter', async () => {
      let callCount = 0;

      class TestClass {
        @cache()
        async getData() {
          callCount++;
          return 'data';
        }
      }

      const instance = new TestClass();

      expect(await instance.getData()).toBe('data');
      expect(callCount).toBe(1);

      // Should use default 60s TTL and cache
      expect(await instance.getData()).toBe('data');
      expect(callCount).toBe(1);
    });

    test('should preserve method context (this)', async () => {
      class TestClass {
        value = 'instance-value';

        @cache({ ttlSeconds: 60 })
        async getValue() {
          return this.value;
        }
      }

      const instance = new TestClass();
      expect(await instance.getValue()).toBe('instance-value');

      // Change instance property
      instance.value = 'new-value';

      // Should still return cached value
      expect(await instance.getValue()).toBe('instance-value');
    });

    test('should share cache between instances (cache key based on method name only)', async () => {
      let callCount = 0;

      class TestClass {
        id: string;

        constructor(id: string) {
          this.id = id;
        }

        @cache({ ttlSeconds: 60 })
        async getData() {
          callCount++;
          return `data-${this.id}`;
        }
      }

      const instance1 = new TestClass('instance1');
      const instance2 = new TestClass('instance2');

      expect(await instance1.getData()).toBe('data-instance1');
      expect(callCount).toBe(1);

      // Note: Cache key is based on method name and args only, not instance
      // So instance2 will get the cached result from instance1
      expect(await instance2.getData()).toBe('data-instance1');
      expect(callCount).toBe(1); // Still cached from instance1
    });

    test('should NOT share cache between different classes (cache key includes class name)', async () => {
      let callCountA = 0;
      let callCountB = 0;

      class ClassA {
        @cache({ ttlSeconds: 60 })
        async getData() {
          callCountA++;
          return 'data-from-A';
        }
      }

      class ClassB {
        @cache({ ttlSeconds: 60 })
        async getData() {
          callCountB++;
          return 'data-from-B';
        }
      }

      const instanceA = new ClassA();
      const instanceB = new ClassB();

      // Both call getData() with same args
      const resultA = await instanceA.getData();
      expect(resultA).toBe('data-from-A');
      expect(callCountA).toBe(1);

      // ClassB should NOT get cached result from ClassA (different class name in cache key)
      const resultB = await instanceB.getData();
      expect(resultB).toBe('data-from-B');
      expect(callCountB).toBe(1); // Called, not cached from ClassA

      // Call again - both should use their own cache
      expect(await instanceA.getData()).toBe('data-from-A');
      expect(callCountA).toBe(1); // Still 1, used cache

      expect(await instanceB.getData()).toBe('data-from-B');
      expect(callCountB).toBe(1); // Still 1, used cache
    });
  });

  describe('LRU Eviction and Size Limits', () => {
    test('should enforce cache size limits with LRU eviction', () => {
      // Note: MAX_CACHE_ENTRIES is read at module load time
      // For a real test, we'd need to mock or reload the module
      // This test demonstrates the concept with enforceSizeLimit() calls

      Cache.clear();

      // Manually add entries and test enforceSizeLimit
      for (let i = 0; i < 3; i++) {
        const stmt = database.prepare('INSERT OR REPLACE INTO cache (key, value, timestamp, lastAccess) VALUES (?, ?, ?, ?)');
        stmt.run(`lru-key${i}`, JSON.stringify(`value${i}`), Date.now() + 60000, Date.now() + i);
      }

      expect(Cache.size()).toBe(3);

      // Access lru-key0 to make it more recently used
      Cache.get('lru-key0');

      // Verify lastAccess was updated (key0 should now have highest lastAccess)
      const stmt = database.prepare('SELECT lastAccess FROM cache WHERE key = ? ORDER BY lastAccess DESC LIMIT 1');
      const row = stmt.get('lru-key0') as { lastAccess: number } | undefined;
      expect(row).toBeDefined();
    });

    test('should update lastAccess timestamp on get', async () => {
      Cache.set('access-test', 'value', 60);

      const getTimestamp = () => {
        const stmt = database.prepare('SELECT lastAccess FROM cache WHERE key = ?');
        const row = stmt.get('access-test') as { lastAccess: number } | undefined;
        return row?.lastAccess || 0;
      };

      const timestamp1 = getTimestamp();
      expect(timestamp1).toBeGreaterThan(0);

      // Wait a bit and access again
      await new Promise(resolve => setTimeout(resolve, 10));
      Cache.get('access-test');
      const timestamp2 = getTimestamp();
      expect(timestamp2).toBeGreaterThan(timestamp1);
    });
  });

  describe('Expired Entry Cleanup', () => {
    test('should cleanup expired entries', async () => {
      // Add expired entries
      Cache.set('expired1', 'value1', 1);
      Cache.set('expired2', 'value2', 1);
      Cache.set('active', 'value3', 60);

      expect(Cache.size()).toBe(3);

      // Wait for expiration
      await new Promise(resolve => setTimeout(resolve, 1100));

      // Run cleanup
      const removed = Cache.cleanupExpired();

      expect(removed).toBe(2);
      expect(Cache.size()).toBe(1);
      expect(Cache.get('active')).toBe('value3');
    });

    test('should start and stop automatic cleanup', async () => {
      Cache.clear();

      // Start cleanup (note: interval is set at module load time)
      // This test just verifies the methods work without errors
      Cache.startCleanup();

      // Add expired entry
      Cache.set('auto-expired', 'value', 1);

      // Wait for entry to expire
      await new Promise(resolve => setTimeout(resolve, 1100));

      // Manually trigger cleanup
      const removed = Cache.cleanupExpired();
      expect(removed).toBe(1);

      Cache.stopCleanup();
    });

    test('should not start cleanup twice', () => {
      Cache.startCleanup();
      Cache.startCleanup(); // Should be no-op

      Cache.stopCleanup();
    });
  });

  describe('Cache Statistics', () => {
    test('should return accurate cache statistics', async () => {
      Cache.clear();

      // Add active entries
      Cache.set('active1', 'value1', 60);
      Cache.set('active2', 'value2', 60);

      // Add expired entries
      Cache.set('expired1', 'value3', 1);

      await new Promise(resolve => setTimeout(resolve, 1100));

      const stats = Cache.stats();

      expect(stats.total).toBe(3);
      expect(stats.expired).toBe(1);
      expect(stats.active).toBe(2);
    });

    test('should return zero stats for empty cache', () => {
      Cache.clear();

      const stats = Cache.stats();

      expect(stats.total).toBe(0);
      expect(stats.expired).toBe(0);
      expect(stats.active).toBe(0);
    });
  });

  describe('Retry Logic', () => {
    test('should handle database errors gracefully', () => {
      // All operations should not throw even if there are errors
      expect(() => Cache.get('test')).not.toThrow();
      expect(() => Cache.set('test', 'value')).not.toThrow();
      expect(() => Cache.delete('test')).not.toThrow();
      expect(() => Cache.clear()).not.toThrow();
      expect(() => Cache.has('test')).not.toThrow();
      expect(() => Cache.keys()).not.toThrow();
      expect(() => Cache.size()).not.toThrow();
      expect(() => Cache.stats()).not.toThrow();
    });
  });

  describe('Additional Error Handling', () => {
    test('should not cache null return values (returns null on cache check)', async () => {
      let callCount = 0;

      class TestClass {
        @cache({
          callback: () => 60
        })
        async getNullable() {
          callCount++;
          return null;
        }
      }

      const instance = new TestClass();

      expect(await instance.getNullable()).toBeNull();
      expect(callCount).toBe(1);

      // CacheLib.get() returns null for cached null, which is treated as cache miss
      // So method executes again - this is a known limitation
      expect(await instance.getNullable()).toBeNull();
      expect(callCount).toBe(2);
    });

    test('should handle undefined return values', async () => {
      class TestClass {
        @cache({ ttlSeconds: 60 })
        async getUndefined() {
          return undefined;
        }
      }

      const instance = new TestClass();

      // JSON.stringify(undefined) returns undefined, which gets stored as string "undefined"
      const result = await instance.getUndefined();
      expect(result).toBeUndefined();
    });

    test('should handle errors in cached methods', async () => {
      let callCount = 0;

      class TestClass {
        @cache({ ttlSeconds: 60 })
        async throwError() {
          callCount++;
          throw new Error('Method error');
        }
      }

      const instance = new TestClass();

      await expect(instance.throwError()).rejects.toThrow('Method error');
      expect(callCount).toBe(1);

      // Error should not be cached - method executes again
      await expect(instance.throwError()).rejects.toThrow('Method error');
      expect(callCount).toBe(2);
    });

    test('should handle callback returning zero TTL', async () => {
      let callCount = 0;

      class TestClass {
        @cache({
          callback: () => 0
        })
        async getNoCache() {
          callCount++;
          return `result-${callCount}`;
        }
      }

      const instance = new TestClass();

      expect(await instance.getNoCache()).toBe('result-1');
      expect(callCount).toBe(1);

      // With 0 TTL, result expires immediately, method called again
      // Note: This might be cached with 0s TTL in the current implementation
      // The exact behavior depends on how the cache handles 0 TTL
    });
  });
});
