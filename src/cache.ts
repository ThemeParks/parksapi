import {DatabaseSync} from 'node:sqlite';

const CACHE_DB_PATH = process.env.CACHE_DB_PATH || './cache.sqlite';

export const database = new DatabaseSync(CACHE_DB_PATH);

// Build cache table if it doesn't exist
database.exec(`
  CREATE TABLE IF NOT EXISTS cache(
    key TEXT PRIMARY KEY,
    value TEXT,
    timestamp INTEGER
  ) STRICT
`);

class CacheLib {
  static get(key: string): any | null {
    const stmt = database.prepare('SELECT value, timestamp FROM cache WHERE key = ?');
    const row = stmt.get(key) as {value: string, timestamp: number} | undefined;
    try {
      if (row) {
        const isExpired = Date.now() > row.timestamp;
        if (isExpired) {
          this.delete(key);
          return null;
        }
        return JSON.parse(row.value);
      }
      return null;
    } catch (error) {
      console.error("Error parsing cache value:", error);
      return null;
    }
  }

  static set<T>(key: string, value: T, ttlSeconds: number = 60): void {
    const timestamp = Date.now() + (ttlSeconds * 1000);
    const stmt = database.prepare('INSERT OR REPLACE INTO cache (key, value, timestamp) VALUES (?, ?, ?)');
    stmt.run(key, JSON.stringify(value), timestamp);
  }

  static delete(key: string): void {
    const stmt = database.prepare('DELETE FROM cache WHERE key = ?');
    stmt.run(key);
  }

  static clear(): void {
    const stmt = database.prepare('DELETE FROM cache');
    stmt.run();
  }

  static has(key: string): boolean {
    const stmt = database.prepare('SELECT 1 FROM cache WHERE key = ?');
    const row = stmt.get(key);
    return !!row;
  }

  static keys(): string[] {
    const stmt = database.prepare('SELECT key FROM cache');
    const rows = stmt.all() as {key: string}[];
    return rows.map(row => row.key);
  }

  static size(): number {
    const stmt = database.prepare('SELECT COUNT(*) as count FROM cache');
    const row = stmt.get() as {count: number};
    return row.count;
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

export default function cacheDecorator({ttlSeconds = 60, callback}: {ttlSeconds?: number, callback?: (response: any) => number} = {}) {
  return function (target: any, propertyKey: string, descriptor: PropertyDescriptor) {
    const originalMethod = descriptor.value;
    descriptor.value = async function (...args: any[]) {
      const cacheKey = `${propertyKey}:${JSON.stringify(args)}`;

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
