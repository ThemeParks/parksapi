import {DatabaseSync} from 'node:sqlite';

const CACHE_DB_PATH = process.env.CACHE_DB_PATH || './cache.sqlite';
const MAX_CACHE_ENTRIES = parseInt(process.env.CACHE_MAX_ENTRIES || '50000', 10);
const CLEANUP_INTERVAL_MS = parseInt(process.env.CACHE_CLEANUP_INTERVAL_MS || '300000', 10); // 5 minutes
// SQLite contention is handled by PRAGMA busy_timeout=5000 (waits up to 5s for
// the lock). No application-level retry needed.

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

  // ── Attractions.io entity store ──────────────────────────────────
  // Normalized per-record storage replacing the old giant JSON blob in the cache table.
  // Each Item/Category/Resort gets its own row, with soft-delete tracking.
  db.exec(`
    CREATE TABLE IF NOT EXISTS attractionsio_entities (
      park_id       TEXT NOT NULL,
      record_type   TEXT NOT NULL,
      entity_id     TEXT NOT NULL,
      data          TEXT NOT NULL,
      last_version  TEXT NOT NULL,
      removed_at    INTEGER,
      updated_at    INTEGER NOT NULL,
      PRIMARY KEY (park_id, record_type, entity_id)
    ) STRICT
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS attractionsio_versions (
      park_id       TEXT PRIMARY KEY,
      version       TEXT NOT NULL,
      updated_at    INTEGER NOT NULL
    ) STRICT
  `);
}

// Initialize the default database
initializeDatabase(database);

// Enable WAL mode and busy timeout for better concurrent access.
// WAL allows readers and writers to operate simultaneously, and
// busy_timeout prevents SQLITE_BUSY errors under contention.
try {
  database.exec('PRAGMA journal_mode=WAL');
  database.exec('PRAGMA busy_timeout=5000');
} catch {
  // Ignore if PRAGMAs fail (e.g. in-memory databases)
}

// Cleanup interval reference
let cleanupIntervalId: ReturnType<typeof setInterval> | null = null;

// Size limit enforcement runs every N inserts rather than every insert.
// At 50k entries (default MAX_CACHE_ENTRIES), the limit is rarely exceeded,
// so a SELECT COUNT(*) on every set() is wasted work.
const SIZE_CHECK_INTERVAL = 100;
let insertsSinceLastSizeCheck = 0;

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
      const stmt = database.prepare('SELECT value, timestamp FROM cache WHERE key = ?');
      const row = stmt.get(key) as {value: string, timestamp: number} | undefined;

      if (row) {
        const isExpired = Date.now() > row.timestamp;
        if (isExpired) {
          this.delete(key);
          return null;
        }

        // Update last access time for LRU — best-effort, don't fail the read
        try {
          const updateStmt = database.prepare('UPDATE cache SET lastAccess = ? WHERE key = ?');
          updateStmt.run(Date.now(), key);
        } catch {
          // LRU tracking is non-critical; stale lastAccess is acceptable
        }

        return JSON.parse(row.value);
      }
      return null;
    } catch (error) {
      console.error("Cache get error:", error);
      return null;
    }
  }

  static set<T>(key: string, value: T, ttlSeconds: number = 60): void {
    // Warn on types that don't survive JSON serialization
    if (value instanceof Set || value instanceof Map) {
      console.warn(
        `[Cache] Warning: Storing ${value.constructor.name} in cache key "${key}". ` +
        `Set/Map objects become plain objects after JSON serialization. ` +
        `Use arrays or Record<string, T> instead.`
      );
    } else if (value instanceof Date) {
      console.warn(
        `[Cache] Warning: Storing Date in cache key "${key}". ` +
        `Date objects become ISO strings after JSON serialization. ` +
        `Store as ISO string directly if that's the intent.`
      );
    }

    // JSON.stringify(undefined) returns undefined (not a string), which SQLite STRICT mode rejects.
    // It also throws on circular references. Skip storage in both cases.
    let serialized: string | undefined;
    try {
      serialized = JSON.stringify(value);
    } catch {
      return;
    }
    if (serialized === undefined) {
      return;
    }

    try {
      const timestamp = Date.now() + (ttlSeconds * 1000);
      const now = Date.now();

      const stmt = database.prepare('INSERT OR REPLACE INTO cache (key, value, timestamp, lastAccess) VALUES (?, ?, ?, ?)');
      stmt.run(key, serialized, timestamp, now);

      // Check if we need to evict entries after insert.
      // Only run the SELECT COUNT(*) periodically (every SIZE_CHECK_INTERVAL inserts)
      // to avoid a full table scan on every write.
      insertsSinceLastSizeCheck++;
      if (insertsSinceLastSizeCheck >= SIZE_CHECK_INTERVAL) {
        insertsSinceLastSizeCheck = 0;
        this.enforceSizeLimit();
      }
    } catch (error) {
      console.error("Cache set error:", error);
    }
  }

  static delete(key: string): void {
    try {
      const stmt = database.prepare('DELETE FROM cache WHERE key = ?');
      stmt.run(key);
    } catch (error) {
      console.error("Cache delete error:", error);
    }
  }

  static clear(): void {
    try {
      const stmt = database.prepare('DELETE FROM cache');
      stmt.run();
    } catch (error) {
      console.error("Cache clear error:", error);
    }
  }

  static has(key: string): boolean {
    try {
      const stmt = database.prepare('SELECT 1 FROM cache WHERE key = ? AND timestamp > ?');
      const row = stmt.get(key, Date.now());
      return !!row;
    } catch (error) {
      console.error("Cache has error:", error);
      return false;
    }
  }

  static keys(): string[] {
    try {
      const stmt = database.prepare('SELECT key FROM cache WHERE timestamp > ?');
      const rows = stmt.all(Date.now()) as {key: string}[];
      return rows.map(row => row.key);
    } catch (error) {
      console.error("Cache keys error:", error);
      return [];
    }
  }

  static size(): number {
    try {
      const stmt = database.prepare('SELECT COUNT(*) as count FROM cache');
      const row = stmt.get() as {count: number};
      return row.count;
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
    } catch (error) {
      console.error("Cache getAllEntries error:", error);
      return [];
    }
  }

  /**
   * Enforce cache size limit by removing least recently accessed entries.
   * Called periodically from set() rather than on every write.
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
      const stmt = database.prepare('DELETE FROM cache WHERE timestamp <= ?');
      const result = stmt.run(Date.now());
      return Number(result.changes || 0);
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
      const totalStmt = database.prepare('SELECT COUNT(*) as count FROM cache');
      const expiredStmt = database.prepare('SELECT COUNT(*) as count FROM cache WHERE timestamp <= ?');

      const total = (totalStmt.get() as {count: number}).count;
      const expired = (expiredStmt.get(Date.now()) as {count: number}).count;

      return {
        total,
        expired,
        active: total - expired
      };
    } catch (error) {
      console.error("Cache stats error:", error);
      return {total: 0, expired: 0, active: 0};
    }
  }

  /**
   * Delete all cache entries whose key contains the given class name.
   * Matches both plain keys (`ClassName:method:args`) and prefixed keys (`prefix:ClassName:method:args`).
   * Returns the number of deleted entries.
   */
  static clearByClassName(className: string): number {
    try {
      const stmt = database.prepare("DELETE FROM cache WHERE key LIKE ? OR key LIKE ?");
      const result = stmt.run(`${className}:%`, `%:${className}:%`);
      return Number(result.changes || 0);
    } catch (error) {
      console.error("Cache clearByClassName error:", error);
      return 0;
    }
  }

  /** Delete every entry in the cache. Returns number deleted. */
  static clearAll(): number {
    try {
      const result = database.prepare("DELETE FROM cache").run();
      return Number(result.changes || 0);
    } catch (error) {
      console.error("Cache clearAll error:", error);
      return 0;
    }
  }

  private static inflight = new Map<string, Promise<any>>();

  /**
   * Cache-with-dedup wrapper. Concurrent callers on a cache miss for the same
   * key share a single execution rather than each running `fn` independently.
   *
   * @param ttl Either a fixed TTL in seconds, or a callback that derives a TTL
   *            from the function's result (e.g. for OAuth tokens that expire
   *            on a server-supplied schedule).
   */
  static async wrap<T>(
    key: string,
    fn: () => T | Promise<T>,
    ttl: number | ((result: T) => number | Promise<number>),
  ): Promise<T> {
    if (this.has(key)) {
      const cachedValue = this.get(key);
      if (cachedValue !== null) {
        return cachedValue as T;
      }
    }

    // In-flight deduplication: concurrent cache misses on the same key share one execution
    if (this.inflight.has(key)) {
      return this.inflight.get(key) as Promise<T>;
    }

    const promise = Promise.resolve(fn()).then(async (result) => {
      const ttlSeconds = typeof ttl === 'function' ? await ttl(result) : ttl;
      this.set(key, result, ttlSeconds);
      this.inflight.delete(key);
      return result;
    }).catch((err) => {
      this.inflight.delete(key);
      throw err;
    });

    this.inflight.set(key, promise);
    return promise;
  }
}

