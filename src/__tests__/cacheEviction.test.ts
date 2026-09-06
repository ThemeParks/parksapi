/**
 * LRU eviction must honour the persistent-key carve-out.
 *
 * `enforceSizeLimit()` is the fourth way a row can leave the cache, and it
 * does not read TTLs at all. Without an exemption the 400-day life of the
 * retirement record is only as good as the size cap: a destination that stops
 * being polled (disabled, out of season, upstream broken) stops having its row
 * read, ages to the cold end of the LRU, and is evicted despite never having
 * expired — losing exactly the destination whose entities are most likely to
 * have gone missing.
 *
 * Its own file with its own database: MAX_CACHE_ENTRIES is read once at module
 * load, so the cap can only be lowered by importing the module fresh with the
 * env var already set. Vitest isolates the module registry per test file, so
 * this file's lowered cap and throwaway database do not reach any other suite.
 */

import {describe, test, expect, beforeAll, afterAll, vi} from 'vitest';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {rmSync} from 'node:fs';

const DB_PATH = join(tmpdir(), `parksapi-eviction-${process.pid}-${Date.now()}.sqlite`);

let Cache: typeof import('../cache.js').CacheLib;
let db: typeof import('../cache.js').database;

beforeAll(async () => {
  process.env.CACHE_DB_PATH = DB_PATH;
  process.env.CACHE_MAX_ENTRIES = '5';
  vi.resetModules();
  const mod = await import('../cache.js');
  Cache = mod.CacheLib;
  db = mod.database;
});

afterAll(() => {
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      rmSync(`${DB_PATH}${suffix}`);
    } catch {
      // best effort; the temp dir is disposable
    }
  }
});

describe('enforceSizeLimit', () => {
  test('evicts cold cache entries but never the persistent record', () => {
    Cache.clear({includePersistent: true});

    // The retirement record is the COLDEST row in the table, so a pure LRU
    // would evict it first.
    Cache.set('ColdPark:liveEntityRetirement', {show1: {seenAt: 1, misses: 2}}, 400 * 24 * 60 * 60);
    db.prepare('UPDATE cache SET lastAccess = 0 WHERE key = ?').run('ColdPark:liveEntityRetirement');

    for (let i = 0; i < 10; i += 1) {
      Cache.set(`WarmPark:getPOI:[${i}]`, {i}, 3600);
    }

    expect(Cache.size()).toBeGreaterThan(5);
    Cache.enforceSizeLimit();

    expect(Cache.has('ColdPark:liveEntityRetirement')).toBe(true);
    expect(Cache.get('ColdPark:liveEntityRetirement')).toEqual({show1: {seenAt: 1, misses: 2}});
    // Eviction still did its job on the rows it is allowed to take.
    expect(Cache.size()).toBeLessThanOrEqual(6);
  });
});
