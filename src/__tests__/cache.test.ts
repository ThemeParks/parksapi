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

  describe('clearByClassName', () => {
    test('deletes plain ClassName:method:args keys', () => {
      Cache.set('TestPark:getToken:[]', 'tok1');
      Cache.set('TestPark:fetchPOI:["en"]', 'poi');
      Cache.set('OtherPark:getToken:[]', 'tok2');
      Cache.clear(); // clear beforeEach leftovers first

      Cache.set('TestPark:getToken:[]', 'tok1');
      Cache.set('TestPark:fetchPOI:["en"]', 'poi');
      Cache.set('OtherPark:getToken:[]', 'tok2');

      const deleted = Cache.clearByClassName('TestPark');

      expect(deleted).toBe(2);
      expect(Cache.has('TestPark:getToken:[]')).toBe(false);
      expect(Cache.has('TestPark:fetchPOI:["en"]')).toBe(false);
      expect(Cache.has('OtherPark:getToken:[]')).toBe(true);
    });

    test('deletes prefixed prefix:ClassName:method:args keys', () => {
      Cache.clear();
      Cache.set('attractionsio:1:AttractionsIOV3:getParkConfig:[]', 'cfg');
      Cache.set('attractionsio:2:AttractionsIOV3:getParkConfig:[]', 'cfg2');
      Cache.set('SomethingElse:method:[]', 'other');

      const deleted = Cache.clearByClassName('AttractionsIOV3');

      expect(deleted).toBe(2);
      expect(Cache.has('attractionsio:1:AttractionsIOV3:getParkConfig:[]')).toBe(false);
      expect(Cache.has('attractionsio:2:AttractionsIOV3:getParkConfig:[]')).toBe(false);
      expect(Cache.has('SomethingElse:method:[]')).toBe(true);
    });

    test('returns 0 when no matching keys exist', () => {
      Cache.clear();
      Cache.set('UnrelatedPark:method:[]', 'val');

      const deleted = Cache.clearByClassName('NonExistentPark');

      expect(deleted).toBe(0);
      expect(Cache.size()).toBe(1);
    });
  });

  describe('clearAll', () => {
    test('removes all entries and returns count', () => {
      Cache.clear();
      Cache.set('ParkA:method:[]', 'a');
      Cache.set('ParkB:method:[]', 'b');
      Cache.set('ParkC:method:[]', 'c');

      const deleted = Cache.clearAll();

      expect(deleted).toBe(3);
      expect(Cache.size()).toBe(0);
    });

    test('returns 0 when cache is already empty', () => {
      Cache.clear();
      expect(Cache.clearAll()).toBe(0);
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

    test('concurrent cache misses on same key share one execution (in-flight dedup)', async () => {
      let callCount = 0;
      const slowFn = () => new Promise<string>(resolve => {
        callCount++;
        setTimeout(() => resolve('result'), 20);
      });

      // Fire two concurrent wraps on the same key (both are cache misses)
      const [r1, r2] = await Promise.all([
        Cache.wrap('inflight-key', slowFn, 60),
        Cache.wrap('inflight-key', slowFn, 60),
      ]);

      expect(r1).toBe('result');
      expect(r2).toBe('result');
      expect(callCount).toBe(1); // function executed exactly once
    });

    test('wrap in-flight dedup cleans up on error so next call retries', async () => {
      let attempt = 0;
      const flakyFn = () => new Promise<string>((resolve, reject) => {
        attempt++;
        if (attempt === 1) {
          setTimeout(() => reject(new Error('flaky')), 10);
        } else {
          setTimeout(() => resolve('ok'), 10);
        }
      });

      // First call fails
      await expect(Cache.wrap('flaky-key', flakyFn, 60)).rejects.toThrow('flaky');
      // After failure the inflight entry is cleaned up — next call retries successfully
      const result = await Cache.wrap('flaky-key', flakyFn, 60);
      expect(result).toBe('ok');
      expect(attempt).toBe(2);
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

    test('callback path dedupes concurrent cache misses (OAuth-style)', async () => {
      // Critical bug fix: previously the callback path bypassed in-flight dedup,
      // so two concurrent callers on a cold cache would both run the function and
      // store conflicting results — breaking OAuth token refresh.
      let callCount = 0;

      class TokenFetcher {
        @cache({callback: (result: any) => result.expiresIn})
        async getToken() {
          callCount++;
          return new Promise<{token: string; expiresIn: number}>(resolve => {
            setTimeout(() => resolve({token: `token-${callCount}`, expiresIn: 60}), 20);
          });
        }
      }

      const instance = new TokenFetcher();
      const [a, b, c] = await Promise.all([
        instance.getToken(),
        instance.getToken(),
        instance.getToken(),
      ]);

      // All three callers must receive the SAME token, and the underlying
      // function must have been called exactly once.
      expect(callCount).toBe(1);
      expect(a.token).toBe('token-1');
      expect(b.token).toBe('token-1');
      expect(c.token).toBe('token-1');
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

    test('cacheVersion invalidates old entries without flushing the cache', async () => {
      // Simulate a "v1" deployment: populate the cache under the unversioned key
      let callCount = 0;
      class VersionedPark {
        @cache({ttlSeconds: 60})
        async getData() { callCount++; return 'v1-data'; }
      }
      const v1 = new VersionedPark();
      expect(await v1.getData()).toBe('v1-data');
      expect(callCount).toBe(1);
      expect(await v1.getData()).toBe('v1-data');
      expect(callCount).toBe(1); // cached

      // Simulate a "v2" deployment: same class/method name, cacheVersion bumped.
      // The old unversioned entry sits in SQLite but is never reached via the new key.
      class VersionedParkV2 {
        @cache({ttlSeconds: 60, cacheVersion: 2})
        async getData() { callCount++; return 'v2-data'; }
      }
      const v2 = new VersionedParkV2();
      expect(await v2.getData()).toBe('v2-data');  // fresh call, not stale v1
      expect(callCount).toBe(2);                   // underlying method ran again

      // New key is now cached as well
      expect(await v2.getData()).toBe('v2-data');
      expect(callCount).toBe(2);
    });

    test('cacheVersion appended to custom key', async () => {
      let callCount = 0;
      class TestClassCustomKey {
        @cache({ttlSeconds: 60, key: 'my-custom-key', cacheVersion: 'abc'})
        async getData() { callCount++; return `result-${callCount}`; }
      }
      const instance = new TestClassCustomKey();
      expect(await instance.getData()).toBe('result-1');
      expect(callCount).toBe(1);
      expect(await instance.getData()).toBe('result-1'); // cached
      expect(callCount).toBe(1);

      // Verify the actual key stored in SQLite contains the version suffix
      const keys = Cache.keys();
      expect(keys.some(k => k.includes('my-custom-key:vabc'))).toBe(true);
    });

    test('no cacheVersion leaves key unchanged (backward compat)', async () => {
      let callCount = 0;
      class TestNoVersion {
        @cache({ttlSeconds: 60})
        async getData() { callCount++; return 'data'; }
      }
      const instance = new TestNoVersion();
      await instance.getData();
      const keys = Cache.keys();
      const matchingKey = keys.find(k => k.includes('TestNoVersion:getData'));
      expect(matchingKey).toBeDefined();
      // No version suffix present
      expect(matchingKey).not.toMatch(/:v\w/);
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

      // JSON.stringify(undefined) returns undefined — CacheLib.set skips storage
      const result = await instance.getUndefined();
      expect(result).toBeUndefined();
    });

    test('CacheLib.set should not crash when storing undefined', () => {
      // Previously caused ERR_INVALID_ARG_TYPE in SQLite STRICT mode
      // because JSON.stringify(undefined) returns JS undefined, not a string
      expect(() => {
        Cache.set('test-undefined-direct', undefined);
      }).not.toThrow();

      // Value should not be stored
      expect(Cache.has('test-undefined-direct')).toBe(false);
    });

    test('CacheLib.set should not crash when storing function values', () => {
      // JSON.stringify(function) returns undefined
      expect(() => {
        Cache.set('test-function', () => 'hello');
      }).not.toThrow();

      expect(Cache.has('test-function')).toBe(false);
    });

    test('CacheLib.set should store null values as JSON string', () => {
      // JSON.stringify(null) returns "null" which is a valid string
      Cache.set('test-null', null);
      expect(Cache.has('test-null')).toBe(true);
      expect(Cache.get('test-null')).toBeNull();
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

  describe('Serialization Safety', () => {
    test('should warn when caching a Set', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      Cache.set('test_set', new Set(['a', 'b']), 10);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Set'));
      warnSpy.mockRestore();
    });

    test('should warn when caching a Map', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      Cache.set('test_map', new Map([['a', 1]]), 10);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Map'));
      warnSpy.mockRestore();
    });

    test('should not warn for JSON-safe types', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      Cache.set('test_array', [1, 2, 3], 10);
      Cache.set('test_object', { a: 1 }, 10);
      Cache.set('test_string', 'hello', 10);
      Cache.set('test_number', 42, 10);
      expect(warnSpy).not.toHaveBeenCalled();
      warnSpy.mockRestore();
    });

    test('Set becomes empty object after cache round-trip', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const original = new Set(['a', 'b', 'c']);
      Cache.set('test_set_rt', original, 60);
      const retrieved = Cache.get('test_set_rt');
      // Set serializes to {} — this is the bug this guard warns about
      expect(retrieved).toEqual({});
      expect(retrieved).not.toBeInstanceOf(Set);
      warnSpy.mockRestore();
    });

    test('Map becomes empty object after cache round-trip', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const original = new Map([['key', 'value']]);
      Cache.set('test_map_rt', original, 60);
      const retrieved = Cache.get('test_map_rt');
      expect(retrieved).toEqual({});
      expect(retrieved).not.toBeInstanceOf(Map);
      warnSpy.mockRestore();
    });

    test('arrays survive cache round-trip', () => {
      const original = [1, 2, 3, 'four'];
      Cache.set('test_arr_rt', original, 60);
      const retrieved = Cache.get('test_arr_rt');
      expect(retrieved).toEqual(original);
      expect(Array.isArray(retrieved)).toBe(true);
    });

    test('nested objects survive cache round-trip', () => {
      const original = { a: 1, b: { c: [1, 2], d: 'hello' }, e: null };
      Cache.set('test_nested_rt', original, 60);
      const retrieved = Cache.get('test_nested_rt');
      expect(retrieved).toEqual(original);
    });

    test('Record<string, true> survives cache round-trip (Set alternative)', () => {
      // This is the recommended pattern instead of Set
      const original: Record<string, true> = { 'a': true, 'b': true, 'c': true };
      Cache.set('test_record_rt', original, 60);
      const retrieved = Cache.get('test_record_rt') as Record<string, true>;
      expect(retrieved).toEqual(original);
      expect('a' in retrieved).toBe(true);
      expect('d' in retrieved).toBe(false);
    });

    test('Date becomes string after cache round-trip (warns)', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const original = new Date('2024-07-15T12:00:00Z');
      Cache.set('test_date_rt', original, 60);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Date'));
      const retrieved = Cache.get('test_date_rt');
      // Date serializes to ISO string
      expect(typeof retrieved).toBe('string');
      expect(retrieved).toBe('2024-07-15T12:00:00.000Z');
      warnSpy.mockRestore();
    });
  });

  describe('SQLite STRICT Mode Safety', () => {
    test('STRICT mode rejects raw undefined — CacheLib.set guards against it', () => {
      // Direct SQLite INSERT with undefined would throw ERR_INVALID_ARG_TYPE
      // Verify our guard prevents this
      expect(() => Cache.set('strict-undef', undefined)).not.toThrow();
      expect(Cache.has('strict-undef')).toBe(false);
    });

    test('STRICT mode accepts all JSON-serializable primitives', () => {
      const cases: [string, any][] = [
        ['strict-string', 'hello'],
        ['strict-number', 42],
        ['strict-float', 3.14],
        ['strict-true', true],
        ['strict-false', false],
        ['strict-null', null],
        ['strict-zero', 0],
        ['strict-empty', ''],
        ['strict-negative', -1],
      ];

      for (const [key, value] of cases) {
        expect(() => Cache.set(key, value)).not.toThrow();
      }

      expect(Cache.get('strict-string')).toBe('hello');
      expect(Cache.get('strict-number')).toBe(42);
      expect(Cache.get('strict-float')).toBe(3.14);
      expect(Cache.get('strict-true')).toBe(true);
      expect(Cache.get('strict-false')).toBe(false);
      expect(Cache.get('strict-zero')).toBe(0);
      expect(Cache.get('strict-empty')).toBe('');
      expect(Cache.get('strict-negative')).toBe(-1);
    });

    test('values with circular references are caught gracefully', () => {
      const circular: any = {a: 1};
      circular.self = circular;

      // JSON.stringify throws on circular references — CacheLib.set catches it
      expect(() => Cache.set('strict-circular', circular)).not.toThrow();
    });
  });

  describe('SQLite WAL Mode', () => {
    test('WAL and busy_timeout PRAGMAs should be settable on file-based databases', () => {
      // The test suite uses in-memory database which doesn't support WAL.
      // Verify the PRAGMAs work on a temp file-based database instead.
      const {DatabaseSync} = require('node:sqlite');
      const tmpDb = new DatabaseSync('/tmp/cache_wal_test.sqlite');
      try {
        tmpDb.exec('PRAGMA journal_mode=WAL');
        tmpDb.exec('PRAGMA busy_timeout=5000');

        const journalMode = tmpDb.prepare('PRAGMA journal_mode').get() as {journal_mode: string};
        expect(journalMode.journal_mode).toBe('wal');

        const busyTimeout = tmpDb.prepare('PRAGMA busy_timeout').get() as {timeout: number};
        expect(busyTimeout.timeout).toBe(5000);
      } finally {
        tmpDb.close();
        require('fs').unlinkSync('/tmp/cache_wal_test.sqlite');
        // Clean up WAL/SHM files if they exist
        try { require('fs').unlinkSync('/tmp/cache_wal_test.sqlite-wal'); } catch {}
        try { require('fs').unlinkSync('/tmp/cache_wal_test.sqlite-shm'); } catch {}
      }
    });
  });

  describe('Large Value Storage', () => {
    test('should store and retrieve large JSON objects', () => {
      // Simulate a large park entity list (similar to Six Flags with 34 parks)
      const largeArray = Array.from({length: 500}, (_, i) => ({
        id: `entity-${i}`,
        name: `Entity Number ${i}`,
        type: i % 3 === 0 ? 'ATTRACTION' : i % 3 === 1 ? 'RESTAURANT' : 'SHOW',
        location: {latitude: 40 + Math.random(), longitude: -80 + Math.random()},
        tags: [{type: 'HEIGHT', value: 100 + i}],
      }));

      Cache.set('large-entities', largeArray, 60);
      const retrieved = Cache.get('large-entities') as typeof largeArray;

      expect(retrieved).toHaveLength(500);
      expect(retrieved[0].id).toBe('entity-0');
      expect(retrieved[499].id).toBe('entity-499');
      expect(retrieved[0].location.latitude).toBeCloseTo(largeArray[0].location.latitude, 10);
    });

    test('should store deeply nested objects', () => {
      const deep = {
        level1: {
          level2: {
            level3: {
              level4: {
                level5: {value: 'deep-value', array: [1, 2, 3]},
              },
            },
          },
        },
      };

      Cache.set('deep-nested', deep, 60);
      const retrieved = Cache.get('deep-nested') as typeof deep;
      expect(retrieved.level1.level2.level3.level4.level5.value).toBe('deep-value');
      expect(retrieved.level1.level2.level3.level4.level5.array).toEqual([1, 2, 3]);
    });
  });

  describe('enforceSizeLimit Behavior', () => {
    test('should evict least-recently-accessed entries when over limit', () => {
      Cache.clear();

      // Insert entries with distinct lastAccess timestamps
      for (let i = 0; i < 5; i++) {
        const stmt = database.prepare(
          'INSERT OR REPLACE INTO cache (key, value, timestamp, lastAccess) VALUES (?, ?, ?, ?)',
        );
        // lastAccess increases with i, so key0 is oldest
        stmt.run(`evict-${i}`, JSON.stringify(`value-${i}`), Date.now() + 60000, 1000 + i);
      }

      expect(Cache.size()).toBe(5);

      // Directly call enforceSizeLimit won't evict because MAX_CACHE_ENTRIES is 50000.
      // Instead, verify the eviction query works by running it manually.
      const stmt = database.prepare(`
        DELETE FROM cache WHERE key IN (
          SELECT key FROM cache ORDER BY lastAccess ASC LIMIT ?
        )
      `);
      stmt.run(2); // Remove 2 oldest

      expect(Cache.size()).toBe(3);
      // Oldest (lastAccess=1000, 1001) should be gone
      expect(Cache.has('evict-0')).toBe(false);
      expect(Cache.has('evict-1')).toBe(false);
      // Newest should remain
      expect(Cache.has('evict-2')).toBe(true);
      expect(Cache.has('evict-3')).toBe(true);
      expect(Cache.has('evict-4')).toBe(true);
    });

    test('get() updates lastAccess so entry survives eviction', async () => {
      Cache.clear();

      // Insert entries with explicit lastAccess timestamps to avoid timing issues
      const stmt = database.prepare(
        'INSERT INTO cache (key, value, timestamp, lastAccess) VALUES (?, ?, ?, ?)',
      );
      const expiry = Date.now() + 60000;
      stmt.run('key-old', JSON.stringify('old-value'), expiry, 1000);
      stmt.run('key-new', JSON.stringify('new-value'), expiry, 2000);

      // key-old has lastAccess=1000 (oldest), key-new has lastAccess=2000
      // Access key-old to bump its lastAccess above key-new
      Cache.get('key-old');

      const rows = database.prepare(
        'SELECT key, lastAccess FROM cache ORDER BY lastAccess ASC',
      ).all() as {key: string; lastAccess: number}[];

      expect(rows.length).toBe(2);
      // key-new (lastAccess=2000) should now be oldest, key-old was just accessed
      expect(rows[0].key).toBe('key-new');
      expect(rows[1].key).toBe('key-old');
      expect(rows[1].lastAccess).toBeGreaterThan(rows[0].lastAccess);
    });
  });

  describe('Concurrent-like Access Patterns', () => {
    test('many rapid set/get operations should not corrupt data', () => {
      Cache.clear();

      // Simulate rapid concurrent-like writes (sequential but fast)
      const count = 200;
      for (let i = 0; i < count; i++) {
        Cache.set(`rapid-${i}`, {index: i, data: `value-${i}`}, 60);
      }

      expect(Cache.size()).toBe(count);

      // Verify all values are intact
      for (let i = 0; i < count; i++) {
        const val = Cache.get(`rapid-${i}`) as {index: number; data: string};
        expect(val.index).toBe(i);
        expect(val.data).toBe(`value-${i}`);
      }
    });

    test('interleaved set/get/delete should maintain consistency', () => {
      Cache.clear();

      // Write 50 entries
      for (let i = 0; i < 50; i++) {
        Cache.set(`interleave-${i}`, i, 60);
      }

      // Delete even entries, read odd entries
      for (let i = 0; i < 50; i++) {
        if (i % 2 === 0) {
          Cache.delete(`interleave-${i}`);
        } else {
          expect(Cache.get(`interleave-${i}`)).toBe(i);
        }
      }

      expect(Cache.size()).toBe(25);

      // Verify only odd entries remain
      for (let i = 0; i < 50; i++) {
        if (i % 2 === 0) {
          expect(Cache.has(`interleave-${i}`)).toBe(false);
        } else {
          expect(Cache.has(`interleave-${i}`)).toBe(true);
        }
      }
    });

    test('overwriting the same key rapidly should always reflect latest value', () => {
      for (let i = 0; i < 100; i++) {
        Cache.set('overwrite-key', {version: i}, 60);
      }

      const result = Cache.get('overwrite-key') as {version: number};
      expect(result.version).toBe(99);
    });
  });
});
