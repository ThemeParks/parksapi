import {DatabaseSync} from 'node:sqlite';

const CACHE_DB_PATH = process.env.CACHE_DB_PATH || './cache.sqlite';
const MAX_CACHE_ENTRIES = parseInt(process.env.CACHE_MAX_ENTRIES || '50000', 10);
const CLEANUP_INTERVAL_MS = parseInt(process.env.CACHE_CLEANUP_INTERVAL_MS || '300000', 10); // 5 minutes
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 100;

// Track if we're in temporary mode
let isTemporaryMode = false;

// Initialize database (can be re-initialized)
let database = new DatabaseSync(CACHE_DB_PATH);

export {database};

/**
 * Initialize database schema
 */
function initializeDatabase(db: DatabaseSync, skipMigration: boolean = false): void {
  // Build cache table if it doesn't exist
  db.exec(`
    CREATE TABLE IF NOT EXISTS cache(
      key TEXT PRIMARY KEY,
      value TEXT,
      timestamp INTEGER,
      lastAccess INTEGER
    ) STRICT
  `);

  // Migration: Add lastAccess column if it doesn't exist (for existing databases)
  // Skip migration for in-memory databases
  if (!skipMigration) {
    try {
      const tableInfo = db.prepare("PRAGMA table_info(cache)").all() as {name: string}[];
      const hasLastAccess = tableInfo.some(col => col.name === 'lastAccess');

      if (!hasLastAccess) {
        console.log('Migrating cache database: adding lastAccess column');
        db.exec('ALTER TABLE cache ADD COLUMN lastAccess INTEGER DEFAULT 0');
      }
    } catch (error) {
      // If migration fails, might be an old database - recreate it
      console.warn('Cache migration failed, recreating database:', error);
      db.exec('DROP TABLE IF EXISTS cache');
      db.exec(`
        CREATE TABLE cache(
          key TEXT PRIMARY KEY,
          value TEXT,
          timestamp INTEGER,
          lastAccess INTEGER
        ) STRICT
      `);
    }
  }

  // Add index on lastAccess for efficient LRU queries
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_cache_lastAccess ON cache(lastAccess)
  `);

  // Add index on timestamp for efficient cleanup
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_cache_timestamp ON cache(timestamp)
  `);
}

// Initialize the default database
initializeDatabase(database);

// Cleanup interval reference
let cleanupIntervalId: ReturnType<typeof setInterval> | null = null;

/**
 * Retry a database operation with exponential backoff (synchronous)
 */
function retryOperation<T>(operation: () => T, retries = MAX_RETRIES): T {
  let lastError: any;
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      return operation();
    } catch (error) {
      lastError = error;
      if (attempt < retries - 1) {
        // Simple delay for sync operations (not ideal but works)
        const delay = RETRY_DELAY_MS * Math.pow(2, attempt);
        const start = Date.now();
        while (Date.now() - start < delay) {
          // Busy wait (blocking)
        }
      }
    }
  }
  throw lastError;
}

class CacheLib {
  /**
   * Enable temporary mode - use in-memory cache that doesn't persist
   * Must be called before any cache operations
   */
  static enableTemporaryMode(): void {
    if (isTemporaryMode) {
      return; // Already in temporary mode
    }

    console.log('🔄 Cache: Switching to temporary in-memory mode');
    isTemporaryMode = true;

    // Stop cleanup if running
    this.stopCleanup();

    // Create new in-memory database
    database = new DatabaseSync(':memory:');
    initializeDatabase(database, true); // Skip migration for in-memory DB
  }

  /**
   * Check if cache is in temporary mode
   */
  static isTemporary(): boolean {
    return isTemporaryMode;
  }

  static get(key: string): any | null {
    try {
      return retryOperation(() => {
        const stmt = database.prepare('SELECT value, timestamp FROM cache WHERE key = ?');
        const row = stmt.get(key) as {value: string, timestamp: number} | undefined;

        if (row) {
          const isExpired = Date.now() > row.timestamp;
          if (isExpired) {
            this.delete(key);
            return null;
          }

          // Update last access time for LRU
          const updateStmt = database.prepare('UPDATE cache SET lastAccess = ? WHERE key = ?');
          updateStmt.run(Date.now(), key);

          return JSON.parse(row.value);
        }
        return null;
      });
    } catch (error) {
      console.error("Cache get error:", error);
      return null;
    }
  }

  static set<T>(key: string, value: T, ttlSeconds: number = 60): void {
    try {
      retryOperation(() => {
        const timestamp = Date.now() + (ttlSeconds * 1000);
        const now = Date.now();

        const stmt = database.prepare('INSERT OR REPLACE INTO cache (key, value, timestamp, lastAccess) VALUES (?, ?, ?, ?)');
        stmt.run(key, JSON.stringify(value), timestamp, now);

        // Check if we need to evict entries after insert
        this.enforceSizeLimit();
      });
    } catch (error) {
      console.error("Cache set error:", error);
    }
  }

  static delete(key: string): void {
    try {
      retryOperation(() => {
        const stmt = database.prepare('DELETE FROM cache WHERE key = ?');
        stmt.run(key);
      });
    } catch (error) {
      console.error("Cache delete error:", error);
    }
  }

  static clear(): void {
    try {
      retryOperation(() => {
        const stmt = database.prepare('DELETE FROM cache');
        stmt.run();
      });
    } catch (error) {
      console.error("Cache clear error:", error);
    }
  }

  static has(key: string): boolean {
    try {
      return retryOperation(() => {
        const stmt = database.prepare('SELECT 1 FROM cache WHERE key = ? AND timestamp > ?');
        const row = stmt.get(key, Date.now());
        return !!row;
      });
    } catch (error) {
      console.error("Cache has error:", error);
      return false;
    }
  }