export default function cacheDecorator({ttlSeconds = 60, callback, key, cacheVersion}: {ttlSeconds?: number, callback?: (response: any) => number, key?: string | ((this: any, args: any[]) => string | Promise<string>), cacheVersion?: number | string} = {}) {
  return function (target: any, propertyKey: string, descriptor: PropertyDescriptor) {
    const originalMethod = descriptor.value;
    descriptor.value = async function (this: any, ...args: any[]) {
      // Include class name in cache key to prevent collisions between different classes
      const className = this.constructor.name;

      // Check for cache key prefix (supports both method and property)
      let prefix = '';
      if (typeof this.getCacheKeyPrefix === 'function') {
        const result = this.getCacheKeyPrefix();
        prefix = result instanceof Promise ? await result : result;
      } else if (this.cacheKeyPrefix) {
        prefix = this.cacheKeyPrefix;
      }

      // Version suffix: when cacheVersion changes, old cache entries become unreachable
      // and expire naturally — no manual cache flush needed across machines.
      const versionSuffix = cacheVersion !== undefined ? `:v${cacheVersion}` : '';

      let cacheKey: string;

      if (key) {
        if (typeof key === 'string') {
          cacheKey = prefix ? `${prefix}:${key}${versionSuffix}` : `${key}${versionSuffix}`;
        } else {
          const customKey = await key.call(this, args);
          cacheKey = prefix ? `${prefix}:${customKey}${versionSuffix}` : `${customKey}${versionSuffix}`;
        }
      } else {
        const defaultKey = `${className}:${propertyKey}:${JSON.stringify(args)}${versionSuffix}`;
        cacheKey = prefix ? `${prefix}:${defaultKey}` : defaultKey;
      }

      // Use wrap for both fixed and dynamic TTL — both paths get in-flight
      // deduplication so concurrent cache misses share a single execution.
      // Critical for OAuth token refresh: without dedup, two concurrent
      // callers would both hit the token endpoint and the second's response
      // would overwrite the first in cache.
      return await CacheLib.wrap(
        cacheKey,
        () => originalMethod.apply(this, args),
        callback ?? ttlSeconds,
      );
    };
  };
}


export {CacheLib, cacheDecorator as cache};
