import { describe, test, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { Cache, database } from '../cache';

// Mock console.error to avoid noise in test output
const originalConsoleError = console.error;
beforeEach(() => {
  console.error = jest.fn();
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
    test('should execute function and cache result on first call', () => {
      const mockFn = jest.fn(() => 'computed-value');
      
      const result = Cache.wrap('wrap-key', mockFn, 60);
      
      expect(result).toBe('computed-value');
      expect(mockFn).toHaveBeenCalledTimes(1);
      expect(Cache.get('wrap-key')).toBe('computed-value');
    });

    test('should return cached value on subsequent calls', () => {
      const mockFn = jest.fn(() => 'computed-value');
      
      // First call
      const result1 = Cache.wrap('wrap-key', mockFn, 60);
      expect(result1).toBe('computed-value');
      expect(mockFn).toHaveBeenCalledTimes(1);
      
      // Second call
      const result2 = Cache.wrap('wrap-key', mockFn, 60);
      expect(result2).toBe('computed-value');
      expect(mockFn).toHaveBeenCalledTimes(1); // Should not be called again
    });

    test('should re-execute function after cache expires', async () => {
      const mockFn = jest.fn()
        .mockReturnValueOnce('first-value')
        .mockReturnValueOnce('second-value');
      
      // First call with short TTL
      const result1 = Cache.wrap('wrap-key', mockFn, 1);
      expect(result1).toBe('first-value');
      expect(mockFn).toHaveBeenCalledTimes(1);
      
      // Wait for expiration
      await new Promise(resolve => setTimeout(resolve, 1100));
      
      // Second call after expiration
      const result2 = Cache.wrap('wrap-key', mockFn, 1);
      expect(result2).toBe('second-value');
      expect(mockFn).toHaveBeenCalledTimes(2);
    });

    test('should handle complex return types in wrap', () => {
      const complexObject = {
        data: [1, 2, 3],
        nested: { value: 'test' },
        timestamp: Date.now()
      };
      
      const mockFn = jest.fn(() => complexObject);
      
      const result = Cache.wrap('complex-wrap', mockFn, 60);
      expect(result).toEqual(complexObject);
      
      // Subsequent call should return cached value
      const result2 = Cache.wrap('complex-wrap', mockFn, 60);
      expect(result2).toEqual(complexObject);
      expect(mockFn).toHaveBeenCalledTimes(1);
    });
  });

  describe('Error Handling', () => {
    test('should handle JSON parse errors gracefully', () => {
      // Manually insert invalid JSON into database
      const stmt = database.prepare('INSERT OR REPLACE INTO cache (key, value, timestamp) VALUES (?, ?, ?)');
      stmt.run('invalid-json-key', 'invalid-json{', Date.now() + 60000);
      
      const result = Cache.get('invalid-json-key');
      expect(result).toBeNull();
      expect(console.error).toHaveBeenCalledWith('Error parsing cache value:', expect.any(Error));
    });

    test('should not throw errors for non-existent key operations', () => {
      expect(() => Cache.delete('non-existent')).not.toThrow();
      expect(() => Cache.has('non-existent')).not.toThrow();
      expect(() => Cache.get('non-existent')).not.toThrow();
    });

    test('should handle edge cases in wrap function', () => {
      // Test with function that returns null
      const nullFn = jest.fn(() => null);
      const result1 = Cache.wrap('null-key', nullFn, 60);
      expect(result1).toBeNull();
      
      // Test with function that returns empty string
      const emptyStringFn = jest.fn(() => '');
      const result2 = Cache.wrap('empty-string-key', emptyStringFn, 60);
      expect(result2).toBe('');
      
      // Test with function that throws
      const throwingFn = jest.fn(() => {
        throw new Error('Test error');
      });
      expect(() => Cache.wrap('error-key', throwingFn, 60)).toThrow('Test error');
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
});