  static keys(): string[] {
    try {
      return retryOperation(() => {
        const stmt = database.prepare('SELECT key FROM cache WHERE timestamp > ?');
        const rows = stmt.all(Date.now()) as {key: string}[];
        return rows.map(row => row.key);
      });
    } catch (error) {
      console.error("Cache keys error:", error);
      return [];
    }
  }

  static size(): number {
    try {
      return retryOperation(() => {
        const stmt = database.prepare('SELECT COUNT(*) as count FROM cache');
        const row = stmt.get() as {count: number};
        return row.count;
      });
    } catch (error) {
      console.error("Cache size error:", error);
      return 0;
    }
  }

  /**
   * Get all cache entries with metadata
   */
  static getAllEntries(): Array<{
    key: string;
    value: any;
    expiresAt: number;
    lastAccess: number;
    size: number;
    isExpired: boolean;
  }> {
    try {
      return retryOperation(() => {
        const stmt = database.prepare('SELECT key, value, timestamp, lastAccess FROM cache');
        const rows = stmt.all() as Array<{key: string, value: string, timestamp: number, lastAccess: number}>;
        const now = Date.now();

        return rows.map(row => ({
          key: row.key,
          value: JSON.parse(row.value),
          expiresAt: row.timestamp,
          lastAccess: row.lastAccess,
          size: row.value.length,
          isExpired: now > row.timestamp,
        }));
      });
    } catch (error) {
      console.error("Cache getAllEntries error:", error);
      return [];
    }
  }

  /**
   * Enforce cache size limit by removing least recently accessed entries
   */
  static enforceSizeLimit(): void {
    try {
      const currentSize = this.size();
      if (currentSize > MAX_CACHE_ENTRIES) {
        const entriesToRemove = currentSize - MAX_CACHE_ENTRIES;
        const stmt = database.prepare(`
          DELETE FROM cache WHERE key IN (
            SELECT key FROM cache ORDER BY lastAccess ASC LIMIT ?
          )
        `);
        stmt.run(entriesToRemove);
      }
    } catch (error) {
      console.error("Cache size enforcement error:", error);
    }
  }

  /**
   * Remove all expired entries from cache
   */
  static cleanupExpired(): number {
    try {
      return retryOperation(() => {
        const stmt = database.prepare('DELETE FROM cache WHERE timestamp <= ?');
        const result = stmt.run(Date.now());
        return Number(result.changes || 0);
      });
    } catch (error) {
      console.error("Cache cleanup error:", error);
      return 0;
    }
  }

  /**
   * Start automatic cleanup of expired entries
   */
  static startCleanup(): void {
    if (cleanupIntervalId) {
      return; // Already running
    }
    cleanupIntervalId = setInterval(() => {
      const removed = this.cleanupExpired();
      if (removed > 0) {
        console.log(`Cache cleanup: removed ${removed} expired entries`);
      }
    }, CLEANUP_INTERVAL_MS);

    // Don't block Node.js from exiting
    cleanupIntervalId.unref();
  }

  /**
   * Stop automatic cleanup
   */
  static stopCleanup(): void {
    if (cleanupIntervalId) {
      clearInterval(cleanupIntervalId);
      cleanupIntervalId = null;
    }
  }

  /**
   * Get cache statistics
   */
  static stats(): {total: number, expired: number, active: number} {
    try {
      return retryOperation(() => {
        const totalStmt = database.prepare('SELECT COUNT(*) as count FROM cache');
        const expiredStmt = database.prepare('SELECT COUNT(*) as count FROM cache WHERE timestamp <= ?');

        const total = (totalStmt.get() as {count: number}).count;
        const expired = (expiredStmt.get(Date.now()) as {count: number}).count;

        return {
          total,
          expired,
          active: total - expired
        };
      });
    } catch (error) {
      console.error("Cache stats error:", error);
      return {total: 0, expired: 0, active: 0};
    }
  }

  static async wrap<T>(key: string, fn: () => T, ttlSeconds: number): Promise<T> {
    if (this.has(key)) {
      const cachedValue = this.get(key);
      if (cachedValue !== null) {
        return cachedValue as T;
      }
    }
    const result = await fn();
    this.set(key, result, ttlSeconds);
    return result;
  }
}

export default function cacheDecorator({ttlSeconds = 60, callback, key}: {ttlSeconds?: number, callback?: (response: any) => number, key?: string | ((this: any, args: any[]) => string | Promise<string>)} = {}) {
  return function (target: any, propertyKey: string, descriptor: PropertyDescriptor) {
    const originalMethod = descriptor.value;
    descriptor.value = async function (...args: any[]) {
      // Include class name in cache key to prevent collisions between different classes
      const className = this.constructor.name;
      let cacheKey: string;

      if (key) {
        if (typeof key === 'string') {
          cacheKey = key;
        } else {
          cacheKey = await key.call(this, args);
        }
      } else {
        cacheKey = `${className}:${propertyKey}:${JSON.stringify(args)}`;
      }

      // If callback is provided, we need to call the function and let the callback determine TTL
      if (callback) {
        if (CacheLib.has(cacheKey)) {
          const cachedValue = CacheLib.get(cacheKey);
          if (cachedValue !== null) {
            return cachedValue;
          }
        }
        const result = await originalMethod.apply(this, args);
        const dynamicTtl = await callback(result);
        CacheLib.set(cacheKey, result, dynamicTtl);
        return result;
      }

      // Otherwise use the standard wrap with fixed TTL
      return await CacheLib.wrap(cacheKey, () => originalMethod.apply(this, args), ttlSeconds);
    };
  };
}


export {CacheLib, cacheDecorator as cache};
